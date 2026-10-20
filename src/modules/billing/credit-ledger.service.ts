import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { CreditLedger, CreditLedgerEntryType, Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";

/** Concurrent appends race on (companyId, sequence); retry this many times. */
const MAX_APPEND_ATTEMPTS = 5;

export interface CreditEntryInput {
  type: CreditLedgerEntryType;
  /** Signed minor units: positive adds credit, negative consumes it. */
  amount: bigint;
  description?: string | null;
  reference?: string | null;
  idempotencyKey?: string | null;
  createdById?: string | null;
}

export interface FeeCreditApplication {
  feeAmount: bigint;
  creditApplied: bigint;
  /** What is left for the external payment processor to charge. */
  amountDue: bigint;
  balanceAfter: bigint;
  entry: CreditLedger | null;
}

export interface CreditLedgerPage {
  data: ReturnType<typeof serializeCreditEntry>[];
  page: number;
  limit: number;
  total: number;
}

export function serializeCreditEntry(entry: CreditLedger) {
  return {
    ...entry,
    amount: entry.amount.toString(),
    balanceAfter: entry.balanceAfter.toString(),
  };
}

type Tx = Prisma.TransactionClient;

/**
 * Prepaid credit ledger for companies (#507).
 *
 * The ledger is append-only: the database rejects UPDATE/DELETE on
 * `credit_ledger`, and every change is a new row carrying the signed amount
 * and a snapshot of the running balance. The current balance is the
 * `balanceAfter` of the company's highest `sequence`.
 *
 * Concurrency: each append reads the latest entry and inserts `sequence + 1`.
 * Two writers racing for the same sequence hit the (companyId, sequence)
 * unique index; the loser retries against the new balance, so the balance
 * can never be double-spent or go negative.
 */
@Injectable()
export class CreditLedgerService {
  private readonly logger = new Logger(CreditLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getBalance(companyId: string): Promise<bigint> {
    const latest = await this.latest(this.prisma, companyId);
    return latest?.balanceAfter ?? 0n;
  }

  async listEntries(
    companyId: string,
    page = 1,
    limit = 50,
    type?: CreditLedgerEntryType,
  ): Promise<CreditLedgerPage> {
    const where: Prisma.CreditLedgerWhereInput = {
      companyId,
      ...(type && { type }),
    };
    const [entries, total] = await Promise.all([
      this.prisma.creditLedger.findMany({
        where,
        orderBy: { sequence: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.creditLedger.count({ where }),
    ]);
    return { data: entries.map(serializeCreditEntry), page, limit, total };
  }

  /**
   * Append an entry with a fixed amount. Rejects entries that would take the
   * balance below zero.
   */
  append(companyId: string, input: CreditEntryInput): Promise<CreditLedger> {
    if (input.amount === 0n) {
      throw new BadRequestException("Credit entry amount must not be zero");
    }
    return this.appendComputed(companyId, input.idempotencyKey, (balance) => {
      if (balance + input.amount < 0n) {
        throw new BadRequestException(
          `Insufficient credit: balance ${balance} cannot absorb ${input.amount}`,
        );
      }
      return input;
    });
  }

  /**
   * Consume as much prepaid credit as possible for a platform fee. Whatever
   * the credit does not cover is returned as `amountDue` for the external
   * payment processor. Idempotent per fee reference.
   */
  async applyToFee(
    companyId: string,
    feeAmount: bigint,
    reference: string,
  ): Promise<FeeCreditApplication> {
    if (feeAmount <= 0n) {
      throw new BadRequestException("Fee amount must be positive");
    }

    const entry = await this.appendComputed(companyId, `fee:${reference}`, (balance) => {
      const applied = balance < feeAmount ? balance : feeAmount;
      if (applied <= 0n) return null;
      return {
        type: CreditLedgerEntryType.FEE_DEDUCTION,
        amount: -applied,
        reference,
        description: `Applied to platform fee ${reference}`,
      };
    });

    const creditApplied = entry ? BigInt(-entry.amount) : 0n;
    return {
      feeAmount,
      creditApplied,
      amountDue: feeAmount - creditApplied,
      balanceAfter: entry ? entry.balanceAfter : await this.getBalance(companyId),
      entry,
    };
  }

  /**
   * Core append loop. `compute` receives the current balance and returns the
   * entry to write, or null to write nothing.
   */
  private async appendComputed(
    companyId: string,
    idempotencyKey: string | null | undefined,
    compute: (balance: bigint) => CreditEntryInput | null,
  ): Promise<CreditLedger | null> {
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          if (idempotencyKey) {
            const existing = await tx.creditLedger.findUnique({
              where: { companyId_idempotencyKey: { companyId, idempotencyKey } },
            });
            if (existing) return existing;
          }

          const latest = await this.latest(tx, companyId);
          const balance = latest?.balanceAfter ?? 0n;
          const input = compute(balance);
          if (!input) return null;

          return tx.creditLedger.create({
            data: {
              companyId,
              sequence: (latest?.sequence ?? 0) + 1,
              type: input.type,
              amount: input.amount,
              balanceAfter: balance + input.amount,
              description: input.description ?? null,
              reference: input.reference ?? null,
              idempotencyKey: idempotencyKey ?? null,
              createdById: input.createdById ?? null,
            },
          });
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Either another writer took our sequence (retry) or the same
        // idempotency key was written concurrently (the retry returns it).
        this.logger.debug(
          `Credit ledger append conflict for ${companyId} (attempt ${attempt})`,
        );
      }
    }
    throw new ConflictException(
      "Credit ledger is busy for this company; please retry",
    );
  }

  private latest(client: Tx | PrismaService, companyId: string) {
    return client.creditLedger.findFirst({
      where: { companyId },
      orderBy: { sequence: "desc" },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
