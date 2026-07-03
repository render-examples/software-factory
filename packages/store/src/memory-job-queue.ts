import { randomUUID } from "node:crypto";
import type {
  JobQueue,
  JobRecord,
  JobStatus,
  EnqueueOptions,
  FailOptions,
} from "./job-queue.js";
import { emptyStatusCounts } from "./job-queue.js";

const DEFAULT_PRIORITY = 100;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * In-memory job queue for local dev (no `DATABASE_URL`) and tests. Behavioral
 * twin of `PgJobQueue`: same claim ordering, idempotent enqueue, requeue/backoff,
 * dead-lettering, and reaper semantics. JS is single-threaded, so `claim`'s
 * select-then-mark critical section is naturally atomic (no `await` within it),
 * which is the in-memory analogue of `FOR UPDATE SKIP LOCKED`.
 */
export class MemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly waiters = new Set<() => void>();

  async enqueue(opts: EnqueueOptions): Promise<JobRecord> {
    const id = opts.id ?? randomUUID();
    // `deliver` jobs are post-processing side-effects, not turn drivers: exempt
    // from the per-run active constraint (so they coexist with the run's active
    // agent/resume job) and idempotent by their explicit id instead.
    if (opts.kind === "deliver") {
      const existing = this.jobs.get(id);
      if (existing) return { ...existing };
    } else {
      // Idempotent per run: an existing active turn job short-circuits a duplicate.
      const active = [...this.jobs.values()].find(
        (j) => j.runId === opts.runId && j.kind !== "deliver" && (j.status === "queued" || j.status === "running"),
      );
      if (active) return { ...active };
    }

    const now = new Date().toISOString();
    const job: JobRecord = {
      id,
      runId: opts.runId,
      kind: opts.kind,
      status: "queued",
      priority: opts.priority ?? DEFAULT_PRIORITY,
      payload: opts.payload,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      availableAt: opts.availableAt ?? now,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.notify();
    return { ...job };
  }

  async claim(workerId: string): Promise<JobRecord | undefined> {
    const now = Date.now();
    // Atomic critical section: select + mark with no intervening await.
    const candidate = [...this.jobs.values()]
      .filter((j) => j.status === "queued" && Date.parse(j.availableAt) <= now)
      .sort(byClaimOrder)[0];
    if (!candidate) return undefined;

    const nowIso = new Date().toISOString();
    candidate.status = "running";
    candidate.attempts += 1;
    candidate.lockedAt = nowIso;
    candidate.lockedBy = workerId;
    candidate.updatedAt = nowIso;
    return { ...candidate };
  }

  async complete(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "done";
    job.lockedAt = undefined;
    job.lockedBy = undefined;
    job.updatedAt = new Date().toISOString();
  }

  async fail(id: string, opts?: FailOptions): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const nowIso = new Date().toISOString();
    job.lastError = opts?.error ?? job.lastError;
    job.lockedAt = undefined;
    job.lockedBy = undefined;
    job.updatedAt = nowIso;

    if (opts?.requeue && job.attempts < job.maxAttempts) {
      job.status = "queued";
      job.availableAt = new Date(Date.now() + (opts.backoffMs ?? 0)).toISOString();
      this.notify();
      return;
    }
    // Requeue requested but budget exhausted → dead-letter; otherwise a
    // deliberate, non-retried failure.
    job.status = opts?.requeue ? "dead" : "failed";
  }

  async reap(staleMs: number): Promise<number> {
    const threshold = Date.now() - staleMs;
    let reaped = 0;
    let requeued = false;
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      if (!job.lockedAt || Date.parse(job.lockedAt) > threshold) continue;
      const nowIso = new Date().toISOString();
      job.lockedAt = undefined;
      job.lockedBy = undefined;
      job.updatedAt = nowIso;
      job.lastError = "reclaimed after visibility timeout";
      if (job.attempts >= job.maxAttempts) {
        job.status = "dead"; // crash-looped past the delivery budget
      } else {
        job.status = "queued";
        job.availableAt = nowIso;
        requeued = true;
      }
      reaped += 1;
    }
    if (requeued) this.notify();
    return reaped;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async countByStatus(): Promise<Record<JobStatus, number>> {
    const counts = emptyStatusCounts();
    for (const job of this.jobs.values()) counts[job.status] += 1;
    return counts;
  }

  tail(signal: AbortSignal): AsyncIterable<void> {
    const waiters = this.waiters;
    async function* generator(): AsyncGenerator<void> {
      if (signal.aborted) return;
      let pending = 0;
      let wake: (() => void) | null = null;
      const signalWaiter = () => { pending += 1; wake?.(); };
      waiters.add(signalWaiter);
      const onAbort = () => wake?.();
      signal.addEventListener("abort", onAbort);
      try {
        while (!signal.aborted) {
          while (pending > 0) {
            pending -= 1;
            yield;
          }
          if (signal.aborted) return;
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
        }
      } finally {
        waiters.delete(signalWaiter);
        signal.removeEventListener("abort", onAbort);
      }
    }
    return generator();
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }
}

/** Claim ordering: lowest priority first, then oldest availability, then oldest creation. */
function byClaimOrder(a: JobRecord, b: JobRecord): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.availableAt !== b.availableAt) return a.availableAt < b.availableAt ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return 0;
}
