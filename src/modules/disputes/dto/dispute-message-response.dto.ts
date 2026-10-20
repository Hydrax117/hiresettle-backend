import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DisputeMessageAuthorDto {
  @ApiProperty() id: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiPropertyOptional() email?: string | null;
}

export class DisputeMessageResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() disputeId: string;
  @ApiProperty() body: string;
  @ApiProperty() author: DisputeMessageAuthorDto;
  @ApiPropertyOptional() attachmentName?: string | null;
  @ApiPropertyOptional() attachmentSize?: number | null;
  @ApiPropertyOptional() attachmentMimeType?: string | null;
  /** Malware scan state of the attachment (#471); null when no attachment. */
  @ApiPropertyOptional({ enum: ['PENDING', 'CLEAN', 'INFECTED'] }) attachmentScanStatus?: string | null;
  /** Pre-signed S3 URL valid for 1 hour; null when no attachment or not yet scanned CLEAN. */
  @ApiPropertyOptional() attachmentUrl?: string | null;
  @ApiProperty() createdAt: Date;
}
