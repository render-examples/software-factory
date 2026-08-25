import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  CommandStore,
  CommandRecord,
  CommandStatus,
  EnqueueCommandOptions,
  FailCommandOptions,
} from "../command-store.js";
import { LeaseLostError } from "../command-store.js";

const COLS =
  "id, kind, status, payload, attempts, max_attempts, lease_token, dedupe_key, correlation_id, available_at, locked_at, locked_by, last_error, created_at, updated_at";

export class PgCommandStore implements CommandStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error("PgCommandStore requires a tenantId");
  }

  async enqueue(opts: EnqueueCommandOptions): Promise<CommandRecord> {
    const id = opts.id ?? randomUUID();
    const payload = JSON.stringify(opts.payload ?? {});

    const res = await this.pool.query<PgCommandRow>(
      `INSERT INTO commands (id, tenant_id, kind, payload, max_attempts, available_at, dedupe_key, correlation_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::timestamptz, now()), $7, $8)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING ${COLS}`,
      [id, this.tenantId, opts.kind, payload, opts.maxAttempts ?? 5, opts.availableAt ?? null, opts.dedupeKey ?? null, opts.correlationId ?? null],
    );

    if (res.rows.length > 0) return mapRow(res.rows[0]);

    // Dedupe hit — return existing
    const existing = await this.pool.query<PgCommandRow>(
      `SELECT ${COLS} FROM commands WHERE tenant_id = $1 AND dedupe_key = $2`,
      [this.tenantId, opts.dedupeKey],
    );
    return mapRow(existing.rows[0]);
  }

  async claim(workerId: string): Promise<CommandRecord | undefined> {
    const leaseToken = randomUUID();
    const res = await this.pool.query<PgCommandRow>(
      `UPDATE commands SET
         status = 'running', locked_at = now(), locked_by = $1,
         lease_token = $3, attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM commands
         WHERE tenant_id = $2 AND status = 'queued' AND available_at <= now()
         ORDER BY available_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLS}`,
      [workerId, this.tenantId, leaseToken],
    );
    return res.rows.length > 0 ? mapRow(res.rows[0]) : undefined;
  }

  async complete(id: string, leaseToken: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE commands SET status = 'done', lease_token = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND lease_token = $3`,
      [id, this.tenantId, leaseToken],
    );
    if ((res.rowCount ?? 0) === 0) throw new LeaseLostError(id);
  }

  async fail(id: string, leaseToken: string, opts?: FailCommandOptions): Promise<void> {
    const requeue = opts?.requeue ?? false;
    const backoffMs = opts?.backoffMs ?? 0;
    const res = await this.pool.query(
      `UPDATE commands SET
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
         lease_token = NULL, locked_at = NULL, locked_by = NULL,
         updated_at = now()
       WHERE id = $1 AND tenant_id = $5 AND lease_token = $6`,
      [id, requeue, backoffMs, opts?.error ?? null, this.tenantId, leaseToken],
    );
    if ((res.rowCount ?? 0) === 0) throw new LeaseLostError(id);
  }

  async heartbeat(id: string, leaseToken: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE commands SET locked_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND lease_token = $3 AND status = 'running'`,
      [id, this.tenantId, leaseToken],
    );
    if ((res.rowCount ?? 0) === 0) throw new LeaseLostError(id);
  }

  async reap(staleMs: number): Promise<number> {
    const res = await this.pool.query(
      `UPDATE commands SET
         status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
         available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE now() END,
         lease_token = NULL, locked_at = NULL, locked_by = NULL,
         last_error = 'reclaimed after visibility timeout',
         updated_at = now()
       WHERE tenant_id = $1
         AND status = 'running'
         AND locked_at < now() - make_interval(secs => $2::double precision / 1000.0)`,
      [this.tenantId, staleMs],
    );
    return res.rowCount ?? 0;
  }

  async get(id: string): Promise<CommandRecord | undefined> {
    const res = await this.pool.query<PgCommandRow>(
      `SELECT ${COLS} FROM commands WHERE id = $1 AND tenant_id = $2`,
      [id, this.tenantId],
    );
    return res.rows.length > 0 ? mapRow(res.rows[0]) : undefined;
  }
}

interface PgCommandRow {
  id: string;
  kind: string;
  status: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  dedupe_key: string | null;
  correlation_id: string | null;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: PgCommandRow): CommandRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as CommandStatus,
    payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload ?? {}) as Record<string, unknown>,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    availableAt: row.available_at.toISOString(),
    lockedAt: row.locked_at?.toISOString(),
    lockedBy: row.locked_by ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
