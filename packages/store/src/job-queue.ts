/**
 * The durable job queue (control plane). A job is a POINTER to a run plus a
 * `kind` telling the runner what to do with it; run identity/input live in the
 * event log. The gateway enqueues; a runner claims via an atomic
 * `SELECT ... FOR UPDATE SKIP LOCKED` (Postgres) or in-process critical
 * section (memory) and drives the root run / resume.
 *
 * `maxAttempts` is the *delivery* (crash-loop) budget, not a workflow
 * logic-retry count. On a terminal run.failed/completed/cancelled the runner
 * calls `complete()` (never `fail({ requeue })`), so a genuinely failed
 * handler is never re-driven — only an interrupted run is, idempotently.
 */

/**
 * What a claimed job tells the warm chat worker (Lane B) to drive. Durable
 * pipelines (Lane A) don't use `run_jobs` — Render Workflows is their queue.
 * - `agent`   — one interactive chat turn (new run per message).
 * - `resume`  — re-drive a paused chat run after HITL resolves.
 * - `deliver` — push a completed channel-bound run's reply to its surface.
 */
export type JobKind = "agent" | "resume" | "deliver";

export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";

export interface JobRecord {
  id: string;
  runId: string;
  kind: JobKind;
  status: JobStatus;
  /** Lower runs sooner. Default 100 (interactive turns < batch cron). */
  priority: number;
  /** Forward-flex pointer payload: target name, plan, identity. */
  payload?: Record<string, unknown>;
  /** Number of times this job has been claimed. */
  attempts: number;
  /** Delivery/crash-loop budget. Exhausted claims dead-letter. */
  maxAttempts: number;
  /** ISO timestamp; the job is only claimable once `availableAt <= now`. */
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueOptions {
  runId: string;
  kind: JobKind;
  /** Default 100. */
  priority?: number;
  payload?: Record<string, unknown>;
  /** Delivery budget. Default 5. */
  maxAttempts?: number;
  /** Delay availability (e.g. scheduled wake). Default: now. */
  availableAt?: string;
  /** Explicit id (else generated). */
  id?: string;
}

export interface FailOptions {
  /** Requeue for another attempt (subject to `maxAttempts`). Default false. */
  requeue?: boolean;
  /** Delay before a requeued job becomes available, in ms. Default 0. */
  backoffMs?: number;
  /** Error message recorded on the job for diagnostics. */
  error?: string;
}

export interface JobQueue {
  /**
   * Enqueue a job. Idempotent per run: if the run already has an active
   * (queued/running) job, the existing job is returned unchanged rather than a
   * duplicate created (duplicate triggers are benign no-ops).
   */
  enqueue(opts: EnqueueOptions): Promise<JobRecord>;

  /**
   * Atomically claim the next available job (lowest priority, then oldest
   * `availableAt`), marking it `running` and incrementing `attempts`. Returns
   * `undefined` when nothing is claimable. Concurrent claimers never receive the
   * same job.
   */
  claim(workerId: string): Promise<JobRecord | undefined>;

  /** Mark a claimed job `done`. */
  complete(id: string): Promise<void>;

  /**
   * Report a claimed job as failed. Requeues with backoff when `requeue` is set
   * and the delivery budget remains; otherwise marks the job `failed`
   * (deliberate, no retry) or `dead` (budget exhausted while requeueing).
   */
  fail(id: string, opts?: FailOptions): Promise<void>;

  /**
   * Reclaim jobs stuck in `running` past the visibility timeout (a crashed
   * runner). Stale jobs with delivery budget remaining return to `queued`;
   * those that have exhausted it are dead-lettered. Returns the number of jobs
   * transitioned.
   */
  reap(staleMs: number): Promise<number>;

  /** Fetch a job by id (inspection / tests). */
  get(id: string): Promise<JobRecord | undefined>;

  /** Count jobs grouped by status (queue-depth metric). */
  countByStatus(): Promise<Record<JobStatus, number>>;

  /**
   * Yield a tick whenever a job is enqueued, so an idle runner can claim
   * immediately instead of polling. Backed by `LISTEN/NOTIFY` (Postgres) or an
   * in-process signal (memory). Always pair with a poll fallback to cover
   * delayed/backoff jobs and missed notifications.
   */
  tail(signal: AbortSignal): AsyncIterable<void>;
}

/** Zeroed status tally (so callers always get every key). */
export function emptyStatusCounts(): Record<JobStatus, number> {
  return { queued: 0, running: 0, done: 0, failed: 0, dead: 0 };
}
