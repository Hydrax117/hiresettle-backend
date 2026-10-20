import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { S3Module } from '../../common/s3/s3.module';
import { FileScanModule } from '../../common/file-scan/file-scan.module';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { AppealService } from './appeal.service';
import { ArbiterAssignmentService } from './arbiter-assignment.service';
import { DisputeSlaService } from './dispute-sla.service';

@Module({
  imports: [NotificationsModule, S3Module, FileScanModule],
  controllers: [DisputesController],
  providers: [DisputesService, AppealService, ArbiterAssignmentService, DisputeSlaService],
  exports: [DisputesService, ArbiterAssignmentService],
})
export class DisputesModule {}
