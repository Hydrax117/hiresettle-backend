import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  QUEUE_DISCORD,
  QUEUE_EMAIL,
  QUEUE_SLACK,
  QUEUE_STELLAR_TX,
  QUEUE_TEAMS,
  QUEUE_WEBHOOK,
} from '../../queues/queues.module';

export const MANAGED_QUEUES = [
  QUEUE_EMAIL,
  QUEUE_STELLAR_TX,
  QUEUE_WEBHOOK,
  QUEUE_SLACK,
  QUEUE_DISCORD,
  QUEUE_TEAMS,
] as const;

/** Upper bound on delayed jobs listed per queue. */
const MAX_DELAYED_PER_QUEUE = 200;

export const SCHEDULED_JOB_AUDIT_ENTITY = 'ScheduledJob';

export type ScheduledJobKind = 'bullmq-scheduler' | 'bullmq-delayed' | 'cron' | 'interval' | 'timeout';

export interface ScheduledJobView {
  /** Opaque id for DELETE /admin/jobs/scheduled/:jobKey (URL-encode it). */
  jobKey: string;
  kind: ScheduledJobKind;
  name: string;
  queue: string | null;
  pattern: string | null;
  everyMs: number | null;
  nextRunAt: string | null;
  running: boolean | null;
  /** Cron / interval / timeout jobs live in this process only. */
  scope: 'cluster' | 'instance';
}

/**
 * Admin view over scheduled work (#505):
 *   - BullMQ job schedulers (repeatable jobs) and delayed jobs, stored in
 *     Redis and shared by every replica;
 *   - in-process @nestjs/schedule cron jobs, intervals and timeouts that were
 *     registered with a name.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly queues: Map<string, Queue>;

  constructor(
    private readonly scheduler: SchedulerRegistry,
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_EMAIL) email: Queue,
    @InjectQueue(QUEUE_STELLAR_TX) stellarTx: Queue,
    @InjectQueue(QUEUE_WEBHOOK) webhook: Queue,
    @InjectQueue(QUEUE_SLACK) slack: Queue,
    @InjectQueue(QUEUE_DISCORD) discord: Queue,
    @InjectQueue(QUEUE_TEAMS) teams: Queue,
  ) {
    this.queues = new Map(
      [email, stellarTx, webhook, slack, discord, teams].map((queue) => [queue.name, queue]),
    );
  }

  async listScheduled(): Promise<ScheduledJobView[]> {
    const fromQueues = await Promise.all([...this.queues.values()].map((queue) => this.listQueue(queue)));
    return [...fromQueues.flat(), ...this.listInProcess()];
  }

  /** Remove one scheduled job and record who removed it and why. */
  async removeScheduled(jobKey: string, adminId: string, reason: string): Promise<{ removed: ScheduledJobView }> {
    const target = parseJobKey(jobKey);
    const existing = (await this.listScheduled()).find((job) => job.jobKey === jobKey);
    if (!existing) throw new NotFoundException(`Scheduled job "${jobKey}" not found`);

    switch (target.kind) {
      case 'bullmq-scheduler':
        await this.queue(target.queue!).removeJobScheduler(target.id);
        break;
      case 'bullmq-delayed': {
        const job = await this.queue(target.queue!).getJob(target.id);
        if (!job) throw new NotFoundException(`Scheduled job "${jobKey}" not found`);
        await job.remove();
        break;
      }
      case 'cron':
        this.scheduler.deleteCronJob(target.id);
        break;
      case 'interval':
        this.scheduler.deleteInterval(target.id);
        break;
      case 'timeout':
        this.scheduler.deleteTimeout(target.id);
        break;
    }

    await this.prisma.auditLog.create({
      data: {
        entityType: SCHEDULED_JOB_AUDIT_ENTITY,
        entityId: jobKey,
        action: 'SCHEDULED_JOB_REMOVED',
        oldValue: JSON.stringify(existing),
        newValue: JSON.stringify({ removed: true }),
        reason,
        changedBy: adminId,
      },
    });
    this.logger.warn(`Scheduled job ${jobKey} removed by admin ${adminId}: ${reason}`);
    return { removed: existing };
  }

  private async listQueue(queue: Queue): Promise<ScheduledJobView[]> {
    const [schedulers, delayed] = await Promise.all([
      queue.getJobSchedulers(0, -1, true),
      queue.getDelayed(0, MAX_DELAYED_PER_QUEUE - 1),
    ]);

    const schedulerViews: ScheduledJobView[] = schedulers.map((scheduler) => ({
      jobKey: buildJobKey('bullmq-scheduler', scheduler.key, queue.name),
      kind: 'bullmq-scheduler',
      name: scheduler.name,
      queue: queue.name,
      pattern: scheduler.pattern ?? null,
      everyMs: scheduler.every != null ? Number(scheduler.every) : null,
      nextRunAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
      running: null,
      scope: 'cluster',
    }));

    const delayedViews: ScheduledJobView[] = delayed
      .filter((job) => job?.id && !job.repeatJobKey)
      .map((job) => ({
        jobKey: buildJobKey('bullmq-delayed', job.id!, queue.name),
        kind: 'bullmq-delayed',
        name: job.name,
        queue: queue.name,
        pattern: null,
        everyMs: null,
        nextRunAt: new Date(job.timestamp + (job.delay ?? 0)).toISOString(),
        running: null,
        scope: 'cluster',
      }));

    return [...schedulerViews, ...delayedViews];
  }

  private listInProcess(): ScheduledJobView[] {
    const cron: ScheduledJobView[] = [...this.scheduler.getCronJobs().entries()].map(([name, job]) => {
      let nextRunAt: string | null = null;
      try {
        nextRunAt = job.nextDate().toJSDate().toISOString();
      } catch {
        nextRunAt = null;
      }
      return {
        jobKey: buildJobKey('cron', name),
        kind: 'cron',
        name,
        queue: null,
        pattern: String((job as any).cronTime?.source ?? ''),
        everyMs: null,
        nextRunAt,
        running: Boolean((job as any).running),
        scope: 'instance',
      };
    });

    const timers = (kind: 'interval' | 'timeout', names: string[]): ScheduledJobView[] =>
      names.map((name) => ({
        jobKey: buildJobKey(kind, name),
        kind,
        name,
        queue: null,
        pattern: null,
        everyMs: null,
        nextRunAt: null,
        running: true,
        scope: 'instance',
      }));

    return [
      ...cron,
      ...timers('interval', this.scheduler.getIntervals()),
      ...timers('timeout', this.scheduler.getTimeouts()),
    ];
  }

  private queue(name: string): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new NotFoundException(`Unknown queue "${name}"`);
    return queue;
  }
}

/**
 * jobKey formats:
 *   bullmq-scheduler:<queue>:<schedulerKey>
 *   bullmq-delayed:<queue>:<jobId>
 *   cron:<name> | interval:<name> | timeout:<name>
 */
export function buildJobKey(kind: ScheduledJobKind, id: string, queue?: string): string {
  return queue ? `${kind}:${queue}:${id}` : `${kind}:${id}`;
}

export function parseJobKey(jobKey: string): { kind: ScheduledJobKind; queue: string | null; id: string } {
  const [kind, ...rest] = String(jobKey ?? '').split(':');
  if (kind === 'bullmq-scheduler' || kind === 'bullmq-delayed') {
    const [queue, ...idParts] = rest;
    const id = idParts.join(':');
    if (!queue || !id) throw new BadRequestException(`Malformed job key "${jobKey}"`);
    return { kind, queue, id };
  }
  if (kind === 'cron' || kind === 'interval' || kind === 'timeout') {
    const id = rest.join(':');
    if (!id) throw new BadRequestException(`Malformed job key "${jobKey}"`);
    return { kind, queue: null, id };
  }
  throw new BadRequestException(`Malformed job key "${jobKey}"`);
}
