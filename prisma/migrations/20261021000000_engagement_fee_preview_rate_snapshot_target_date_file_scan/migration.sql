-- AlterTable: platform fee rate per plan, used by the engagement fee preview (#375)
ALTER TABLE "plans" ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: funding-time asset/USD rate snapshot (#469) and hiring deadline (#470)
ALTER TABLE "engagements" ADD COLUMN "fundingRateUsd" DOUBLE PRECISION;
ALTER TABLE "engagements" ADD COLUMN "fundingRateAt" TIMESTAMP(3);
ALTER TABLE "engagements" ADD COLUMN "targetStartDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "engagements_targetStartDate_idx" ON "engagements"("targetStartDate");

-- AddValue: FILE_QUARANTINED to NotificationType enum (#471)
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FILE_QUARANTINED';

-- CreateEnum: malware scan state of uploaded files (#471)
CREATE TYPE "FileScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED');

-- AlterTable: existing evidence starts PENDING and is picked up by the scan sweeper
ALTER TABLE "dispute_evidence" ADD COLUMN "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "dispute_evidence" ADD COLUMN "scannedAt" TIMESTAMP(3);

ALTER TABLE "dispute_messages" ADD COLUMN "attachmentScanStatus" "FileScanStatus";
ALTER TABLE "dispute_messages" ADD COLUMN "attachmentScannedAt" TIMESTAMP(3);
UPDATE "dispute_messages" SET "attachmentScanStatus" = 'PENDING' WHERE "attachmentS3Key" IS NOT NULL;

-- CreateIndex
CREATE INDEX "dispute_evidence_scanStatus_idx" ON "dispute_evidence"("scanStatus");
CREATE INDEX "dispute_messages_attachmentScanStatus_idx" ON "dispute_messages"("attachmentScanStatus");
