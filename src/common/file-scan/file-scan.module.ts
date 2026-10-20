import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Module } from '../s3/s3.module';
import { NotificationsModule } from '../../modules/notifications/notifications.module';
import { fileScanQueueOptions } from './file-scan.constants';
import { ClamAvScannerService } from './clamav-scanner.service';
import { FileScanService } from './file-scan.service';
import { FileScanProcessor } from './file-scan.processor';

/**
 * FileScanModule (#471)
 *
 * Scans uploaded dispute evidence and dispute message attachments for
 * malware via a BullMQ job. Uploads stay PENDING (not downloadable) until the
 * scan marks them CLEAN; infected files are quarantined and the uploader is
 * notified.
 */
@Module({
  imports: [
    BullModule.registerQueue(fileScanQueueOptions),
    PrismaModule,
    S3Module,
    NotificationsModule,
  ],
  providers: [ClamAvScannerService, FileScanService, FileScanProcessor],
  exports: [FileScanService],
})
export class FileScanModule {}
