import { Processor, WorkerHost, OnWorkerEvent } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import axios from "axios";
import { QUEUE_WEBHOOK } from "./queues.module";
import { WebhookPayload } from "../modules/webhooks/webhooks.service";
import {
  signWebhookBody,
  WEBHOOK_SIGNATURE_HEADER,
} from "../modules/webhooks/webhook-signing.util";
import { buildWebhookRawBody } from "../modules/webhooks/webhook-payload.util";
import { PrismaService } from "../common/prisma/prisma.service";

export interface WebhookJobData {
  url: string;
  payload: WebhookPayload;
  userId?: string;
  secret?: string;
  subscriptionId?: string;
  /** HTTP status of the most recent failed attempt, kept for the delivery log (#397). */
  lastResponseCode?: number;
  /** Timestamp when the job was first created, for latency tracking. */
  startTime?: number;
}

@Processor(QUEUE_WEBHOOK)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    const { url, payload, secret } = job.data;
    this.logger.log(
      `Delivering webhook job ${job.id} to ${url} (event: ${payload.event}, attempt: ${job.attemptsMade + 1})`,
    );

    const rawBody = buildWebhookRawBody(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret) {
      headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(rawBody, secret);
    }

    let responseCode: number;
    try {
      const response = await axios.post(url, rawBody, {
        timeout: 5000,
        headers,
      });
      responseCode = response.status;
    } catch (error) {
      const status: number | undefined = error?.response?.status;
      if (status !== job.data.lastResponseCode) {
        await job.updateData({ ...job.data, lastResponseCode: status });
      }
      throw error;
    }

    this.logger.log(`Webhook job ${job.id} delivered to ${url}`);

    // Record successful delivery metrics
    if (this.metrics) {
      const duration = Date.now() - startTime;
      this.metrics.recordWebhookDelivery(
        "success",
        payload.event,
        duration,
        job.attemptsMade + 1,
      );
    }

    // Successful subscription deliveries are logged so companies can audit them (#397).
    if (job.data.subscriptionId) {
      await this.recordDelivery(job, {
        status: "SUCCEEDED",
        attempts: job.attemptsMade + 1,
        responseCode,
      });
    }
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job<WebhookJobData>): Promise<void> {
    const maxAttempts = job.opts?.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      // more retries are still scheduled on the backoff schedule
      return;
    }

    const { url, payload } = job.data;
    const startTime = job.data.startTime ?? Date.now();

    this.logger.error(
      `Webhook job ${job.id} to ${url} exhausted all ${job.attemptsMade} attempts: ${job.failedReason}`,
    );

    // Record failed delivery metrics
    if (this.metrics) {
      const duration = Date.now() - startTime;
      this.metrics.recordWebhookDelivery(
        "failure",
        payload.event,
        duration,
        job.attemptsMade,
      );
    }

    await this.recordDelivery(job, {
      status: "FAILED",
      attempts: job.attemptsMade,
      responseCode: job.data.lastResponseCode,
      errorMessage: job.failedReason,
    });
  }

  private async recordDelivery(
    job: Job<WebhookJobData>,
    result: {
      status: "SUCCEEDED" | "FAILED";
      attempts: number;
      responseCode?: number;
      errorMessage?: string;
    },
  ): Promise<void> {
    const { url, payload, userId, subscriptionId } = job.data;
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          userId,
          subscriptionId,
          url,
          event: payload.event,
          payload: payload as any,
          attempts: result.attempts,
          responseCode: result.responseCode ?? null,
          errorMessage: result.errorMessage,
          status: result.status as import('@prisma/client').WebhookDeliveryStatus,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record webhook delivery for job ${job.id}: ${error.message}`,
      );
    }
  }
}
