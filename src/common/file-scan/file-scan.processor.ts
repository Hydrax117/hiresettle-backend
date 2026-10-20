import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_FILE_SCAN, FileScanJobData } from './file-scan.constants';
import { FileScanService } from './file-scan.service';

@Processor(QUEUE_FILE_SCAN)
export class FileScanProcessor extends WorkerHost {
  private readonly logger = new Logger(FileScanProcessor.name);

  constructor(private readonly fileScan: FileScanService) {
    super();
  }

  async process(job: Job<FileScanJobData>): Promise<void> {
    await this.fileScan.scan(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<FileScanJobData>, error: Error) {
    this.logger.error(
      `Malware scan of ${job.data.kind} ${job.data.id} failed (attempt ${job.attemptsMade}): ${error.message}`,
    );
  }
}
