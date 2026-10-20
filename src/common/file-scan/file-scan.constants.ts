export const QUEUE_FILE_SCAN = 'file-scan';

/** S3 prefix infected uploads are moved under; nothing is ever served from here. */
export const QUARANTINE_PREFIX = 'quarantine/';

export type FileScanKind = 'evidence' | 'dispute-message';

export interface FileScanJobData {
  kind: FileScanKind;
  /** DisputeEvidence.id or DisputeMessage.id */
  id: string;
}

export const fileScanQueueOptions = {
  name: QUEUE_FILE_SCAN,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    // Jobs use a deterministic jobId, so finished jobs are removed to let the
    // sweeper re-enqueue anything still PENDING.
    removeOnComplete: true,
    removeOnFail: true,
  },
};
