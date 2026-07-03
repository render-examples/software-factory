import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool } from "pg";
import type {
  JobQueue,
  JobRecord,
  JobStatus,
  EnqueueOptions,
  FailOptions,
} from "../job-queue.js";
import { emptyStatusCounts } from "../job-queue.js";

const NOTIFY_CHANNEL = "run_jobs";
const DEFAULT_PRIORITY = 100;
const DEFAULT_MAX_ATTEMPTS = 5;

const COLS =
  "id, run_id, kind, status, priority, payload, attempts, max_attempts, available_at, locked_at, locked_by, last_error, created_at, updated_at";

/**
 * Postgres-backed job queue. `claim` is a single atomic
 * `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` so
 * concurrent runners never claim the same row. `enqueue` `NOTIFY`s an idle
 * runner's `tail` to wake immediately; a poll fallback (in the runner) covers
 * delayed/backoff jobs and any missed notification.
 */
/** One live `tail()` subscriber: a wake counter fed by the shared listener. */
interface JobTailSub {
  pending: number;
  wake: (() => void) | null;
}

export class PgJobQueue implements JobQueue {
  // One shared `run_jobs` LISTEN connection fans wake signals out to all
  // tail() subscribers, instead of one connection each.
  private tailListenClient: pg.PoolClient | null = null;
  private tailListening: Promise<void> | null = null;
  private readonly tailSubs = new Set<JobTailSub>();

  constructor(private readonly pool: Pool) {}

  private async ensureTailListening(): Promise<void> {
    if (!this.tailListening) {
      this.tailListening = this.connectTailListener().catch((err) => {
        this.tailListening = null;
        this.tailListenClient = null;
        throw err;
      });
    }
    return this.tailListening;
  }

  private async connectTailListener(): Promise<void> {
    const client = await this.pool.connect();
    this.tailListenClient = client;
    client.on("notification", (_msg: pg.Notification) => {
      for (const sub of this.tailSubs) {
        sub.pending += 1;
        sub.wake?.();
      }
    });
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
  }

  private async stopTailListening(): Promise<void> {
    if (this.tailSubs.size > 0) return;
    const client = this.tailListenClient;
    this.tailListenClient = null;
    this.tailListening = null;
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${NOTIFY_CHANNEL}`);
    } catch {
      // ignore — releasing the client drops the LISTEN anyway
    }
    client.release();
  }

  async enqueue(opts: EnqueueOptions): Promise<JobRecord> {
    const id = opts.id ?? randomUUID();
    const payload = opts.payload !== undefined ? JSON.stringify(opts.payload) : null;
    const params = [id, opts.runId, opts.kind, opts.priority ?? DEFAULT_PRIORITY, payload, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, opts.availableAt ?? null];

    // `deliver` jobs are post-processing side-effects, not turn drivers: they are
    // exempt from the per-run active index (so they coexist with the run's active
    // agent/resume job) and are idempotent by their explicit id instead.
    if (opts.kind === "deliver") {
      const res = await this.pool.query<PgJobRow>(
        `INSERT INTO run_jobs (id, run_id, kind, status, priority, payload, attempts, max_attempts, available_at)
         VALUES ($1, $2, $3, 'queued', $4, $5, 0, $6, COALESCE($7::timestamptz, now()))
         ON CONFLICT (id) DO NOTHING
         RETURNING ${COLS}`,
        params,
      );
      if (res.rows.length > 0) {
        await this.notify();
        return mapJobRow(res.rows[0]);
      }
      // A job with this id already exists (duplicate trigger / tail replay) — return it.
      const existing = await this.pool.query<PgJobRow>(`SELECT ${COLS} FROM run_jobs WHERE id = $1`, [id]);
      return mapJobRow(existing.rows[0]);
    }

    // Idempotent per run via the partial unique index on (run_id) WHERE
    // status IN ('queued','running') AND kind <> 'deliver'. A conflicting insert
    // is a no-op; we then return the existing active turn job.
    const res = await this.pool.query<PgJobRow>(
      `INSERT INTO run_jobs (id, run_id, kind, status, priority, payload, attempts, max_attempts, available_at)
       VALUES ($1, $2, $3, 'queued', $4, $5, 0, $6, COALESCE($7::timestamptz, now()))
       ON CONFLICT (run_id) WHERE status IN ('queued', 'running') AND kind <> 'deliver' DO NOTHING
       RETURNING ${COLS}`,
      params,
    );

    if (res.rows.length > 0) {
      await this.notify();
      return mapJobRow(res.rows[0]);
    }

    // Conflict: an active turn job already exists for this run. Return it.
    const existing = await this.pool.query<PgJobRow>(
      `SELECT ${COLS} FROM run_jobs
       WHERE run_id = $1 AND status IN ('queued', 'running') AND kind <> 'deliver'
       ORDER BY created_at LIMIT 1`,
      [opts.runId],
    );
    if (existing.rows.length > 0) return mapJobRow(existing.rows[0]);
    // Extremely narrow race: the conflicting job left the active set between the
    // insert and this read. Retry once.
    return this.enqueue(opts);
  }

  async claim(workerId: string): Promise<JobRecord | undefined> {
    const res = await this.pool.query<PgJobRow>(
      `UPDATE run_jobs SET
         status = 'running', locked_at = now(), locked_by = $1,
         attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM run_jobs
         WHERE status = 'queued' AND available_at <= now()
         ORDER BY priority, available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLS}`,
      [workerId],
    );
    return res.rows.length > 0 ? mapJobRow(res.rows[0]) : undefined;
  }

  async complete(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE run_jobs SET status = 'done', locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async fail(id: string, opts?: FailOptions): Promise<void> {
    const requeue = opts?.requeue ?? false;
    const backoffMs = opts?.backoffMs ?? 0;
    const res = await this.pool.query<{ status: string }>(
      `UPDATE run_jobs SET
         status = CASE
           WHEN $2::boolean AND attempts < max_attempts THEN 'queued'
           WHEN $2::boolean THEN 'dead'
           ELSE 'failed'
         END,
         available_at = CASE
           WHEN $2::boolean AND attempts < max_attempts
             THEN now() + make_interval(secs => $3::double precision / 1000.0)
           ELSE available_at
         END,
         last_error = COALESCE($4, last_error),
         locked_at = NULL, locked_by = NULL,
         updated_at = now()
       WHERE id = $1
       RETURNING status`,
      [id, requeue, backoffMs, opts?.error ?? null],
    );
    if (res.rows[0]?.status === "queued") await this.notify();
  }

  async reap(staleMs: number): Promise<number> {
    const res = await this.pool.query<{ status: string }>(
      `UPDATE run_jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
         available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE now() END,
         locked_at = NULL, locked_by = NULL,
         last_error = 'reclaimed after visibility timeout',
         updated_at = now()
       WHERE status = 'running'
         AND locked_at < now() - make_interval(secs => $1::double precision / 1000.0)
       RETURNING status`,
      [staleMs],
    );
    if (res.rows.some((r) => r.status === "queued")) await this.notify();
    return res.rowCount ?? 0;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const res = await this.pool.query<PgJobRow>(
      `SELECT ${COLS} FROM run_jobs WHERE id = $1`,
      [id],
    );
    return res.rows.length > 0 ? mapJobRow(res.rows[0]) : undefined;
  }

  async countByStatus(): Promise<Record<JobStatus, number>> {
    const res = await this.pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::int AS count FROM run_jobs GROUP BY status`,
    );
    const counts = emptyStatusCounts();
    for (const row of res.rows) {
      if (row.status in counts) counts[row.status as JobStatus] = Number(row.count);
    }
    return counts;
  }

  tail(signal: AbortSignal): AsyncIterable<void> {
    const sub: JobTailSub = { pending: 0, wake: null };
    const subs = this.tailSubs;
    const ensureListening = () => this.ensureTailListening();
    const stopListening = () => this.stopTailListening();

    async function* generator(): AsyncGenerator<void> {
      if (signal.aborted) return;
      subs.add(sub);
      const onAbort = () => sub.wake?.();
      signal.addEventListener("abort", onAbort);
      try {
        await ensureListening();
        while (!signal.aborted) {
          while (sub.pending > 0) {
            sub.pending -= 1;
            yield;
          }
          if (signal.aborted) return;
          await new Promise<void>((resolve) => { sub.wake = resolve; });
          sub.wake = null;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        subs.delete(sub);
        await stopListening();
      }
    }
    return generator();
  }

  private async notify(): Promise<void> {
    await this.pool.query(`SELECT pg_notify($1, '')`, [NOTIFY_CHANNEL]);
  }
}

interface PgJobRow {
  id: string;
  run_id: string;
  kind: string;
  status: string;
  priority: number;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapJobRow(row: PgJobRow): JobRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as JobRecord["kind"],
    status: row.status as JobStatus,
    priority: Number(row.priority),
    payload: coerceJson(row.payload) as Record<string, unknown> | undefined,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at.toISOString(),
    lockedAt: row.locked_at?.toISOString(),
    lockedBy: row.locked_by ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function coerceJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
