import {
  Injectable, NotFoundException, ConflictException, BadRequestException, Logger, ForbiddenException, Optional,
} from '@nestjs/common';
import { User, EngagementStatus, MilestoneKind, NotificationType, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { CreateEngagementDto } from './dto/create-engagement.dto';
import { EngagementSummaryDto } from './dto/engagement-summary.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from './audit-log.service';
import { EngagementNotesService } from './engagement-notes.service';
import { EngagementImportService } from './engagement-import.service';
import { EngagementCandidateDetailsService } from './engagement-candidate-details.service';
import { cursorPage } from '../../common/pagination/cursor-pagination';
import { ExchangeRateService } from '../../common/exchange-rates/exchange-rate.service';

// String-literal constants for Prisma enums that may not resolve during Jest runs
// (the generated client is mocked in unit tests).
const MILESTONE_STATUS_LOCKED = 'LOCKED' as const;
const MILESTONE_STATUS_PENDING = 'PENDING' as const;

const ENGAGEMENT_SORTABLE_FIELDS: Record<string, string> = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  status: 'status',
  jobTitle: 'jobTitle',
  totalAmount: 'totalAmount',
};

// Statuses in which a role is still unfilled, so a passed targetStartDate makes it overdue (#470).
const OPEN_ROLE_STATUSES: EngagementStatus[] = ['PENDING_ACCEPTANCE', 'ACTIVE', 'REPLACEMENT_REQUESTED'];

/** True when the hiring deadline has passed and no candidate has been placed yet (#470). */
function isEngagementOverdue(engagement: any, now = new Date()): boolean {
  if (!engagement.targetStartDate || engagement.placedAt) return false;
  if (!OPEN_ROLE_STATUSES.includes(engagement.status)) return false;
  return new Date(engagement.targetStartDate).getTime() < now.getTime();
}

@Injectable()
export class EngagementsService {
  private readonly logger = new Logger(EngagementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
    private readonly auditLog: AuditLogService,
    private readonly notesService: EngagementNotesService,
    private readonly importService: EngagementImportService,
    private readonly candidateDetailsService: EngagementCandidateDetailsService,
    @Optional() private readonly exchangeRates?: ExchangeRateService,
  ) {}

  // ----------------------------------------------------------
  // CREATE — validates, checks balance, submits on-chain, persists
  // ----------------------------------------------------------

  async create(user: User, dto: CreateEngagementDto) {
    const { mergedData, templateVersion, milestoneData } = await this.prepareEngagement(user, dto);

    // Increment template usage stats (#265)
    if (dto.templateId) {
      await this.prisma.engagementTemplate.update({
        where: { id: dto.templateId },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
      });
    }

    // Persist engagement as PENDING_ACCEPTANCE — on-chain submission happens on recruiter accept
    const engagement = await this.prisma.engagement.create({
      data: {
        id: mergedData.engagementId,
        companyAddress: mergedData.companyAddress,
        recruiterAddress: mergedData.recruiterAddress,
        arbiterAddress: mergedData.arbiterAddress,
        tokenAddress: mergedData.tokenAddress,
        totalAmount: BigInt(mergedData.totalAmount),
        jobTitle: mergedData.jobTitle,
        jobDescription: mergedData.jobDescription,
        salaryRange: mergedData.salaryRange,
        location: mergedData.location,
        customFields: mergedData.customFields ?? undefined,
        targetStartDate: mergedData.targetStartDate ? new Date(mergedData.targetStartDate) : null,
        status: 'PENDING_ACCEPTANCE',
        templateVersionId: templateVersion?.id,
        milestones: { create: milestoneData },
      },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Engagement invite created (PENDING_ACCEPTANCE): ${engagement.id}`);

    await this.notifications.notifyUser(
      mergedData.recruiterAddress,
      'ENGAGEMENT_CREATED',
      `New engagement invite: ${mergedData.jobTitle}`,
      `You have a new engagement invite for "${mergedData.jobTitle}". Please accept or decline.`,
      { engagementId: engagement.id },
    );

    return this.serialize(engagement);
  }

  // ----------------------------------------------------------
  // FEE PREVIEW (#375) — cost breakdown without creating anything
  // ----------------------------------------------------------

  /**
   * Runs the same validation as `create` and returns what the engagement will
   * cost: the escrowed amount and platform fee per milestone (token stroops,
   * using the company's plan fee rate) plus the Stellar network fees (XLM
   * stroops, from the same estimate as `GET /stellar/fee-estimate`).
   */
  async preview(user: User, dto: CreateEngagementDto) {
    const { mergedData, milestoneData } = await this.prepareEngagement(user, dto);

    const company = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { plan: { select: { id: true, platformFeeBps: true } } },
    });
    const platformFeeBps = company?.plan?.platformFeeBps ?? 0;
    const { sorobanFee } = await this.stellar.getFeeEstimate();
    const networkFee = BigInt(sorobanFee);

    const totalAmount = BigInt(mergedData.totalAmount);
    const amounts = this.splitByPercent(totalAmount, milestoneData.map((m) => m.paymentPercent));
    const platformFees = this.splitByPercent(
      (totalAmount * BigInt(platformFeeBps)) / 10_000n,
      milestoneData.map((m) => m.paymentPercent),
    );

    // One contract call funds the escrow; each milestone is released by its own call.
    const milestones = milestoneData.map((m, i) => ({
      milestoneIndex: m.milestoneIndex,
      name: m.name,
      kind: m.kind,
      paymentPercent: m.paymentPercent,
      amount: amounts[i].toString(),
      platformFee: platformFees[i].toString(),
      total: (amounts[i] + platformFees[i]).toString(),
      networkFee: networkFee.toString(),
    }));
    const platformFee = platformFees.reduce((acc, f) => acc + f, 0n);
    const networkFeeTotal = networkFee * BigInt(milestoneData.length + 1);

    return {
      tokenAddress: mergedData.tokenAddress,
      plan: company?.plan?.id ?? null,
      platformFeeBps,
      totalAmount: totalAmount.toString(),
      platformFee: platformFee.toString(),
      totalCost: (totalAmount + platformFee).toString(),
      networkFee: {
        asset: 'XLM',
        fundingFee: networkFee.toString(),
        perMilestoneReleaseFee: networkFee.toString(),
        total: networkFeeTotal.toString(),
      },
      milestones,
    };
  }

  /** Split `total` by percentages; the last share absorbs rounding so the parts sum to `total`. */
  private splitByPercent(total: bigint, percents: number[]): bigint[] {
    let allocated = 0n;
    return percents.map((percent, i) => {
      if (i === percents.length - 1) return total - allocated;
      const share = (total * BigInt(percent)) / 100n;
      allocated += share;
      return share;
    });
  }

  /**
   * Validation shared by `create` and `preview`: plan limits, token allow-list,
   * custom fields, template merge and milestone checks. Has no side effects.
   */
  private async prepareEngagement(user: User, dto: CreateEngagementDto) {
    const existing = await this.prisma.engagement.findUnique({
      where: { id: dto.engagementId },
    });
    if (existing) {
      throw new ConflictException(`Engagement ${dto.engagementId} already exists`);
    }

    // Plan limit: check active engagement count against company's plan
    const companyWithPlan = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { plan: { select: { maxActiveEngagements: true } } },
    });
    if (companyWithPlan?.plan) {
      const activeCount = await this.prisma.engagement.count({
        where: { companyId: user.id, status: { in: ['ACTIVE', 'PENDING_ACCEPTANCE'] } },
      });
      if (activeCount >= companyWithPlan.plan.maxActiveEngagements) {
        throw new BadRequestException(
          `Plan limit reached: your plan allows at most ${companyWithPlan.plan.maxActiveEngagements} active engagements`,
        );
      }
    }

    // Validate token is allowed
    if (!this.stellar.isTokenAllowed(dto.tokenAddress)) {
      throw new BadRequestException(`Token ${dto.tokenAddress} is not allowed`);
    }

    // Validate customFields keys against the company's allow-list
    if (dto.customFields && Object.keys(dto.customFields).length > 0) {
      const companyUser = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { allowedCustomFields: true },
      });
      const allowed = companyUser?.allowedCustomFields ?? [];
      const unknown = Object.keys(dto.customFields).filter((k) => !allowed.includes(k));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Unknown custom field key(s): ${unknown.join(', ')}. Configure allowed keys via PUT /users/me/custom-fields-config`,
        );
      }
    }

    // Load template if provided — pin to the specific version that is current as of
    // now, so this engagement keeps referencing that exact snapshot even if the
    // template is edited (and gains new versions) afterwards.
    let templateVersion: any = null;
    if (dto.templateId) {
      const template = await this.prisma.engagementTemplate.findUnique({
        where: { id: dto.templateId },
      });
      if (!template) throw new NotFoundException(`Template ${dto.templateId} not found`);
      if (template.companyId !== user.id) throw new ForbiddenException('Not authorized to use this template');

      templateVersion = await this.prisma.engagementTemplateVersion.findUnique({
        where: { templateId_version: { templateId: template.id, version: template.currentVersion } },
      });
    }

    // Merge template version and dto (dto overrides template)
    const mergedData = {
      ...dto,
      jobTitle: dto.jobTitle ?? templateVersion?.jobTitle,
      jobDescription: dto.jobDescription ?? templateVersion?.jobDescription,
      salaryRange: dto.salaryRange ?? templateVersion?.salaryRange,
      location: dto.location ?? templateVersion?.location,
      targetStartDate: dto.targetStartDate,
      milestones: dto.milestones ?? templateVersion?.milestoneConfig?.milestones,
      retentionDays: dto.retentionDays ?? templateVersion?.milestoneConfig?.retentionDays,
    };

    // Validate required fields after merge
    if (!mergedData.jobTitle) throw new BadRequestException('jobTitle is required (either provide it or use a template)');
    if (!mergedData.milestones) throw new BadRequestException('milestones are required (either provide them or use a template)');

    // Validate milestone sum still (since we merged)
    const sum = mergedData.milestones.reduce((acc: number, m: any) => acc + (m.paymentPercent || 0), 0);
    if (sum !== 100) throw new BadRequestException('Milestone paymentPercent values must sum to exactly 100');

    // Build milestone data (no on-chain data yet — deferred until recruiter accepts)
    let retentionIdx = 0;
    const milestoneData = mergedData.milestones.map((m: any, index: number) => {
      const isRetention = m.kind === 'RETENTION';
      const retentionDays = isRetention ? (mergedData.retentionDays?.[retentionIdx++] ?? null) : null;

      return {
        milestoneIndex: index,
        name: m.name,
        kind: m.kind as MilestoneKind,
        paymentPercent: m.paymentPercent,
        retentionDays,
        status: isRetention ? MILESTONE_STATUS_LOCKED : MILESTONE_STATUS_PENDING,
      };
    });

    return { mergedData, templateVersion, milestoneData };
  }

  // ----------------------------------------------------------
  // RECRUITER INVITE ACCEPT / DECLINE (#250)
  // ----------------------------------------------------------

  async listPendingInvites(
    recruiterStellarAddress: string,
    page = 1,
    limit = 20,
    cursor?: string,
  ) {
    const where = {
      recruiterAddress: recruiterStellarAddress,
      status: 'PENDING_ACCEPTANCE',
    };

    if (cursor) {
      const engagements = await this.prisma.engagement.findMany({
        where,
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        cursor: { id: cursor },
        skip: 1,
        take: limit + 1,
      });
      const pageResult = cursorPage(engagements, limit);
      return {
        data: pageResult.data.map(this.serialize),
        meta: { limit, nextCursor: pageResult.nextCursor },
      };
    }

    const [engagements, total] = await this.prisma.$transaction([
      this.prisma.engagement.findMany({
        where,
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.engagement.count({ where }),
    ]);

    return {
      data: engagements.map(this.serialize),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async acceptInvite(engagementId: string, user: User) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    if (engagement.recruiterAddress !== user.stellarAddress) {
      throw new ForbiddenException('You are not the invited recruiter for this engagement');
    }
    if (engagement.status !== 'PENDING_ACCEPTANCE') {
      throw new ConflictException(`Engagement is not pending acceptance (current status: ${engagement.status})`);
    }

    // Check company balance and submit on-chain now that recruiter has accepted
    const { sufficient, balance } = await this.stellar.checkTokenBalance(
      engagement.companyAddress,
      engagement.tokenAddress,
      engagement.totalAmount,
    );
    if (!sufficient) {
      throw new BadRequestException(
        `Insufficient company token balance. Required: ${engagement.totalAmount.toString()} stroops, available: ${balance.toString()}`,
      );
    }

    const retentionMilestones = engagement.milestones.filter((m) => m.kind === 'RETENTION');
    const { txHash, ledger: createdLedger } = await this.stellar.submitCreateEngagement({
      engagementId: engagement.id,
      companyAddress: engagement.companyAddress,
      recruiterAddress: engagement.recruiterAddress,
      arbiterAddress: engagement.arbiterAddress,
      tokenAddress: engagement.tokenAddress,
      totalAmount: engagement.totalAmount.toString(),
      milestones: engagement.milestones.map((m) => ({
        name: m.name,
        paymentPercent: m.paymentPercent,
        kind: m.kind,
        retentionDays: m.kind === 'RETENTION'
          ? retentionMilestones.indexOf(m) >= 0 && m.retentionDays != null
            ? m.retentionDays
            : undefined
          : undefined,
      })),
    });

    const currentLedger = await this.stellar.getLatestLedger();

    // Funding is confirmed on-chain — freeze the asset/USD rate for stable fiat reporting (#469)
    const fundingRateUsd = await this.fetchUsdRate(engagement.tokenAddress);

    // 3. Build milestone data with unlock estimates
    let retentionIdx = 0;
    const milestoneData = engagement.milestones.map((m: any, index: number) => {
      const isRetention = m.kind === 'RETENTION';
      const retentionDays = isRetention ? (engagement.milestones.filter((x: any) => x.kind === 'RETENTION')[retentionIdx++]?.retentionDays ?? null) : null;
      const validAfterLedger = isRetention && retentionDays
        ? createdLedger + (retentionDays * 17_280)
        : null;
      const unlockEstimatedAt = validAfterLedger
        ? this.stellar.ledgerToDateTime(validAfterLedger, currentLedger)
        : null;

      return {
        milestoneIndex: index,
        name: m.name,
        kind: m.kind as MilestoneKind,
        paymentPercent: m.paymentPercent,
        retentionDays,
        validAfterLedger: validAfterLedger ?? null,
        unlockEstimatedAt,
        placementDueAt: m.kind === 'PLACEMENT' && m.placementDueAt ? new Date(m.placementDueAt) : null,
        status: isRetention ? MILESTONE_STATUS_LOCKED : MILESTONE_STATUS_PENDING,
      };
    });

    // 4. Persist engagement + milestones + retention schedules atomically
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.engagement.update({
        where: { id: engagementId },
        data: {
          status: 'ACTIVE',
          txHash,
          createdLedger,
          ...(fundingRateUsd != null ? { fundingRateUsd, fundingRateAt: new Date() } : {}),
        },
      });

      for (const m of engagement.milestones) {
        if (m.kind === 'RETENTION' && m.retentionDays) {
          const validAfterLedger = createdLedger + m.retentionDays * 17_280;
          const unlockEstimatedAt = this.stellar.ledgerToDateTime(validAfterLedger, currentLedger);
          await tx.milestone.update({
            where: { id: m.id },
            data: { validAfterLedger, unlockEstimatedAt },
          });
          await tx.retentionSchedule.create({
            data: {
              engagementId,
              milestoneIndex: m.milestoneIndex,
              validAfterLedger,
              unlockAt: unlockEstimatedAt,
              notifyAt: new Date(unlockEstimatedAt.getTime() - 3 * 24 * 60 * 60 * 1000),
            },
          });
        }
      }

      return tx.engagement.findUnique({
        where: { id: engagementId },
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
      });
    });

    this.logger.log(`Engagement ${engagementId} accepted by recruiter, on-chain tx: ${txHash}`);

    await Promise.allSettled([
      this.notifications.notifyUser(
        engagement.companyAddress,
        'ENGAGEMENT_CREATED',
        `Engagement accepted: ${engagement.jobTitle}`,
        `The recruiter has accepted the engagement "${engagement.jobTitle}" (${engagementId}). On-chain funding is in progress.`,
        { engagementId, txHash },
      ),
    ]);

    return this.serialize(updated);
  }

  async declineInvite(engagementId: string, user: User) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
    });

    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    if (engagement.recruiterAddress !== user.stellarAddress) {
      throw new ForbiddenException('You are not the invited recruiter for this engagement');
    }
    if (engagement.status !== 'PENDING_ACCEPTANCE') {
      throw new ConflictException(`Engagement is not pending acceptance (current status: ${engagement.status})`);
    }

    const updated = await this.prisma.engagement.update({
      where: { id: engagementId },
      data: { status: 'CANCELLED' },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Engagement ${engagementId} declined by recruiter — cancelled without on-chain submission`);

    await this.notifications.notifyUser(
      engagement.companyAddress,
      'ENGAGEMENT_CANCELLED',
      `Engagement declined: ${engagement.jobTitle}`,
      `The recruiter has declined the engagement invite for "${engagement.jobTitle}" (${engagementId}).`,
      { engagementId },
    );

    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  async findAll(filters: {
    companyAddress?: string;
    recruiterAddress?: string;
    status?: string;       // single value or comma-separated list
    search?: string;       // partial case-insensitive match on jobTitle
    createdFrom?: string;  // ISO date string
    createdTo?: string;    // ISO date string
    tags?: string;         // comma-separated tag values — matches any engagement that has ALL listed tags
    page?: number;
    limit?: number;
    cursor?: string;
    sortBy?: string;       // one of ENGAGEMENT_SORTABLE_FIELDS
    sortOrder?: string;    // 'asc' | 'desc'
    includeArchived?: boolean;
    overdue?: boolean | string; // true → only engagements past their targetStartDate (#470)
  }) {
    const {
      companyAddress, recruiterAddress, status, search, createdFrom, createdTo, tags,
      page = 1, limit = 20, cursor, sortBy, sortOrder, includeArchived, overdue,
    } = filters;

    const where: any = {};
    if (companyAddress) where.companyAddress = companyAddress;
    if (recruiterAddress) where.recruiterAddress = recruiterAddress;

    if (!includeArchived) {
      where.archivedAt = null;
    }

    if (status) {
      const statuses = status.split(',').map((s) => s.trim()) as EngagementStatus[];
      where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
    }

    if (search) {
      where.jobTitle = { contains: search, mode: 'insensitive' };
    }

    if (createdFrom || createdTo) {
      where.createdAt = {};
      if (createdFrom) where.createdAt.gte = new Date(createdFrom);
      if (createdTo) where.createdAt.lte = new Date(createdTo);
    }

    // tags filter: matches any engagement that contains ALL of the requested tags
    if (tags) {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagList.length > 0) {
        where.tags = { hasEvery: tagList };
      }
    }

    // overdue filter (#470): deadline passed, nobody placed, role still open
    if (overdue === true || overdue === 'true') {
      where.AND = [
        { targetStartDate: { lt: new Date() } },
        { placedAt: null },
        { status: { in: OPEN_ROLE_STATUSES } },
      ];
    }

    let orderBy: Record<string, 'asc' | 'desc'> = { createdAt: 'desc' };
    if (sortBy !== undefined) {
      const field = ENGAGEMENT_SORTABLE_FIELDS[sortBy];
      if (!field) {
        throw new BadRequestException(
          `Invalid sortBy value '${sortBy}'. Allowed values: ${Object.keys(ENGAGEMENT_SORTABLE_FIELDS).join(', ')}`,
        );
      }
      if (sortOrder !== undefined && sortOrder !== 'asc' && sortOrder !== 'desc') {
        throw new BadRequestException(`Invalid sortOrder value '${sortOrder}'. Allowed values: asc, desc`);
      }
      orderBy = { [field]: sortOrder === 'asc' ? 'asc' : 'desc' };
    }

    if (cursor) {
      const engagements = await this.prisma.engagement.findMany({
        where,
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
        orderBy,
        cursor: { id: cursor },
        skip: 1,
        take: limit + 1,
      });
      const pageResult = cursorPage(engagements, limit);
      return {
        data: pageResult.data.map(this.serialize),
        meta: { limit, nextCursor: pageResult.nextCursor },
      };
    }

    const [engagements, total] = await this.prisma.$transaction([
      this.prisma.engagement.findMany({
        where,
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.engagement.count({ where }),
    ]);

    return {
      data: engagements.map(this.serialize),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Retrieves the full engagement record including milestones and events.
   * If `userId` is provided, enforces that only parties to the engagement may view it.
   */
  async findOne(id: string, userId?: string) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id },
      include: {
        milestones: { orderBy: { milestoneIndex: 'asc' } },
        events: { orderBy: { ledger: 'desc' }, take: 20 },
      },
    });

    if (!engagement) throw new NotFoundException(`Engagement ${id} not found`);

    if (userId && engagement.clientId && engagement.freelancerId) {
      if (engagement.clientId !== userId && engagement.freelancerId !== userId) {
        throw new ForbiddenException('You do not have access to this engagement');
      }
    }

    return { ...this.serializeAmounts(engagement), isOverdue: isEngagementOverdue(engagement) };
  }

  /**
   * Delegate to EngagementCandidateDetailsService.
   * Kept here so the controller interface stays unchanged.
   */
  async getSummary(id: string, userId: string): Promise<EngagementSummaryDto> {
    return this.candidateDetailsService.getSummary(id, userId);
  }

  // ----------------------------------------------------------
  // NOTES — delegated to EngagementNotesService
  // ----------------------------------------------------------

  /** Add an internal note (delegates to EngagementNotesService). */
  createNote(
    engagementId: string,
    user: { id: string; stellarAddress?: string; role: string },
    body: string,
  ) {
    return this.notesService.createNote(engagementId, user, body);
  }

  /** List internal notes (delegates to EngagementNotesService). */
  findNotes(
    engagementId: string,
    user: { id: string; stellarAddress?: string; role: string },
  ) {
    return this.notesService.findNotes(engagementId, user);
  }

  // ----------------------------------------------------------
  // CANCEL
  // ----------------------------------------------------------

  async cancelEngagement(engagementId: string, requestingUser: User) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
    });

    if (!engagement) {
      throw new NotFoundException(`Engagement ${engagementId} not found`);
    }

    if (engagement.companyAddress !== requestingUser.stellarAddress) {
      throw new ForbiddenException('Only the company party may cancel this engagement');
    }

    if (
      engagement.status === 'CANCELLED' ||
      engagement.status === 'COMPLETED'
    ) {
      throw new ConflictException(
        `Cannot cancel an engagement with status '${engagement.status}'`,
      );
    }

    const txHash = await this.stellar.cancelEngagement(engagementId);
    this.logger.log(`On-chain cancel submitted for ${engagementId} (tx: ${txHash})`);

    const updated = await this.prisma.$transaction(async (tx) => {
      return tx.engagement.update({
        where: { id: engagementId },
        data: { status: 'CANCELLED' },
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
      });
    });

    const notifyTitle = `Engagement Cancelled – ${engagement.jobTitle}`;
    const notifyMessage =
      `The engagement "${engagement.jobTitle}" (${engagementId}) has been cancelled by the company. ` +
      `On-chain transaction: ${txHash}`;

    await Promise.allSettled([
      this.notifications.notifyUser(
        engagement.companyAddress,
        'ENGAGEMENT_CANCELLED',
        notifyTitle,
        notifyMessage,
        { engagementId, txHash },
      ),
      this.notifications.notifyUser(
        engagement.recruiterAddress,
        'ENGAGEMENT_CANCELLED',
        notifyTitle,
        notifyMessage,
        { engagementId, txHash },
      ),
      this.notifications.notifyUser(
        engagement.arbiterAddress,
        'ENGAGEMENT_CANCELLED',
        notifyTitle,
        notifyMessage,
        { engagementId, txHash },
      ),
    ]);

    this.logger.log(`Engagement ${engagementId} cancelled and all parties notified`);
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // REQUEST REPLACEMENT
  // ----------------------------------------------------------

  async requestReplacement(
    engagementId: string,
    requestingUser: User,
    reason?: string,
  ) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
    });

    if (!engagement) {
      throw new NotFoundException(`Engagement ${engagementId} not found`);
    }

    if (engagement.companyAddress !== requestingUser.stellarAddress) {
      throw new ForbiddenException(
        'Only the company party may request a candidate replacement',
      );
    }

    if (
      engagement.status === 'CANCELLED' ||
      engagement.status === 'COMPLETED' ||
      engagement.status === 'REPLACEMENT_REQUESTED'
    ) {
      throw new ConflictException(
        `Cannot request replacement for an engagement with status '${engagement.status}'`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      return tx.engagement.update({
        where: { id: engagementId },
        data: { status: 'REPLACEMENT_REQUESTED' },
        include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
      });
    });

    const notifyTitle = `Replacement Requested – ${engagement.jobTitle}`;
    const reasonSuffix = reason ? ` Reason: "${reason}"` : '';
    const notifyMessage =
      `The company has requested a candidate replacement for engagement ` +
      `"${engagement.jobTitle}" (${engagementId}).${reasonSuffix}`;

    await Promise.allSettled([
      this.notifications.notifyUser(
        engagement.companyAddress,
        'REPLACEMENT_REQUESTED',
        notifyTitle,
        notifyMessage,
        { engagementId, reason: reason ?? null },
      ),
      this.notifications.notifyUser(
        engagement.recruiterAddress,
        'REPLACEMENT_REQUESTED',
        notifyTitle,
        notifyMessage,
        { engagementId, reason: reason ?? null },
      ),
      this.notifications.notifyUser(
        engagement.arbiterAddress,
        'REPLACEMENT_REQUESTED',
        notifyTitle,
        notifyMessage,
        { engagementId, reason: reason ?? null },
      ),
    ]);

    this.logger.log(
      `Engagement ${engagementId} replacement requested and all parties notified`,
    );
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // SYNC FROM CHAIN
  // ----------------------------------------------------------

  /**
   * Re-read the engagement status from Stellar and update the DB.
   * Called by EventsService after relevant on-chain events, or manually.
   */
  async syncFromChain(engagementId: string) {
    try {
      const { nativeToScVal } = await import('@stellar/stellar-sdk');
      const onChain = await this.stellar.simulateContractCall('get_engagement', [
        nativeToScVal(engagementId, { type: 'string' }),
      ]);
      if (!onChain) return;

      const engagement = await this.prisma.engagement.findUnique({
        where: { id: engagementId },
      });
      if (!engagement) return;

      const releasedAmount = BigInt(onChain.released_amount ?? 0);
      const { balance: escrowBalance } = await this.stellar.getBalance(
        this.stellar.getContractId(),
        engagement.tokenAddress,
      );
      const expectedEscrowBalance = engagement.totalAmount - releasedAmount;
      const fundingShortfall = escrowBalance !== expectedEscrowBalance;

      const statusMap: Record<string, EngagementStatus> = {
        Active: 'ACTIVE',
        Completed: 'COMPLETED',
        Cancelled: 'CANCELLED',
        ReplacementRequested: 'REPLACEMENT_REQUESTED',
      };

      // Retry the funding rate snapshot if the provider was unavailable at accept time (#469)
      const fundingRateUsd = engagement.txHash && engagement.fundingRateUsd == null
        ? await this.fetchUsdRate(engagement.tokenAddress)
        : null;

      await this.prisma.engagement.update({
        where: { id: engagementId },
        data: {
          status: statusMap[onChain.status] ?? 'ACTIVE',
          releasedAmount,
          escrowBalance,
          fundingShortfall,
          ...(fundingRateUsd != null ? { fundingRateUsd, fundingRateAt: new Date() } : {}),
        },
      });

      if (fundingShortfall && !engagement.fundingShortfall) {
        const message =
          `Engagement ${engagementId} has a funding shortfall. ` +
          `Expected ${expectedEscrowBalance.toString()} stroops, ` +
          `but the escrow contains ${escrowBalance.toString()} stroops.`;
        await Promise.all([
          this.notifications.notifyUser(
            engagement.companyAddress,
            'FUNDING_SHORTFALL_DETECTED',
            'Engagement funding shortfall detected',
            message,
            { engagementId, expectedEscrowBalance: expectedEscrowBalance.toString(), escrowBalance: escrowBalance.toString() },
          ),
          this.notifications.notifyUser(
            engagement.recruiterAddress,
            'FUNDING_SHORTFALL_DETECTED',
            'Engagement funding shortfall detected',
            message,
            { engagementId, expectedEscrowBalance: expectedEscrowBalance.toString(), escrowBalance: escrowBalance.toString() },
          ),
        ]);
      }

      this.logger.log(`Synced engagement ${engagementId} from chain`);
    } catch (error) {
      this.logger.error(`Failed to sync ${engagementId}`, error.message);
    }
  }

  // ----------------------------------------------------------
  // STATUS MANAGEMENT
  // ----------------------------------------------------------

  async updateStatus(
    engagementId: string,
    newStatus: EngagementStatus,
    requestingUserId: string,
    reason?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        select: { status: true },
      });

      const updated = await tx.engagement.update({
        where: { id: engagementId },
        data: { status: newStatus },
      });

      await this.auditLog.record(tx, {
        engagementId,
        fromStatus: current.status,
        toStatus: newStatus,
        changedBy: requestingUserId,
        reason,
      });

      return updated;
    });
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  async recuseArbiter(engagementId: string, userId: string, userRole: UserRole) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
      include: { arbiter: true },
    });
    if (!engagement) throw new NotFoundException('Engagement not found');

    if (userRole !== 'ARBITER' || !engagement.arbiter || engagement.arbiter.id !== userId) {
      throw new ForbiddenException('Only the assigned arbiter can recuse themselves');
    }

    // Persist the recusal so auto-assignment never routes this engagement's disputes back to them (#383)
    await this.prisma.arbiterRecusal.upsert({
      where: { engagementId_arbiterId: { engagementId, arbiterId: userId } },
      update: {},
      create: { engagementId, arbiterId: userId },
    });

    // Notify all admins
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', deactivatedAt: null },
    });

    for (const admin of admins) {
      await this.notifications.notifyUserById(
        admin.id,
        'ARBITER_RECUSAL_REQUESTED',
        'Arbiter Recusal Requested',
        `Arbiter ${engagement.arbiter?.name} has recused themselves from engagement ${engagementId}. Please reassign.`,
        { engagementId, arbiterId: userId },
      );
    }

    return { message: 'Recusal request sent successfully' };
  }

  // ----------------------------------------------------------
  // ARCHIVE / RESTORE
  // ----------------------------------------------------------

  async archive(engagementId: string) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
    });
    if (!engagement) {
      throw new NotFoundException(`Engagement ${engagementId} not found`);
    }
    if (engagement.archivedAt) {
      throw new ConflictException(`Engagement ${engagementId} is already archived`);
    }

    const updated = await this.prisma.engagement.update({
      where: { id: engagementId },
      data: { archivedAt: new Date() },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Engagement ${engagementId} archived`);
    return this.serialize(updated);
  }

  async restore(engagementId: string) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
    });
    if (!engagement) {
      throw new NotFoundException(`Engagement ${engagementId} not found`);
    }
    if (!engagement.archivedAt) {
      throw new ConflictException(`Engagement ${engagementId} is not archived`);
    }

    const updated = await this.prisma.engagement.update({
      where: { id: engagementId },
      data: { archivedAt: null },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Engagement ${engagementId} restored`);
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // TAGS (#252)
  // ----------------------------------------------------------

  async updateTags(engagementId: string, tags: string[]): Promise<any> {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
    });
    if (!engagement) {
      throw new NotFoundException(`Engagement ${engagementId} not found`);
    }

    const updated = await this.prisma.engagement.update({
      where: { id: engagementId },
      data: { tags },
      include: { milestones: { orderBy: { milestoneIndex: 'asc' } } },
    });

    this.logger.log(`Tags updated on engagement ${engagementId}: [${tags.join(', ')}]`);
    return this.serialize(updated);
  }

  // ----------------------------------------------------------
  // CSV BULK IMPORT (#254) — delegated to EngagementImportService
  // ----------------------------------------------------------

  /**
   * Delegate CSV bulk import to EngagementImportService.
   * Kept here so the controller interface stays unchanged.
   */
  importFromCsv(user: User, file: Express.Multer.File) {
    return this.importService.importFromCsv(user, file);
  }

  /** Current asset/USD rate for an engagement token, or null when unknown (#469). */
  private async fetchUsdRate(tokenAddress: string): Promise<number | null> {
    if (!this.exchangeRates) return null;
    try {
      const token = this.stellar.getTokenConfig(tokenAddress);
      return await this.exchangeRates.getRate(token.symbol, 'USD');
    } catch (error: any) {
      this.logger.warn(`USD rate snapshot skipped for token ${tokenAddress}: ${error?.message ?? String(error)}`);
      return null;
    }
  }

  // ----------------------------------------------------------
  // SERIALISE HELPERS
  // ----------------------------------------------------------

  private serialize(engagement: any) {
    return {
      ...engagement,
      totalAmount: engagement.totalAmount?.toString(),
      releasedAmount: engagement.releasedAmount?.toString(),
      escrowBalance: engagement.escrowBalance?.toString() ?? null,
      isOverdue: isEngagementOverdue(engagement),
      milestones: engagement.milestones?.map((m: any) => ({
        ...m,
        paymentReleased: m.paymentReleased?.toString() ?? null,
      })),
    };
  }

  /**
   * Helper utility to deeply convert BigInts to strings within an object.
   */
  private serializeAmounts(obj: any): any {
    return JSON.parse(
      JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    );
  }

  // ----------------------------------------------------------
  // ADMIN OVERRIDES
  // ----------------------------------------------------------

  async updateEngagementStatusByAdmin(
    engagementId: string,
    newStatus: EngagementStatus,
    reason: string,
    adminId: string,
  ) {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
    });

    if (!engagement) {
      throw new NotFoundException(`Engagement ${engagementId} not found`);
    }

    const oldStatus = engagement.status;

    await this.prisma.$transaction(async (tx) => {
      await tx.engagement.update({
        where: { id: engagementId },
        data: { status: newStatus },
      });

      await this.auditLog.record(tx, {
        engagementId,
        fromStatus: oldStatus,
        toStatus: newStatus,
        changedBy: adminId,
        reason,
      });

      // Notify all parties involved in the engagement
      const usersToNotify = [
        engagement.companyAddress,
        engagement.recruiterAddress,
        engagement.arbiterAddress,
      ];

      for (const address of usersToNotify) {
        await this.notifications.notifyUser(
          address,
          'ENGAGEMENT_CANCELLED', // Using CANCELLED as a generic override notification type for now
          `Engagement ${engagementId} status updated by Admin`,
          `The status of engagement ${engagementId} has been manually changed from ${oldStatus} to ${newStatus} by an administrator. Reason: ${reason}`,
          { engagementId, oldStatus, newStatus, reason },
        );
      }
    });

    this.logger.log(
      `Admin ${adminId} updated engagement ${engagementId} status from ${oldStatus} to ${newStatus}. Reason: ${reason}`,
    );

    return this.findOne(engagementId);
  }

  // ----------------------------------------------------------
  // ENGAGEMENT COMMENTS (#368)
  // ----------------------------------------------------------

  async createComment(engagementId: string, user: { id: string; stellarAddress?: string; role: string }, body: string) {
    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    this.checkParticipant(engagement, user);

    const comment = await this.prisma.engagementComment.create({
      data: { engagementId, authorId: user.id, body },
      include: { author: { select: { id: true, name: true } } },
    });

    // Notify the other party (not the author)
    const otherPartyAddress = engagement.companyAddress === user.stellarAddress 
      ? engagement.recruiterAddress 
      : engagement.companyAddress;

    await this.notifications.notifyUser(
      otherPartyAddress,
      NotificationType.COMMENT_ADDED,
      `New comment on engagement: ${engagement.jobTitle}`,
      `${comment.author.name || 'A participant'} added a comment: "${body.substring(0, 100)}${body.length > 100 ? '...' : ''}"`,
      { engagementId, commentId: comment.id },
    );

    // Also notify watchers
    await this.notifyWatchers(engagementId, NotificationType.COMMENT_ADDED, 
      `New comment on engagement: ${engagement.jobTitle}`,
      `${comment.author.name || 'A participant'} added a comment`,
      { engagementId, commentId: comment.id },
      user.id // exclude the author
    );

    return this.serializeComment(comment, user.id);
  }

  async listComments(engagementId: string, user: { id: string; stellarAddress?: string; role: string }) {
    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    this.checkParticipant(engagement, user);

    const comments = await this.prisma.engagementComment.findMany({
      where: { engagementId },
      include: { author: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return comments.map(c => this.serializeComment(c, user.id));
  }

  async updateComment(commentId: string, user: { id: string; role: string }, body: string) {
    const comment = await this.prisma.engagementComment.findUnique({
      where: { id: commentId },
      include: { engagement: true, author: { select: { id: true, name: true } } },
    });

    if (!comment) throw new NotFoundException(`Comment ${commentId} not found`);
    
    // Only the author can edit
    if (comment.authorId !== user.id) {
      throw new ForbiddenException('You can only edit your own comments');
    }

    // Check 15-minute edit window
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    if (comment.createdAt < fifteenMinutesAgo) {
      throw new ForbiddenException('Comments can only be edited within 15 minutes of creation');
    }

    const updated = await this.prisma.engagementComment.update({
      where: { id: commentId },
      data: { body, editedAt: new Date() },
      include: { author: { select: { id: true, name: true } } },
    });

    return this.serializeComment(updated, user.id);
  }

  private serializeComment(comment: any, currentUserId: string) {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const canEdit = comment.authorId === currentUserId && comment.createdAt >= fifteenMinutesAgo;

    return {
      id: comment.id,
      engagementId: comment.engagementId,
      authorId: comment.authorId,
      authorName: comment.author?.name || 'Unknown',
      body: comment.body,
      editedAt: comment.editedAt?.toISOString() ?? null,
      canEdit,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
    };
  }

  // ----------------------------------------------------------
  // ENGAGEMENT WATCHERS (#369)
  // ----------------------------------------------------------

  async addWatcher(engagementId: string, requestingUser: { id: string; stellarAddress?: string; role: string }, targetUserId: string) {
    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    
    // Only participants can add watchers
    this.checkParticipant(engagement, requestingUser);

    // Check if the target user exists and is part of the same company
    const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser) throw new NotFoundException(`User ${targetUserId} not found`);

    // Verify the target user is a company member (same companyOwnerId or is the owner)
    const requestingFullUser = await this.prisma.user.findUnique({ where: { id: requestingUser.id } });
    if (requestingFullUser.role === UserRole.COMPANY) {
      const isOwner = requestingFullUser.companyOwnerId === null;
      const targetIsTeamMember = 
        targetUser.id === requestingFullUser.id ||
        targetUser.companyOwnerId === requestingFullUser.id ||
        (requestingFullUser.companyOwnerId && targetUser.companyOwnerId === requestingFullUser.companyOwnerId);

      if (!targetIsTeamMember && requestingUser.role !== UserRole.ADMIN) {
        throw new ForbiddenException('Can only add watchers from your company team');
      }
    }

    // Check if already watching
    const existing = await this.prisma.engagementWatcher.findUnique({
      where: { engagementId_userId: { engagementId, userId: targetUserId } },
    });
    if (existing) {
      throw new ConflictException('User is already watching this engagement');
    }

    const watcher = await this.prisma.engagementWatcher.create({
      data: { engagementId, userId: targetUserId, addedBy: requestingUser.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        adder: { select: { id: true, name: true } },
      },
    });

    // Notify the newly added watcher
    await this.notifications.notifyUserById(
      targetUserId,
      NotificationType.WATCHER_ADDED,
      `Added as watcher: ${engagement.jobTitle}`,
      `${watcher.adder.name || 'A team member'} added you as a watcher to the engagement "${engagement.jobTitle}"`,
      { engagementId },
    );

    return this.serializeWatcher(watcher);
  }

  async removeWatcher(engagementId: string, requestingUser: { id: string; stellarAddress?: string; role: string }, targetUserId: string) {
    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);

    const watcher = await this.prisma.engagementWatcher.findUnique({
      where: { engagementId_userId: { engagementId, userId: targetUserId } },
    });
    if (!watcher) throw new NotFoundException('Watcher not found');

    // Users can remove themselves, or participants can remove any watcher
    const canRemove = 
      watcher.userId === requestingUser.id || 
      requestingUser.role === UserRole.ADMIN ||
      this.isParticipant(engagement, requestingUser);

    if (!canRemove) {
      throw new ForbiddenException('Not authorized to remove this watcher');
    }

    await this.prisma.engagementWatcher.delete({
      where: { id: watcher.id },
    });

    return { message: 'Watcher removed successfully' };
  }

  async listWatchers(engagementId: string, user: { id: string; stellarAddress?: string; role: string }) {
    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    this.checkParticipant(engagement, user);

    const watchers = await this.prisma.engagementWatcher.findMany({
      where: { engagementId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        adder: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return watchers.map(w => this.serializeWatcher(w));
  }

  private serializeWatcher(watcher: any) {
    return {
      id: watcher.id,
      engagementId: watcher.engagementId,
      userId: watcher.userId,
      userName: watcher.user?.name || 'Unknown',
      userEmail: watcher.user?.email || '',
      addedBy: watcher.addedBy,
      addedByName: watcher.adder?.name || 'Unknown',
      createdAt: watcher.createdAt.toISOString(),
    };
  }

  private async notifyWatchers(
    engagementId: string, 
    type: NotificationType, 
    title: string, 
    message: string, 
    data: Record<string, any>,
    excludeUserId?: string
  ) {
    const watchers = await this.prisma.engagementWatcher.findMany({
      where: { engagementId },
      select: { userId: true },
    });

    const notifyPromises = watchers
      .filter(w => w.userId !== excludeUserId)
      .map(w => this.notifications.notifyUserById(w.userId, type, title, message, data));

    await Promise.allSettled(notifyPromises);
  }

  private isParticipant(
    engagement: { companyAddress: string; recruiterAddress: string; arbiterAddress: string },
    user: { stellarAddress?: string; role: string },
  ): boolean {
    if (user.role === UserRole.ADMIN) return true;
    const parties = [engagement.companyAddress, engagement.recruiterAddress, engagement.arbiterAddress];
    return user.stellarAddress ? parties.includes(user.stellarAddress) : false;
  }

  // ----------------------------------------------------------
  // PLACED CANDIDATE DETAILS (#368)
  // ----------------------------------------------------------

  async updateCandidateDetails(
    engagementId: string, 
    user: { id: string; stellarAddress?: string; role: string },
    details: {
      candidateName?: string;
      candidateEmail?: string;
      candidatePhone?: string;
      candidateStartDate?: string;
      candidateRole?: string;
    }
  ) {
    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    this.checkParticipant(engagement, user);

    const updateData: any = {};
    if (details.candidateName !== undefined) updateData.candidateName = details.candidateName;
    if (details.candidateEmail !== undefined) updateData.candidateEmail = details.candidateEmail;
    if (details.candidatePhone !== undefined) updateData.candidatePhone = details.candidatePhone;
    if (details.candidateStartDate !== undefined) updateData.candidateStartDate = details.candidateStartDate ? new Date(details.candidateStartDate) : null;
    if (details.candidateRole !== undefined) updateData.candidateRole = details.candidateRole;

    // Set placedAt if this is the first time candidate details are being added
    if (!engagement.placedAt && Object.keys(updateData).length > 0) {
      updateData.placedAt = new Date();
    }

    const updated = await this.prisma.engagement.update({
      where: { id: engagementId },
      data: updateData,
    });

    return this.serializeCandidateDetails(updated);
  }

  async getCandidateDetails(engagementId: string, user: { id: string; stellarAddress?: string; role: string }) {
    const engagement = await this.prisma.engagement.findUnique({ 
      where: { id: engagementId },
      select: {
        id: true,
        candidateName: true,
        candidateEmail: true,
        candidatePhone: true,
        candidateStartDate: true,
        candidateRole: true,
        placedAt: true,
        companyAddress: true,
        recruiterAddress: true,
        arbiterAddress: true,
      }
    });

    if (!engagement) throw new NotFoundException(`Engagement ${engagementId} not found`);
    this.checkParticipant(engagement, user);

    return this.serializeCandidateDetails(engagement);
  }

  private serializeCandidateDetails(engagement: any) {
    return {
      candidateName: engagement.candidateName ?? null,
      candidateEmail: engagement.candidateEmail ?? null,
      candidatePhone: engagement.candidatePhone ?? null,
      candidateStartDate: engagement.candidateStartDate?.toISOString() ?? null,
      candidateRole: engagement.candidateRole ?? null,
      placedAt: engagement.placedAt?.toISOString() ?? null,
    };
  }
}
