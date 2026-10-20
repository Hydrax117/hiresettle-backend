import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { User, UserRole } from "@prisma/client";
import { StellarService } from "../../common/stellar/stellar.service";
import { ExchangeRateService } from "../../common/exchange-rates/exchange-rate.service";
import { InvoiceTaxService } from "./tax/invoice-tax.service";
import { renderInvoicePdf } from "./tax/invoice-pdf";
import {
  EU_COUNTRIES,
  isPlausibleVatId,
  normalizeCountry,
  normalizeTaxId,
  vatPrefix,
} from "./tax/invoice-tax.calculator";

/** Round a fiat amount to 2 decimal places. */
function roundFiat(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Escape a value for safe inclusion in a CSV cell. */
function csvCell(value: string | number | null | undefined): string {
  const str = value == null ? "" : String(value);
  // Wrap in quotes if the value contains a comma, quote, or newline
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private static readonly usageWindowMs = 24 * 60 * 60 * 1000;
  private static readonly usageCounts = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly exchangeRates: ExchangeRateService,
    private readonly invoiceTax: InvoiceTaxService,
  ) {}

  generateInvoiceNumber(id: string | number) {
    const seed = Number(String(id).replace(/[^0-9]/g, "") || "1");
    return `INV-${String(seed + 1000).padStart(7, "0")}`;
  }

  /**
   * Invoice for a billing period with VAT computed from the company's tax
   * profile (#506): domestic VAT, EU reverse charge or outside-scope, with
   * the matching statutory notice printed on the PDF.
   */
  async generateInvoicePdf(
    companyUser: Pick<User, "id">,
    invoiceId: string | number,
    fromDate?: Date,
    toDate?: Date,
  ): Promise<Buffer> {
    // The JWT user only carries id/email/role, so load the full profile.
    const company = await this.prisma.user.findUnique({
      where: { id: companyUser.id },
    });
    if (!company) throw new NotFoundException("Company not found");

    const billing = await this.getBillingSummary(company, fromDate, toDate);
    const lines = billing.engagementBreakdown.map((item) => ({
      description: `${item.jobTitle} (${item.engagementId})`,
      amount: BigInt(item.totalEscrowed),
    }));
    const tax = this.invoiceTax.compute(
      { country: company.taxCountry, taxId: company.taxId },
      lines,
    );
    const seller = this.invoiceTax.seller();

    return renderInvoicePdf({
      invoiceNumber: this.generateInvoiceNumber(invoiceId),
      issuedAt: new Date(),
      periodFrom: billing.fromDate,
      periodTo: billing.toDate,
      seller: { name: seller.name, country: tax.seller.country, taxId: tax.seller.taxId },
      customer: {
        name: company.company ?? company.name ?? "N/A",
        email: company.email,
        country: tax.customer.country,
        taxId: tax.customer.taxId,
      },
      lines,
      tax,
      unit: "stroops",
    });
  }

  async getTaxProfile(companyId: string) {
    const company = await this.prisma.user.findUnique({
      where: { id: companyId },
      select: { taxCountry: true, taxId: true },
    });
    if (!company) throw new NotFoundException("Company not found");
    return company;
  }

  /**
   * Store the company's country and VAT number (#506). EU VAT numbers must
   * carry the country's prefix so cross-border invoices can apply the
   * reverse charge.
   */
  async updateTaxProfile(
    companyId: string,
    dto: { taxCountry: string; taxId?: string | null },
  ) {
    const taxCountry = normalizeCountry(dto.taxCountry);
    if (!taxCountry) {
      throw new BadRequestException("taxCountry must be an ISO 3166-1 alpha-2 code, e.g. DE");
    }
    const taxId = normalizeTaxId(dto.taxId);
    if (taxId && !isPlausibleVatId(taxId, taxCountry)) {
      throw new BadRequestException(
        EU_COUNTRIES.has(taxCountry)
          ? `taxId must be a ${taxCountry} VAT number starting with "${vatPrefix(taxCountry)}"`
          : "taxId must be 4-20 letters or digits",
      );
    }

    return this.prisma.user.update({
      where: { id: companyId },
      data: { taxCountry, taxId },
      select: { taxCountry: true, taxId: true },
    });
  }

  recordCompanyUsage(companyId: string, count = 1) {
    const now = Date.now();
    const bucket = BillingService.usageCounts.get(companyId) ?? [];
    bucket.push(now, now + count);
    const valid = bucket.filter(
      (ts) => now - ts < BillingService.usageWindowMs,
    );
    BillingService.usageCounts.set(companyId, valid);
    return { companyId, total: valid.length };
  }

  getCompanyUsage(companyId: string, windowMs = BillingService.usageWindowMs) {
    const values = BillingService.usageCounts.get(companyId) ?? [];
    const now = Date.now();
    const total = values.filter((ts) => now - ts < windowMs).length;
    return {
      companyId,
      total,
      windowMs,
      period: new Date(now - windowMs).toISOString(),
    };
  }

  /**
   * Charge a platform fee (minor units). Prepaid credits are applied first
   * (#507); only the uncovered remainder goes to the external payment
   * method. `feeReference` makes the credit deduction idempotent, so a
   * retried charge never consumes credit twice.
   */
  async chargePlatformFee(
    companyId: string,
    amount: number | bigint,
    paymentMethod = "saved_method",
    feeReference = `fee_${Date.now()}`,
  ) {
    const feeAmount = toMinorUnits(amount);
    if (feeAmount <= 0n) {
      return {
        companyId,
        paymentMethod,
        amount: feeAmount.toString(),
        creditApplied: "0",
        amountCharged: "0",
        creditBalance: (await this.credits.getBalance(companyId)).toString(),
        status: "failed" as const,
        chargeId: null,
        retryable: true,
      };
    }

    const credit = await this.credits.applyToFee(companyId, feeAmount, feeReference);
    // Fully covered by credit: nothing is sent to the payment processor.
    const chargeId = credit.amountDue > 0n ? `ch_${Date.now()}` : null;

    return {
      companyId,
      paymentMethod: credit.amountDue > 0n ? paymentMethod : "prepaid_credit",
      amount: feeAmount.toString(),
      creditApplied: credit.creditApplied.toString(),
      amountCharged: credit.amountDue.toString(),
      creditBalance: credit.balanceAfter.toString(),
      status: "succeeded" as const,
      chargeId,
      retryable: false,
    };
  }

  async getBillingSummary(
    companyUser: User,
    fromDate?: Date,
    toDate?: Date,
    fiat?: string,
  ) {
    // Get current calendar month if no dates provided
    const now = new Date();
    const startDate =
      fromDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate =
      toDate ||
      new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Find engagements where the user is the company
    const engagements = await this.prisma.engagement.findMany({
      where: {
        companyAddress: companyUser.stellarAddress,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        milestones: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Calculate aggregates
    let totalEscrowed = BigInt(0);
    let totalReleased = BigInt(0);
    let totalEscrowedFiat: number | null = null;
    let totalReleasedFiat: number | null = null;
    const fiatCurrency = fiat ? fiat.trim().toUpperCase() : null;

    const engagementBreakdown = await Promise.all(
      engagements.map(async (engagement) => {
        const escrowed = engagement.totalAmount;
        const released = engagement.releasedAmount;

        totalEscrowed += escrowed;
        totalReleased += released;

        // Optional fiat-equivalent totals, converted per token.
        const fiatValues = fiatCurrency
          ? await this.toFiatValues(engagement.tokenAddress, escrowed, released, fiatCurrency, engagement.fundingRateUsd)
          : { escrowedFiat: null, releasedFiat: null, tokenSymbol: null };

        if (fiatValues.escrowedFiat != null) {
          totalEscrowedFiat =
            (totalEscrowedFiat ?? 0) + fiatValues.escrowedFiat;
        }
        if (fiatValues.releasedFiat != null) {
          totalReleasedFiat =
            (totalReleasedFiat ?? 0) + fiatValues.releasedFiat;
        }

        return {
          engagementId: engagement.id,
          jobTitle: engagement.jobTitle,
          createdAt: engagement.createdAt,
          totalEscrowed: escrowed.toString(),
          totalReleased: released.toString(),
          status: engagement.status,
          tokenSymbol: fiatValues.tokenSymbol,
          totalEscrowedFiat: fiatValues.escrowedFiat,
          totalReleasedFiat: fiatValues.releasedFiat,
        };
      }),
    );

    return {
      fromDate: startDate,
      toDate: endDate,
      fiat: fiatCurrency,
      summary: {
        totalEscrowed: totalEscrowed.toString(),
        totalReleased: totalReleased.toString(),
        totalEngagements: engagements.length,
        totalEscrowedFiat: totalEscrowedFiat == null ? null : roundFiat(totalEscrowedFiat),
        totalReleasedFiat: totalReleasedFiat == null ? null : roundFiat(totalReleasedFiat),
      },
      engagementBreakdown,
    };
  }

  private async toFiatValues(
    tokenAddress: string,
    escrowed: bigint,
    released: bigint,
    fiat: string,
    fundingRateUsd?: number | null,
  ): Promise<{ escrowedFiat: number | null; releasedFiat: number | null; tokenSymbol: string | null }> {
    try {
      const token = this.stellar.getTokenConfig(tokenAddress);
      // Funded engagements use the USD rate snapshotted at funding time so
      // reports don't drift with the market (#469).
      const rate = fiat === "USD" && fundingRateUsd != null
        ? fundingRateUsd
        : await this.exchangeRates.getRate(token.symbol, fiat);
      if (rate == null) {
        return { escrowedFiat: null, releasedFiat: null, tokenSymbol: token.symbol };
      }

      const escrowedHuman = parseFloat(this.stellar.stroopsToHuman(escrowed, tokenAddress));
      const releasedHuman = parseFloat(this.stellar.stroopsToHuman(released, tokenAddress));
      return {
        escrowedFiat: roundFiat(escrowedHuman * rate),
        releasedFiat: roundFiat(releasedHuman * rate),
        tokenSymbol: token.symbol,
      };
    } catch (error: any) {
      this.logger.warn(
        `Fiat conversion skipped for token ${tokenAddress}: ${error?.message ?? String(error)}`,
      );
      return { escrowedFiat: null, releasedFiat: null, tokenSymbol: null };
    }
  }

  async exportBillingToCsv(
    companyUser: User,
    fromDate?: Date,
    toDate?: Date,
    fiat?: string,
  ) {
    const billingData = await this.getBillingSummary(
      companyUser,
      fromDate,
      toDate,
      fiat,
    );
    const fiatCurrency = billingData.fiat;

    // Build CSV header — fiat columns only when a fiat currency is requested.
    const headers = [
      "Engagement ID",
      "Job Title",
      "Created At",
      "Token",
      "Total Escrowed",
      "Total Released",
      "Status",
      ...(fiatCurrency
        ? [`Total Escrowed (${fiatCurrency})`, `Total Released (${fiatCurrency})`]
        : []),
    ];

    // Build CSV rows
    const rows = billingData.engagementBreakdown.map((item) => [
      item.engagementId,
      `"${item.jobTitle.replace(/"/g, '""')}"`, // Escape quotes
      item.createdAt.toISOString(),
      item.tokenSymbol ?? '',
      item.totalEscrowed,
      item.totalReleased,
      item.status,
      ...(fiatCurrency
        ? [item.totalEscrowedFiat ?? '', item.totalReleasedFiat ?? '']
        : []),
    ]);

    // Add summary row
    const summaryRow = [
      "Summary",
      "",
      "",
      "",
      billingData.summary.totalEscrowed,
      billingData.summary.totalReleased,
      `${billingData.summary.totalEngagements} engagements`,
      ...(fiatCurrency
        ? [billingData.summary.totalEscrowedFiat ?? '', billingData.summary.totalReleasedFiat ?? '']
        : []),
    ];

    // Combine all parts
    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.join(",")),
      "",
      summaryRow.join(","),
    ].join("\n");

    return csvContent;
  }

  /**
   * Export billing history as a CSV.
   *
   * Scoping rules:
   *   - COMPANY: only their own engagements (filtered by stellarAddress)
   *   - ADMIN:   all engagements in the system
   *
   * Columns (acceptance criteria): date, engagement reference, amount, status
   */
  async exportBillingHistory(
    requestingUser: User,
    fromDate?: Date,
    toDate?: Date,
  ): Promise<string> {
    const isAdmin = requestingUser.role === UserRole.ADMIN;

    const now = new Date();
    const startDate =
      fromDate ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate =
      toDate ??
      new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const where: Parameters<
      typeof this.prisma.engagement.findMany
    >[0]["where"] = {
      createdAt: { gte: startDate, lte: endDate },
      // Admins see everything; companies see only their own
      ...(!isAdmin && { companyAddress: requestingUser.stellarAddress }),
    };

    const engagements = await this.prisma.engagement.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    const CSV_HEADER = buildCsvRow([
      "Date",
      "Engagement Reference",
      "Amount (stroops)",
      "Status",
    ]);

    const rows = engagements.map((e) =>
      buildCsvRow([
        e.createdAt.toISOString(),
        e.id,
        e.totalAmount.toString(),
        e.status,
      ]),
    );

    return [CSV_HEADER, ...rows].join("\n");
  }
}

/** Fees are integer minor units; reject fractional or non-finite numbers. */
function toMinorUnits(amount: number | bigint): bigint {
  if (typeof amount === "bigint") return amount;
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new BadRequestException("Fee amount must be an integer number of minor units");
  }
  return BigInt(amount);
}
