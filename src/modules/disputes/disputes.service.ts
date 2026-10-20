import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SystemConfigService } from '../../common/system-config/system-config.service';
import { ConfigService } from '@nestjs/config';
import {
  Dispute,
  DisputeOutcome,
  DisputeStage,
  DisputeStatus,
  FileScanStatus,
  MilestoneStatus,
  NotificationType,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { S3Service } from '../../common/s3/s3.service';
import { FileScanService } from '../../common/file-scan/file-scan.service';
import { ArbiterAssignmentService, EngagementParties } from './arbiter-assignment.service';
import { DisputeSlaService } from './dispute-sla.service';
import { ACTIVE_DISPUTE_STATUSES } from './dispute.constants';

const HOUR_MS = 60 * 60 * 1000;

export interface DisputeActor {
  id: string;
  role: UserRole | string;
  stellarAddress?: string | null;
}

/**
 * DisputesService (#381, #382, #383)
 *
 * Owns the Dispute record that shadows a DISPUTED milestone. A first-tier
 * decision does not move funds: it opens an appeal window
 * (DISPUTE_APPEAL_WINDOW_HOURS, default 72h) during which escrow stays locked.
 * Settlement on-chain happens only once the decision is final — the window
 * lapsed, or an appeal was decided.
 */
@Injectable()
export class DisputesService {
  private readonly appealWindowHours: number;
  private readonly evidenceWindowHours: number;
  private readonly arbiterFeeType: 'FLAT' | 'PERCENT';
  private readonly arbiterFeeValue: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly arbiters: ArbiterAssignmentService,
    private readonly sla: DisputeSlaService,
    private readonly s3: S3Service,
    @Optional() private readonly systemConfig?: SystemConfigService,
    @Optional() private readonly fileScan?: FileScanService,
  ) {
    this.appealWindowHours = Number(this.config.get('DISPUTE_APPEAL_WINDOW_HOURS', 72));
    // Window during which either party may submit dispute evidence (#499).
    this.evidenceWindowHours = Number(this.config.get('DISPUTE_EVIDENCE_WINDOW_HOURS', 72));
    // Arbiter fee charged on dispute resolution (#500): a FLAT amount in
    // stroops, or a PERCENT of the milestone amount.
    this.arbiterFeeType =
      String(this.config.get('ARBITER_FEE_TYPE', 'PERCENT')).toUpperCase() === 'FLAT' ? 'FLAT' : 'PERCENT';
    this.arbiterFeeValue = Number(this.config.get('ARBITER_FEE_VALUE', 5));
  }

  /** Arbiter fee owed for a settled dispute, in stroops (#500). */
  computeArbiterFee(milestoneAmount: bigint): bigint {
    if (this.arbiterFeeValue <= 0) return 0n;
    if (this.arbiterFeeType === 'FLAT') {
      return BigInt(Math.round(this.arbiterFeeValue));
    }
    // PERCENT: keep 2 decimal places of precision (basis points) so e.g.
    // 2.5% is not truncated to 2%.
    const basisPoints = BigInt(Math.round(this.arbiterFeeValue * 100));
    return (milestoneAmount * basisPoints) / 10_000n;
  }

  /**
   * Records the arbiter's fee for a settled dispute (#500). Idempotent per
   * dispute (one payout row each), so a retried settlement never double-pays.
   */
  async recordArbiterPayout(dispute: Pick<Dispute, 'id' | 'arbiterId'>, milestoneAmount: bigint) {
    if (!dispute.arbiterId) return null;
    const amount = this.computeArbiterFee(milestoneAmount);
    if (amount <= 0n) return null;

    const existing = await this.prisma.arbiterPayout.findUnique({ where: { disputeId: dispute.id } });
    if (existing) return existing;

    return this.prisma.arbiterPayout.create({
      data: {
        disputeId: dispute.id,
        arbiterId: dispute.arbiterId,
        feeType: this.arbiterFeeType,
        feeValue: this.arbiterFeeValue,
        amount,
      },
    });
  }

  // ----------------------------------------------------------
  // OPEN
  // ----------------------------------------------------------

  /**
   * Creates the Dispute for a milestone that just became DISPUTED and routes
   * it to an arbiter. Idempotent: an existing unsettled dispute is returned
   * as-is, so replays of the on-chain event do not create duplicates.
   */
  async openForMilestone(milestoneId: string, opts: { reason?: string | null; raisedById?: string | null } = {}) {
    const existing = await this.prisma.dispute.findFirst({
      where: { milestoneId, status: { not: DisputeStatus.CLOSED } },
    });
    if (existing) return existing;

    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      select: { engagementId: true, disputeReason: true },
    });
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);

    const now = new Date();
    const dispute = await this.prisma.dispute.create({
      data: {
        engagementId: milestone.engagementId,
        milestoneId,
        raisedById: opts.raisedById ?? null,
        reason: opts.reason ?? milestone.disputeReason,
        status: DisputeStatus.OPEN,
        fundsLocked: true,
        // Evidence window opens the moment the dispute is raised (#499).
        evidenceDeadline: new Date(now.getTime() + this.evidenceWindowHours * HOUR_MS),
        ...this.sla.stageFields(DisputeStage.ASSIGNMENT, now),
      },
    });

    return (await this.arbiters.autoAssign(dispute.id)) ?? dispute;
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  async findOneForUser(id: string, user: DisputeActor, now: Date = new Date()) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      include: {
        appeal: true,
        engagement: true,
        milestone: { select: { id: true, milestoneIndex: true, name: true, status: true, amount: true } },
      },
    });
    if (!dispute) throw new NotFoundException(`Dispute ${id} not found`);
    if (!this.canView(dispute, user)) throw new ForbiddenException('Not a party to this dispute');

    const { engagement, milestone, ...rest } = dispute;
    return {
      ...rest,
      engagement: { id: engagement.id, jobTitle: engagement.jobTitle, status: engagement.status },
      milestone: { ...milestone, amount: milestone.amount?.toString() ?? null },
      sla: {
        stage: dispute.stage,
        responseDeadline: dispute.responseDeadline,
        slaStatus: dispute.slaStatus,
        isOverdue:
          ACTIVE_DISPUTE_STATUSES.includes(dispute.status) &&
          !!dispute.responseDeadline &&
          now > dispute.responseDeadline,
      },
      appealWindow: {
        deadline: dispute.appealDeadline,
        isOpen: this.isAppealWindowOpen(dispute, now),
      },
      evidenceWindow: {
        deadline: dispute.evidenceDeadline,
        isOpen: this.isEvidenceWindowOpen(dispute, now),
      },
    };
  }

  /**
   * Whether evidence may still be uploaded for this dispute (#499). Once the
   * dispute is no longer active (decided/closed) or the deadline has passed,
   * no further evidence is accepted.
   */
  isEvidenceWindowOpen(
    dispute: Pick<Dispute, 'status' | 'evidenceDeadline'>,
    now: Date = new Date(),
  ): boolean {
    if (!ACTIVE_DISPUTE_STATUSES.includes(dispute.status)) return false;
    if (!dispute.evidenceDeadline) return true;
    return now <= dispute.evidenceDeadline;
  }

  /**
   * Returns the active (non-closed) dispute for a milestone, if any, so
   * callers (e.g. evidence upload) can enforce the evidence window.
   */
  async findActiveForMilestone(milestoneId: string) {
    return this.prisma.dispute.findFirst({
      where: { milestoneId, status: { not: DisputeStatus.CLOSED } },
      orderBy: { createdAt: 'desc' },
    });
  }

  isAppealWindowOpen(
    dispute: Pick<Dispute, 'status' | 'isFinal' | 'appealDeadline'> & { appeal?: unknown },
    now: Date = new Date(),
  ): boolean {
    return (
      dispute.status === DisputeStatus.RESOLVED &&
      !dispute.isFinal &&
      !dispute.appeal &&
      !!dispute.appealDeadline &&
      now <= dispute.appealDeadline
    );
  }

  /** Company or recruiter on the engagement — the two sides who may appeal. */
  isParty(engagement: EngagementParties, user: DisputeActor): boolean {
    if (user.id && (user.id === engagement.companyId || user.id === engagement.recruiterId)) return true;
    return (
      !!user.stellarAddress &&
      (user.stellarAddress === engagement.companyAddress || user.stellarAddress === engagement.recruiterAddress)
    );
  }

  private canView(
    dispute: Dispute & { engagement: EngagementParties & { arbiterAddress: string }; appeal: { arbiterId: string | null } | null },
    user: DisputeActor,
  ): boolean {
    if (user.role === UserRole.ADMIN) return true;
    if (this.isParty(dispute.engagement, user)) return true;
    if (user.id === dispute.arbiterId || user.id === dispute.appeal?.arbiterId) return true;
    return !!user.stellarAddress && user.stellarAddress === dispute.engagement.arbiterAddress;
  }

  // ----------------------------------------------------------
  // DECIDE (first tier)
  // ----------------------------------------------------------

  /**
   * Records a first-tier decision on the milestone's active dispute.
   * Returns null when the milestone has no Dispute record (legacy disputes),
   * in which case the caller settles on-chain immediately as before.
   */
  async recordDecision(milestoneId: string, outcome: DisputeOutcome, actor?: DisputeActor) {
    const dispute = await this.prisma.dispute.findFirst({
      where: { milestoneId, status: { not: DisputeStatus.CLOSED } },
      orderBy: { createdAt: 'desc' },
    });
    if (!dispute) return null;
    return this.decide(dispute, outcome, actor);
  }

  async decide(dispute: Dispute, outcome: DisputeOutcome, actor?: DisputeActor) {
    if (dispute.status === DisputeStatus.RESOLVED) {
      throw new ConflictException('A decision has already been recorded for this dispute');
    }
    if (dispute.stage === DisputeStage.APPEAL_REVIEW) {
      throw new ConflictException('This dispute is under appeal; the appeal arbiter must decide it');
    }
    if (actor && actor.role !== UserRole.ADMIN && dispute.arbiterId && dispute.arbiterId !== actor.id) {
      throw new ForbiddenException('Only the assigned arbiter can decide this dispute');
    }

    const now = new Date();
    const deferred = this.appealWindowHours > 0;
    const appealDeadline = new Date(now.getTime() + (deferred ? this.appealWindowHours * HOUR_MS : 0));

    const { count } = await this.prisma.dispute.updateMany({
      where: { id: dispute.id, status: { in: ACTIVE_DISPUTE_STATUSES } },
      data: {
        status: DisputeStatus.RESOLVED,
        outcome,
        resolvedAt: now,
        appealDeadline,
        slaStatus: this.sla.completionStatus(dispute, now),
        fundsLocked: true,
        isFinal: !deferred,
      },
    });
    if (!count) throw new ConflictException('The dispute is no longer awaiting a decision');

    if (!deferred) return this.settle(dispute.id);

    const updated = await this.prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
    await this.notifyParties(
      updated.engagementId,
      NotificationType.DISPUTE_RESOLVED,
      'Dispute decision recorded',
      `The arbiter decided dispute ${updated.id}: ${outcome}. Either party may appeal until ` +
        `${appealDeadline.toISOString()}; escrowed funds stay locked until then.`,
      { disputeId: updated.id, outcome, appealDeadline },
    );
    return updated;
  }

  // ----------------------------------------------------------
  // SETTLE
  // ----------------------------------------------------------

  /**
   * Executes a final decision: refunds or releases the milestone on-chain and
   * unlocks the dispute. Claims the dispute first (RESOLVED → CLOSED) so the
   * appeal-window job and an in-request settlement can never both pay out;
   * on failure the claim is rolled back so the job retries.
   */
  async settle(disputeId: string) {
    const { count } = await this.prisma.dispute.updateMany({
      where: { id: disputeId, status: DisputeStatus.RESOLVED, isFinal: true, fundsReleasedAt: null },
      data: { status: DisputeStatus.CLOSED },
    });
    const dispute = await this.prisma.dispute.findUniqueOrThrow({
      where: { id: disputeId },
      include: { milestone: true },
    });
    if (!count) return dispute;

    const { milestone } = dispute;
    const approved = dispute.outcome === DisputeOutcome.RELEASE;
    const amount = BigInt(milestone.amount ?? 0);

    try {
      if (!approved) {
        await this.prisma.refund.upsert({
          where: { milestoneId: milestone.id },
          update: { amount, status: 'PENDING', reason: 'Resolved dispute in favor of the company' },
          create: { milestoneId: milestone.id, amount, status: 'PENDING', reason: 'Resolved dispute in favor of the company' },
        });
      }

      await this.stellar.resolveMilestoneDispute(dispute.engagementId, milestone.milestoneIndex, approved);
    } catch (error) {
      await this.prisma.dispute.update({ where: { id: disputeId }, data: { status: DisputeStatus.RESOLVED } });
      throw error;
    }

    const now = new Date();
    await this.prisma.milestone.update({
      where: { id: milestone.id },
      data: {
        status: approved ? MilestoneStatus.RESOLVED : MilestoneStatus.PENDING,
        ...(approved && amount ? { paymentReleased: amount, confirmedAt: now } : {}),
      },
    });

    const settled = await this.prisma.dispute.update({
      where: { id: disputeId },
      data: { fundsLocked: false, fundsReleasedAt: now },
    });

    // Deduct and record the arbiter's fee for having decided this dispute (#500).
    await this.recordArbiterPayout(dispute, amount);

    await this.notifyParties(
      dispute.engagementId,
      NotificationType.DISPUTE_RESOLVED,
      'Dispute closed',
      `Dispute ${disputeId} is final (${dispute.outcome}); escrowed funds have been ` +
        `${approved ? 'released to the recruiter' : 'refunded to the company'}.`,
      { disputeId, outcome: dispute.outcome, final: true },
    );

    return settled;
  }

  /**
   * Closes any unsettled dispute on a milestone that was resolved on-chain
   * outside this workflow (e.g. a replayed dispute_resolved event), so it
   * stops counting toward arbiter workload and SLA checks.
   */
  async markSettledOnChain(milestoneId: string) {
    const now = new Date();
    return this.prisma.dispute.updateMany({
      where: { milestoneId, fundsReleasedAt: null },
      data: { status: DisputeStatus.CLOSED, isFinal: true, fundsLocked: false, fundsReleasedAt: now },
    });
  }

  async notifyParties(
    engagementId: string,
    type: NotificationType,
    title: string,
    message: string,
    data: Record<string, any>,
    excludeUserId?: string,
  ) {
    const engagement = await this.prisma.engagement.findUnique({ where: { id: engagementId } });
    if (!engagement) return;
    for (const userId of [engagement.companyId, engagement.recruiterId]) {
      if (!userId || userId === excludeUserId) continue;
      await this.notifications.notifyUserById(userId, type, title, message, { engagementId, ...data });
    }
  }

  // ----------------------------------------------------------
  // MESSAGING (#dispute-messaging)
  // ----------------------------------------------------------

  /**
   * Verify the actor may access this dispute's messages, then return all
   * messages newest-first. Pre-signed S3 URLs are generated on the fly for
   * any attachment so the caller never needs raw S3 keys — but only once the
   * attachment has passed malware scanning (#471).
   */
  async listMessages(disputeId: string, actor: DisputeActor) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { engagement: true, appeal: { select: { arbiterId: true } } },
    });
    if (!dispute) throw new NotFoundException(`Dispute ${disputeId} not found`);
    this.assertCanAccessMessages(dispute, actor);

    const rows = await this.prisma.disputeMessage.findMany({
      where: { disputeId },
      orderBy: { createdAt: 'asc' },
      include: { author: { select: { id: true, name: true, email: true } } },
    });

    return Promise.all(
      rows.map(async (m) => ({
        id: m.id,
        disputeId: m.disputeId,
        body: m.body,
        author: m.author,
        attachmentName: m.attachmentName,
        attachmentSize: m.attachmentSize,
        attachmentMimeType: m.attachmentMimeType,
        attachmentScanStatus: m.attachmentScanStatus,
        attachmentUrl: m.attachmentS3Key && m.attachmentScanStatus === FileScanStatus.CLEAN
          ? await this.s3.getPresignedUrl(m.attachmentS3Key).catch(() => null)
          : null,
        createdAt: m.createdAt,
      })),
    );
  }

  /**
   * Create a dispute message. The actor must be a participant or admin.
   * An optional multipart file is uploaded to S3; the key is stored but the
   * raw key is never returned — callers get a presigned URL instead.
   */
  async createMessage(
    disputeId: string,
    actor: DisputeActor,
    body: string,
    attachment?: Express.Multer.File,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { engagement: true, appeal: { select: { arbiterId: true } } },
    });
    if (!dispute) throw new NotFoundException(`Dispute ${disputeId} not found`);
    this.assertCanAccessMessages(dispute, actor);

    // Upload attachment first so the DB row is only created when S3 succeeded.
    let attachmentS3Key: string | null = null;
    if (attachment) {
      attachmentS3Key = `disputes/${disputeId}/messages/${Date.now()}-${attachment.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      await this.s3.uploadFile(attachmentS3Key, attachment.buffer, attachment.mimetype);
    }

    const message = await this.prisma.disputeMessage.create({
      data: {
        disputeId,
        authorId: actor.id,
        body,
        ...(attachment && attachmentS3Key
          ? {
              attachmentS3Key,
              attachmentName: attachment.originalname,
              attachmentSize: attachment.size,
              attachmentMimeType: attachment.mimetype,
              attachmentScanStatus: FileScanStatus.PENDING,
            }
          : {}),
      },
      include: { author: { select: { id: true, name: true, email: true } } },
    });
    if (attachmentS3Key) {
      await this.fileScan?.enqueue('dispute-message', message.id);
    }

    // Notify every participant except the author.
    await this.notifyMessageParticipants(dispute, actor, message.id);

    return {
      id: message.id,
      disputeId: message.disputeId,
      body: message.body,
      author: message.author,
      attachmentName: message.attachmentName,
      attachmentSize: message.attachmentSize,
      attachmentMimeType: message.attachmentMimeType,
      attachmentScanStatus: message.attachmentScanStatus,
      // Not downloadable until the malware scan marks it CLEAN (#471).
      attachmentUrl: null,
      createdAt: message.createdAt,
    };
  }

  // ----------------------------------------------------------
  // MESSAGING — helpers
  // ----------------------------------------------------------

  /**
   * A user may access dispute messages when they are:
   *   - The company or recruiter on the engagement, OR
   *   - The arbiter assigned to the dispute or its appeal, OR
   *   - An ADMIN
   */
  private assertCanAccessMessages(
    dispute: Dispute & {
      engagement: EngagementParties & { arbiterAddress: string };
      appeal: { arbiterId: string | null } | null;
    },
    actor: DisputeActor,
  ): void {
    if (this.canView(dispute, actor)) return;
    throw new ForbiddenException('Not a party to this dispute');
  }

  private async notifyMessageParticipants(
    dispute: Dispute & { engagement: EngagementParties },
    author: DisputeActor,
    messageId: string,
  ) {
    const { engagement } = dispute;
    const recipientIds = new Set<string>();

    // Both sides of the engagement
    if (engagement.companyId) recipientIds.add(engagement.companyId);
    if (engagement.recruiterId) recipientIds.add(engagement.recruiterId);
    // Assigned arbiter
    if (dispute.arbiterId) recipientIds.add(dispute.arbiterId);
    // Exclude the author
    recipientIds.delete(author.id);

    const title = 'New message on dispute';
    const text = `A new message was posted on dispute ${dispute.id}.`;
    const data = { disputeId: dispute.id, engagementId: dispute.engagementId, messageId };

    await Promise.allSettled(
      [...recipientIds].map((userId) =>
        this.notifications.notifyUserById(
          userId,
          NotificationType.DISPUTE_MESSAGE_CREATED,
          title,
          text,
          data,
        ),
      ),
    );
  }
}
