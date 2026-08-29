import type { InboundStore, ConversationJob } from "@render-factory/store";

export interface InboundWorkerOptions {
  store: InboundStore;
  /** Unique id for this worker instance (used as locked_by). */
  workerId: string;
  /** Handler invoked for each claimed job. The conversation lock is held for the duration. */
  handleJob: (job: ConversationJob, message: { input: unknown; userId?: string; threadId?: string }) => Promise<void>;
  /** Poll interval when queue is empty (ms). Default 1000. */
  pollIntervalMs?: number;
  /** How often to send heartbeats during processing (ms). Default 30000. */
  heartbeatIntervalMs?: number;
  /** Jobs locked longer than this are reaped (ms). Default 300000 (5 min). */
  staleThresholdMs?: number;
  /** Max concurrent jobs. Default 5. */
  concurrency?: number;
}

/**
 * Polls `conversation_jobs` for queued work, claims a job, acquires the
 * conversation advisory lock (serializing multiple messages on the same
 * thread), then invokes the handler. On success marks job complete; on
 * failure retries up to max_attempts.
 */
export class InboundWorker {
  private readonly store: InboundStore;
  private readonly workerId: string;
  private readonly handleJob: InboundWorkerOptions["handleJob"];
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly concurrency: number;

  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private activeJobs = 0;
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: InboundWorkerOptions) {
    this.store = opts.store;
    this.workerId = opts.workerId;
    this.handleJob = opts.handleJob;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
    this.staleThresholdMs = opts.staleThresholdMs ?? 300_000;
    this.concurrency = opts.concurrency ?? 5;
  }

  // --- Lifecycle ---

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedulePoll(0);
    this.reapTimer = setInterval(() => void this.reap(), this.staleThresholdMs / 2);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    // Wait for in-flight jobs to drain (best effort)
    const deadline = Date.now() + 10_000;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await sleep(200);
    }
  }

  // --- Poll & Dispatch ---

  private schedulePoll(delay: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    while (this.running && this.activeJobs < this.concurrency) {
      const job = await this.store.claimJob(this.workerId);
      if (!job) break;
      this.activeJobs++;
      void this.processJob(job).finally(() => {
        this.activeJobs--;
      });
    }

    this.schedulePoll(this.pollIntervalMs);
  }

  // --- Job Processing ---

  private async processJob(job: ConversationJob): Promise<void> {
    const heartbeat = setInterval(async () => {
      const ok = await this.store.heartbeatJob(job.id, job.leaseToken).catch(() => false);
      if (!ok) clearInterval(heartbeat);
    }, this.heartbeatIntervalMs);

    try {
      const message = await this.store.getMessage(job.messageId);
      if (!message) {
        clearInterval(heartbeat);
        await this.store.failJob(job.id, job.leaseToken, "message not found", false);
        return;
      }

      await this.store.withConversationLock(job.channel, job.conversationId, async () => {
        await this.handleJob(job, {
          input: message.input,
          userId: message.userId,
          threadId: message.threadId,
        });
      });

      clearInterval(heartbeat);
      await this.store.completeJob(job.id, job.leaseToken);
      await this.store.markProcessed(job.messageId);
    } catch (err) {
      clearInterval(heartbeat);
      const retry = job.attempts < 5;
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.store.failJob(job.id, job.leaseToken, errorMsg, retry).catch(() => {});
    }
  }

  // --- Maintenance ---

  private async reap(): Promise<void> {
    const staleBefore = new Date(Date.now() - this.staleThresholdMs);
    const reaped = await this.store.reapJobs(staleBefore).catch(() => 0);
    if (reaped > 0) {
      console.log(`[InboundWorker:${this.workerId}] reaped ${reaped} stale jobs`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
