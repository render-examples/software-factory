import pg from "pg";
import type { Pool, PoolClient } from "pg";
import type {
  EventLogStore,
  EventInterceptor,
  RunEvent,
  RunEventRecord,
  ToolResult,
} from "../events.js";
import { EventRejectedError } from "../memory-store.js";
import type { Message } from "../messages.js";
import type { RunStore, RunRecord, SpanRecord, ListRunsOptions, ListApprovalsOptions } from "../run-store.js";
import type { ApprovalProjectionRecord } from "../projections.js";
import type { Thread, ThreadMessage, ThreadStore } from "../thread-store.js";
import { categoryOf } from "../categories.js";
import { idempotencyKey } from "../idempotency.js";
import { applyMigrations } from "./migrations.js";
import { createPool, type PoolConfig } from "./db.js";

const NOTIFY_CHANNEL = "run_events";

/**
 * Postgres-backed event log. `append` is a single transaction that:
 * 1. Assigns a gap-free seq via `next_event_seq(run_id)`
 * 2. Inserts the event into `run_events`
 * 3. Upserts affected projections (runs, spans, tool_calls, run_messages, etc.)
 * 4. NOTIFY's the stream with a pointer payload `{ runId, seq }`
 */
export class PgEventLogStore implements EventLogStore {
  private interceptor?: EventInterceptor;

  constructor(private readonly pool: Pool) {}

  setInterceptor(interceptor?: EventInterceptor): void {
    this.interceptor = interceptor;
  }

  async append(record: RunEventRecord): Promise<void> {
    let payload: RunEvent = record.payload;
    if (this.interceptor) {
      const res = await this.interceptor.intercept(payload, {
        runId: record.runId,
        agentName: record.agentName,
      });
      if (res.action === "reject") throw new EventRejectedError(res.reason);
      if (res.event) payload = res.event;
    }
    record = { ...record, payload, type: payload.type, category: categoryOf(payload.type) };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Ensure the run row exists (FK target for run_events).
      // Uses an ON CONFLICT no-op so it's safe to call on every append.
      await client.query(
        `INSERT INTO runs (id, workflow, status, started_at)
         VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (id) DO NOTHING`,
        [record.runId, record.agentName ?? "", record.ts],
      );

      // Assign gap-free seq
      const seqRes = await client.query<{ next_event_seq: string }>(
        "SELECT next_event_seq($1) AS next_event_seq",
        [record.runId],
      );
      const seq = Number(seqRes.rows[0]?.next_event_seq ?? 1);

      const category = categoryOf(record.payload.type);
      const stored: RunEventRecord = {
        ...record,
        seq,
        category,
        type: record.payload.type,
      };

      // Insert canonical event
      await client.query(
        `INSERT INTO run_events (id, run_id, seq, ts, category, type, agent_name, span_id, parent_span_id, payload, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          stored.id,
          stored.runId,
          stored.seq,
          stored.ts,
          stored.category,
          stored.type,
          stored.agentName ?? null,
          stored.spanId ?? null,
          stored.parentSpanId ?? null,
          JSON.stringify(stored.payload),
          stored.version,
        ],
      );

      // Fold projections within same transaction
      await this.foldRuns(client, stored);
      await this.foldSpans(client, stored);
      await this.foldToolCalls(client, stored);
      await this.foldRunMessages(client, stored);
      await this.foldWorkflowSteps(client, stored);
      await this.foldApprovals(client, stored);
      await this.foldThreadMessages(client, stored);

      // Pointer NOTIFY (small payload, avoids 8KB limit)
      await client.query(
        `SELECT pg_notify($1, $2)`,
        [NOTIFY_CHANNEL, JSON.stringify({ runId: stored.runId, seq })],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async read(runId: string, fromSeq?: number): Promise<RunEventRecord[]> {
    const params: unknown[] = [runId];
    let where = "run_id = $1";
    if (fromSeq !== undefined) {
      where += " AND seq >= $2";
      params.push(fromSeq);
    }
    const res = await this.pool.query<PgEventRow>(
      `SELECT id, run_id, seq, ts, category, type, agent_name, span_id, parent_span_id, payload, version
       FROM run_events WHERE ${where} ORDER BY seq`,
      params,
    );
    return res.rows.map(mapEventRow);
  }

  tail(
    filter: { runId?: string; threadId?: string },
    signal: AbortSignal,
  ): AsyncIterable<RunEventRecord> {
    const pool = this.pool;
    const readEvent = async (runId: string, seq: number): Promise<RunEventRecord | null> => {
      const res = await pool.query<PgEventRow>(
        `SELECT id, run_id, seq, ts, category, type, agent_name, span_id, parent_span_id, payload, version
         FROM run_events WHERE run_id = $1 AND seq = $2`,
        [runId, seq],
      );
      return res.rows.length > 0 ? mapEventRow(res.rows[0]) : null;
    };

    const matchesFilter = async (runId: string): Promise<boolean> => {
      if (!filter.runId && !filter.threadId) return true;
      if (filter.runId && filter.runId === runId) return true;
      if (filter.threadId) {
        const res = await pool.query<{ thread_id: string | null }>(
          "SELECT thread_id FROM runs WHERE id = $1",
          [runId],
        );
        return res.rows[0]?.thread_id === filter.threadId;
      }
      return false;
    };

    async function* generator(): AsyncGenerator<RunEventRecord> {
      // Dedicated client for LISTEN — must not be returned to pool until done
      const listenClient = await pool.connect();
      try {
        await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);

        const queue: Array<{ runId: string; seq: number }> = [];
        let resolve: (() => void) | null = null;

        const onNotification = (msg: pg.Notification) => {
          if (!msg.payload) return;
          try {
            const pointer = JSON.parse(msg.payload) as { runId: string; seq: number };
            queue.push(pointer);
            resolve?.();
          } catch {
            // ignore malformed notifications
          }
        };

        listenClient.on("notification", onNotification);
        const onAbort = () => {
          resolve?.();
        };
        signal.addEventListener("abort", onAbort);

        try {
          while (!signal.aborted) {
            // Drain queue
            let pointer = queue.shift();
            while (pointer !== undefined) {
              if (await matchesFilter(pointer.runId)) {
                const event = await readEvent(pointer.runId, pointer.seq);
                if (event) yield event;
              }
              pointer = queue.shift();
            }
            if (signal.aborted) return;
            // Wait for next notification
            await new Promise<void>((r) => { resolve = r; });
            resolve = null;
          }
        } finally {
          signal.removeEventListener("abort", onAbort);
          listenClient.removeListener("notification", onNotification);
          await listenClient.query(`UNLISTEN ${NOTIFY_CHANNEL}`).catch(() => {});
        }
      } finally {
        listenClient.release();
      }
    }

    return generator();
  }

  // --- Projection folds (SQL upserts within the append transaction) ---

  private async foldRuns(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    switch (p.type) {
      case "run.started":
        await client.query(
          `INSERT INTO runs (id, workflow, status, input, trigger, started_at, thread_id, user_id, agent_version)
           VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             status = 'running', input = EXCLUDED.input, trigger = EXCLUDED.trigger,
             started_at = EXCLUDED.started_at, workflow = EXCLUDED.workflow,
             thread_id = COALESCE(EXCLUDED.thread_id, runs.thread_id),
             user_id = COALESCE(EXCLUDED.user_id, runs.user_id),
             agent_version = COALESCE(EXCLUDED.agent_version, runs.agent_version)`,
          [
            rec.runId,
            rec.agentName ?? "",
            p.input !== undefined ? JSON.stringify(p.input) : null,
            p.trigger ?? null,
            rec.ts,
            p.threadId ?? null,
            p.userId ?? null,
            p.agentVersion ?? null,
          ],
        );
        break;

      case "run.completed":
        await client.query(
          `UPDATE runs SET status = 'completed', result = $2, finished_at = $3 WHERE id = $1`,
          [rec.runId, p.result !== undefined ? JSON.stringify(p.result) : null, rec.ts],
        );
        break;

      case "run.failed":
        await client.query(
          `UPDATE runs SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1`,
          [rec.runId, p.error, rec.ts],
        );
        break;

      case "run.paused":
        await client.query(`UPDATE runs SET status = 'paused' WHERE id = $1`, [rec.runId]);
        break;

      case "run.cancelled":
        await client.query(
          `UPDATE runs SET status = 'cancelled', finished_at = $2 WHERE id = $1`,
          [rec.runId, rec.ts],
        );
        break;

      case "llm.call":
        // Round to 1e-12 to match the in-memory fold and keep parity stable.
        await client.query(
          `UPDATE runs SET total_cost_usd = round((total_cost_usd + $2)::numeric, 12) WHERE id = $1`,
          [rec.runId, p.costUsd],
        );
        break;
    }
  }

  private async foldSpans(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const spanId = rec.spanId;
    if (!spanId) return;
    const p = rec.payload;

    switch (p.type) {
      case "run.started":
        await client.query(
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, input, started_at)
           VALUES ($1, $2, $3, $4, $5, 'agent', 'running', $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, rec.agentName ?? "run", p.input !== undefined ? JSON.stringify(p.input) : null, rec.ts],
        );
        break;

      case "run.completed":
        await client.query(
          `UPDATE spans SET status = 'ok', output = $2, finished_at = $3 WHERE id = $1`,
          [spanId, p.result !== undefined ? JSON.stringify(p.result) : null, rec.ts],
        );
        break;

      case "run.failed":
        await client.query(
          `UPDATE spans SET status = 'error', error = $2, finished_at = $3 WHERE id = $1`,
          [spanId, p.error, rec.ts],
        );
        break;

      case "run.cancelled":
        await client.query(
          `UPDATE spans SET status = 'error', error = 'cancelled', finished_at = $2 WHERE id = $1`,
          [spanId, rec.ts],
        );
        break;

      case "tool.called":
        await client.query(
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, input, started_at)
           VALUES ($1, $2, $3, $4, $5, 'tool', 'running', $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, p.name, p.input !== undefined ? JSON.stringify(p.input) : null, rec.ts],
        );
        break;

      case "tool.result":
        if (p.result.isError) {
          await client.query(
            `UPDATE spans SET status = 'error', error = $2, finished_at = $3 WHERE id = $1`,
            [spanId, p.result.content, rec.ts],
          );
        } else {
          await client.query(
            `UPDATE spans SET status = 'ok', output = $2, finished_at = $3 WHERE id = $1`,
            [spanId, JSON.stringify(p.result.content), rec.ts],
          );
        }
        break;

      case "step.started":
        await client.query(
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, started_at)
           VALUES ($1, $2, $3, $4, $5, 'step', 'running', $6)
           ON CONFLICT (id) DO NOTHING`,
          [spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, p.name, rec.ts],
        );
        break;

      case "step.completed":
        await client.query(
          `UPDATE spans SET status = 'ok', output = $2, finished_at = $3 WHERE id = $1`,
          [spanId, p.result !== undefined ? JSON.stringify(p.result) : null, rec.ts],
        );
        break;

      case "llm.call":
        await client.query(
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, attributes, started_at, finished_at)
           VALUES ($1, $2, $3, $4, $5, 'llm', 'ok', $6, $7, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, p.model,
            JSON.stringify({ usage: p.usage, costUsd: p.costUsd, stopReason: p.stopReason, latencyMs: p.latencyMs }),
            rec.ts,
          ],
        );
        break;
    }
  }

  private async foldToolCalls(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    switch (p.type) {
      case "tool.called": {
        const idemKey = idempotencyKey(rec.runId, p.toolCallId);
        await client.query(
          `INSERT INTO tool_calls (id, run_id, idempotency_key, tool_name, input, status, started_at)
           VALUES ($1, $2, $3, $4, $5, 'running', $6)
           ON CONFLICT (run_id, idempotency_key) DO NOTHING`,
          [p.toolCallId, rec.runId, idemKey, p.name, JSON.stringify(p.input), rec.ts],
        );
        break;
      }
      case "tool.result":
        await client.query(
          `UPDATE tool_calls SET
             result_content = $2, result_is_error = $3,
             status = CASE WHEN $3 THEN 'failed' ELSE 'completed' END,
             finished_at = $4
           WHERE id = $1`,
          [p.toolCallId, p.result.content, p.result.isError ?? false, rec.ts],
        );
        break;
    }
  }

  private async foldRunMessages(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    let role: string | undefined;
    let content: unknown;
    let agentName: string | undefined;

    switch (p.type) {
      case "message.user":
        role = "user";
        content = p.content;
        break;
      case "message.assistant":
        role = "assistant";
        content = p.content;
        agentName = p.agentName;
        break;
      case "message.tool":
        role = "tool";
        content = p.content;
        agentName = p.agentName;
        break;
      default:
        return;
    }

    await client.query(
      `INSERT INTO run_messages (id, run_id, agent_name, seq, role, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [rec.id, rec.runId, agentName ?? "", rec.seq, role, JSON.stringify(content), rec.ts],
    );
  }

  private async foldWorkflowSteps(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    if (p.type !== "step.completed") return;
    await client.query(
      `INSERT INTO workflow_steps (run_id, name, result, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id, name) DO NOTHING`,
      [rec.runId, p.name, JSON.stringify(p.result), rec.ts],
    );
  }

  private async foldApprovals(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    switch (p.type) {
      case "approval.requested":
        await client.query(
          `INSERT INTO approval_requests (id, run_id, tool_name, tool_input, agent_name, status, requested_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6)
           ON CONFLICT (id) DO NOTHING`,
          [
            p.approvalRequestId, rec.runId, p.toolName,
            JSON.stringify(p.input), rec.agentName ?? "", rec.ts,
          ],
        );
        break;
      case "approval.resolved":
        await client.query(
          `UPDATE approval_requests SET
             status = CASE WHEN $2 THEN 'approved' ELSE 'denied' END,
             resolved_at = $3, resolved_by = $4, reason = $5
           WHERE id = $1`,
          [p.approvalRequestId, p.approved, rec.ts, p.resolvedBy ?? null, p.reason ?? null],
        );
        break;
    }
  }

  private async foldThreadMessages(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    if (p.type !== "message.user" && p.type !== "message.assistant") return;

    // Thread messages require a thread_id on the run. Look it up.
    const runRes = await client.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM runs WHERE id = $1",
      [rec.runId],
    );
    const threadId = runRes.rows[0]?.thread_id;
    if (!threadId) return;

    // Flatten content blocks to plain text for the human-facing transcript
    const contentText = flattenContent(p.content);

    await client.query(
      `INSERT INTO messages (run_id, seq, thread_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id, seq) DO NOTHING`,
      [rec.runId, rec.seq, threadId, p.type === "message.user" ? "user" : "assistant", contentText, rec.ts],
    );
  }
}

// --- Postgres RunStore implementation ---

export class PgRunStore implements RunStore, ThreadStore {
  private readonly pool: Pool;
  readonly events: PgEventLogStore;

  constructor(config: PoolConfig) {
    this.pool = createPool(config);
    this.events = new PgEventLogStore(this.pool);
  }

  async init(): Promise<void> {
    await applyMigrations(this.pool);
  }

  setInterceptor(interceptor?: EventInterceptor): void {
    this.events.setInterceptor(interceptor);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const res = await this.pool.query<PgRunRow>(
      `SELECT id, workflow, status, input, result, error, trigger, total_cost_usd,
              thread_id, user_id, agent_version, started_at, finished_at
       FROM runs WHERE id = $1`,
      [id],
    );
    return res.rows.length > 0 ? mapRunRow(res.rows[0]) : undefined;
  }

  async listRuns(opts?: ListRunsOptions): Promise<RunRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts?.workflow) {
      conditions.push(`workflow = $${paramIdx++}`);
      params.push(opts.workflow);
    }
    if (opts?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(opts.status);
    }
    if (opts?.threadId) {
      conditions.push(`thread_id = $${paramIdx++}`);
      params.push(opts.threadId);
    }
    if (opts?.before) {
      // Keyset pagination: runs started before the cursor run's started_at
      conditions.push(`started_at < (SELECT started_at FROM runs WHERE id = $${paramIdx++})`);
      params.push(opts.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // Parity with the in-memory store: no limit ⇒ return all matching runs.
    const limitClause = opts?.limit !== undefined ? `LIMIT $${paramIdx}` : "";
    const finalParams = opts?.limit !== undefined ? [...params, opts.limit] : params;

    const res = await this.pool.query<PgRunRow>(
      `SELECT id, workflow, status, input, result, error, trigger, total_cost_usd,
              thread_id, user_id, agent_version, started_at, finished_at
       FROM runs ${where}
       ORDER BY started_at DESC, id DESC
       ${limitClause}`,
      finalParams,
    );
    return res.rows.map(mapRunRow);
  }

  async getMessages(runId: string, agentName: string): Promise<Message[]> {
    const res = await this.pool.query<{ role: string; content: unknown }>(
      `SELECT role, content FROM run_messages
       WHERE run_id = $1 AND (agent_name = $2 OR agent_name = '')
       ORDER BY seq`,
      [runId, agentName],
    );
    return res.rows.map((row) => ({
      role: row.role as Message["role"],
      content: coerceJson(row.content) as Message["content"],
    }));
  }

  async listSpans(runId: string): Promise<SpanRecord[]> {
    const res = await this.pool.query<PgSpanRow>(
      `SELECT id, run_id, parent_id, seq, name, kind, status, input, output, error, attributes, started_at, finished_at
       FROM spans WHERE run_id = $1 ORDER BY seq`,
      [runId],
    );
    return res.rows.map(mapSpanRow);
  }

  async getStepResult(runId: string, name: string): Promise<{ value: unknown } | undefined> {
    const res = await this.pool.query<{ result: unknown }>(
      `SELECT result FROM workflow_steps WHERE run_id = $1 AND name = $2`,
      [runId, name],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return { value: row.result != null ? coerceJson(row.result) : null };
  }

  async getToolResult(runId: string, toolCallId: string): Promise<ToolResult | undefined> {
    const idemKey = idempotencyKey(runId, toolCallId);
    const res = await this.pool.query<{ result_content: string | null; result_is_error: boolean }>(
      `SELECT result_content, result_is_error FROM tool_calls
       WHERE run_id = $1 AND idempotency_key = $2 AND status IN ('completed', 'failed')`,
      [runId, idemKey],
    );
    const row = res.rows[0];
    if (!row || row.result_content === null) return undefined;
    return {
      content: row.result_content,
      isError: row.result_is_error || undefined,
    };
  }

  async getApprovals(runId: string): Promise<ApprovalProjectionRecord[]> {
    const res = await this.pool.query<PgApprovalRow>(
      `SELECT id, run_id, tool_name, tool_input, agent_name, status, requested_at, resolved_at, resolved_by, reason
       FROM approval_requests WHERE run_id = $1 ORDER BY requested_at`,
      [runId],
    );
    return res.rows.map(mapApprovalRow);
  }

  async listApprovals(opts?: ListApprovalsOptions): Promise<ApprovalProjectionRecord[]> {
    const params: unknown[] = [];
    let where = "";
    if (opts?.status) {
      params.push(opts.status);
      where = `WHERE status = $${params.length}`;
    }
    const limitClause = opts?.limit !== undefined ? `LIMIT $${params.length + 1}` : "";
    if (opts?.limit !== undefined) params.push(opts.limit);
    const res = await this.pool.query<PgApprovalRow>(
      `SELECT id, run_id, tool_name, tool_input, agent_name, status, requested_at, resolved_at, resolved_by, reason
       FROM approval_requests ${where} ORDER BY requested_at DESC ${limitClause}`,
      params,
    );
    return res.rows.map(mapApprovalRow);
  }

  // --- ThreadStore (metadata in `threads`; transcript in `messages`) ---

  async createThread(thread: Thread): Promise<void> {
    await this.pool.query(
      `INSERT INTO threads (id, user_id, metadata, status, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        thread.id, thread.userId ?? null,
        thread.metadata !== undefined ? JSON.stringify(thread.metadata) : null,
        thread.status, thread.title ?? null, thread.createdAt, thread.updatedAt,
      ],
    );
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const res = await this.pool.query<PgThreadRow>(
      `SELECT id, user_id, metadata, status, title, created_at, updated_at FROM threads WHERE id = $1`,
      [id],
    );
    return res.rows.length > 0 ? mapThreadRow(res.rows[0]) : undefined;
  }

  async updateThread(id: string, patch: Partial<Thread>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.userId !== undefined) add("user_id", patch.userId);
    if (patch.metadata !== undefined) add("metadata", JSON.stringify(patch.metadata));
    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);
    if (sets.length === 1) return; // only updated_at → nothing meaningful
    await this.pool.query(`UPDATE threads SET ${sets.join(", ")} WHERE id = $1`, params);
  }

  async listThreads(opts?: { userId?: string }): Promise<Thread[]> {
    const params: unknown[] = [];
    let where = "";
    if (opts?.userId) {
      params.push(opts.userId);
      where = `WHERE user_id = $1`;
    }
    const res = await this.pool.query<PgThreadRow>(
      `SELECT id, user_id, metadata, status, title, created_at, updated_at
       FROM threads ${where} ORDER BY created_at DESC`,
      params,
    );
    return res.rows.map(mapThreadRow);
  }

  async getThreadMessages(threadId: string): Promise<ThreadMessage[]> {
    const res = await this.pool.query<PgMessageRow>(
      `SELECT run_id, seq, thread_id, role, content, created_at
       FROM messages WHERE thread_id = $1 ORDER BY run_id, seq`,
      [threadId],
    );
    return res.rows.map(mapMessageRow);
  }
}

// --- Row types and mappers ---

interface PgEventRow {
  id: string;
  run_id: string;
  seq: string;
  ts: Date;
  category: string;
  type: string;
  agent_name: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  payload: RunEvent;
  version: number;
}

interface PgRunRow {
  id: string;
  workflow: string;
  status: string;
  input: unknown;
  result: unknown;
  error: string | null;
  trigger: string | null;
  total_cost_usd: string;
  thread_id: string | null;
  user_id: string | null;
  agent_version: string | null;
  started_at: Date;
  finished_at: Date | null;
}

interface PgApprovalRow {
  id: string;
  run_id: string;
  tool_name: string;
  tool_input: unknown;
  agent_name: string | null;
  status: string;
  requested_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  reason: string | null;
}

interface PgSpanRow {
  id: string;
  run_id: string;
  parent_id: string | null;
  seq: number;
  name: string;
  kind: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  attributes: unknown;
  started_at: Date;
  finished_at: Date | null;
}

function mapEventRow(row: PgEventRow): RunEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    seq: Number(row.seq),
    ts: row.ts.toISOString(),
    category: row.category as RunEventRecord["category"],
    type: row.type as RunEvent["type"],
    agentName: row.agent_name ?? undefined,
    spanId: row.span_id ?? undefined,
    parentSpanId: row.parent_span_id ?? undefined,
    payload: row.payload,
    version: row.version,
  };
}

function mapRunRow(row: PgRunRow): RunRecord {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status as RunRecord["status"],
    input: row.input ?? undefined,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    trigger: row.trigger ?? undefined,
    totalCostUsd: Number(row.total_cost_usd),
    threadId: row.thread_id ?? undefined,
    userId: row.user_id ?? undefined,
    agentVersion: row.agent_version ?? undefined,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
  };
}

interface PgThreadRow {
  id: string;
  user_id: string | null;
  metadata: unknown;
  status: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

interface PgMessageRow {
  run_id: string;
  seq: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: Date;
}

function mapThreadRow(row: PgThreadRow): Thread {
  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    metadata: (coerceJson(row.metadata) as Record<string, unknown>) ?? undefined,
    status: row.status as Thread["status"],
    title: row.title ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapMessageRow(row: PgMessageRow): ThreadMessage {
  return {
    id: `${row.run_id}:${row.seq}`,
    threadId: row.thread_id,
    runId: row.run_id,
    seq: Number(row.seq),
    role: row.role as ThreadMessage["role"],
    content: row.content,
    createdAt: row.created_at.toISOString(),
  };
}

function mapApprovalRow(row: PgApprovalRow): ApprovalProjectionRecord {
  return {
    approvalRequestId: row.id,
    runId: row.run_id,
    toolName: row.tool_name,
    input: coerceJson(row.tool_input),
    agentName: row.agent_name ?? undefined,
    status: row.status as ApprovalProjectionRecord["status"],
    requestedAt: row.requested_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString(),
    resolvedBy: row.resolved_by ?? undefined,
    reason: row.reason ?? undefined,
  };
}

function mapSpanRow(row: PgSpanRow): SpanRecord {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id ?? undefined,
    seq: row.seq,
    name: row.name,
    kind: row.kind as SpanRecord["kind"],
    status: row.status as SpanRecord["status"],
    input: row.input ?? undefined,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    attributes: (row.attributes as Record<string, unknown>) ?? undefined,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
  };
}

/**
 * node-pg parses `json`/`jsonb` columns into JS values by default, so a column
 * read normally arrives already-parsed. Guard against environments that disable
 * the default parsers (returning raw text) by parsing strings on demand.
 */
function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((b): b is { type: string; text: string } => b.type === "text" && b.text !== undefined)
    .map((b) => b.text)
    .join("\n");
}

export function createPgStore(config?: PoolConfig): PgRunStore {
  const connectionString = config?.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("createPgStore: DATABASE_URL is not set and no connectionString was provided");
  }
  return new PgRunStore({ connectionString, ...config });
}
