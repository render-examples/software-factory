import pg from "pg";
import type { Pool, PoolClient } from "pg";
import type {
  EventLogStore,
  EventInterceptor,
  RunEvent,
  RunEventRecord,
  ToolResult,
} from "../events.js";
import { EventRejectedError, buildEventRecord } from "../memory-store.js";
import type { Message } from "../messages.js";
import type { RunStore, RunRecord, SpanRecord, ListRunsOptions, ListInputsOptions, RetentionOptions, RetentionResult, ReapOptions, ReapResult, ChannelConversation } from "../run-store.js";
import type { InputRequestProjectionRecord } from "../projections.js";
import type { Thread, ThreadMessage, ThreadStore } from "../thread-store.js";
import type { OAuthConnection, OAuthStore, RefreshedTokens } from "../oauth-store.js";
import type { ScheduleRecord, ScheduleStore } from "../schedule-store.js";
import { encrypt, decrypt, encryptionKeyFromEnv } from "../crypto.js";
import { categoryOf } from "../categories.js";
import { isTransientEvent } from "../events.js";
import { idempotencyKey } from "../idempotency.js";
import { applyMigrations } from "./migrations.js";
import { createPool, type PoolConfig } from "./db.js";

const NOTIFY_CHANNEL = "run_events";

/**
 * Postgres's `jsonb` type rejects a literal NUL byte inside a JSON string
 * value ("unsupported Unicode escape sequence", SQLSTATE 22P05) — a hard
 * Postgres limitation, not something callers can be expected to avoid (a
 * diff, tool output, or chat message can legitimately contain `\u0000`
 * upstream). `JSON.stringify` only ever emits `\u0000` as this escaped
 * 6-character sequence inside a string value — never as JSON structure — so
 * stripping it post-serialization is safe and keeps the rest of the payload
 * intact. Use this instead of `JSON.stringify` for every value bound to a
 * `jsonb` column.
 */
function jsonbStringify(value: unknown): string {
  return JSON.stringify(value).replace(/\\u0000/g, "");
}

/**
 * Postgres-backed event log. `append` is a single transaction that:
 * 1. Assigns a gap-free seq via `next_event_seq(run_id)`
 * 2. Inserts the event into `run_events`
 * 3. Upserts affected projections (runs, spans, tool_calls, run_messages, etc.)
 * 4. NOTIFY's the stream with a pointer payload `{ runId, seq }`
 */
/** One live `tail()` subscriber: a pointer queue fed by the shared listener. */
interface EventTailSub {
  queue: Array<{ runId: string; seq: number }>;
  wake: (() => void) | null;
}

export class PgEventLogStore implements EventLogStore {
  private interceptor?: EventInterceptor;

  // Single shared `run_events` LISTEN connection fans out to all tail()
  // subscribers, so N SSE clients add ONE DB connection, not N.
  private tailListenClient: pg.PoolClient | null = null;
  private tailListening: Promise<void> | null = null;
  private readonly tailSubs = new Set<EventTailSub>();

  constructor(private readonly pool: Pool) {}

  setInterceptor(interceptor?: EventInterceptor): void {
    this.interceptor = interceptor;
  }

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
    client.on("notification", (msg: pg.Notification) => {
      if (!msg.payload) return;
      let pointer: { runId: string; seq: number };
      try {
        pointer = JSON.parse(msg.payload) as { runId: string; seq: number };
      } catch {
        return;
      }
      for (const sub of this.tailSubs) {
        sub.queue.push(pointer);
        sub.wake?.();
      }
    });
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
  }

  private async stopTailListening(): Promise<void> {
    // A subscriber may have arrived after the caller's size check; keep alive if so.
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

  async append(record: RunEventRecord): Promise<void> {
    if (isTransientEvent(record.payload.type)) {
      throw new Error(
        `Event "${record.payload.type}" is transient (D13) and must not be persisted; publish it via DeltaBus instead.`,
      );
    }
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

      // Ensure run row exists (FK target); ON CONFLICT no-op is safe on every append.
      await client.query(
        `INSERT INTO runs (id, workflow, status, started_at)
         VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (id) DO NOTHING`,
        [record.runId, record.agentName ?? "", record.ts],
      );

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
          jsonbStringify(stored.payload),
          stored.version,
        ],
      );

      await this.foldRuns(client, stored);
      await this.foldSpans(client, stored);
      await this.foldToolCalls(client, stored);
      await this.foldRunMessages(client, stored);
      await this.foldWorkflowSteps(client, stored);
      await this.foldInputs(client, stored);
      await this.foldThreadMessages(client, stored);

      // Pointer-only NOTIFY payload avoids the 8KB limit
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

  async readThread(threadId: string): Promise<RunEventRecord[]> {
    const res = await this.pool.query<PgEventRow>(
      `SELECT e.id, e.run_id, e.seq, e.ts, e.category, e.type, e.agent_name, e.span_id, e.parent_span_id, e.payload, e.version
       FROM run_events e
       JOIN runs r ON r.id = e.run_id
       WHERE r.thread_id = $1
       ORDER BY e.ts, e.run_id, e.seq`,
      [threadId],
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

    // Subscribe to the shared LISTEN multiplexer; each gets its own pointer
    // queue, with filtering/event reads happening per-subscriber below.
    const sub: EventTailSub = { queue: [], wake: null };
    const subs = this.tailSubs;
    const ensureListening = () => this.ensureTailListening();
    const stopListening = () => this.stopTailListening();

    async function* generator(): AsyncGenerator<RunEventRecord> {
      if (signal.aborted) return;
      subs.add(sub);
      const onAbort = () => { sub.wake?.(); };
      signal.addEventListener("abort", onAbort);
      try {
        await ensureListening();
        while (!signal.aborted) {
          let pointer = sub.queue.shift();
          while (pointer !== undefined) {
            if (await matchesFilter(pointer.runId)) {
              const event = await readEvent(pointer.runId, pointer.seq);
              if (event) yield event;
            }
            pointer = sub.queue.shift();
          }
          if (signal.aborted) return;
          await new Promise<void>((r) => { sub.wake = r; });
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

  // --- Projection folds (SQL upserts within the append transaction) ---

  private async foldRuns(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    switch (p.type) {
      case "run.started":
        // D10: event log must stay self-sufficient, so a run.started with a
        // threadId can append even if the thread row wasn't created out-of-band.
        if (p.threadId) {
          await client.query(
            `INSERT INTO threads (id, user_id, created_at, updated_at)
             VALUES ($1, $2, $3, $3)
             ON CONFLICT (id) DO NOTHING`,
            [p.threadId, p.userId ?? null, rec.ts],
          );
        }
        await client.query(
          `INSERT INTO runs (id, workflow, status, input, trigger, started_at, thread_id, user_id, agent_version, parent_span_id, channel, external_conversation_id)
           VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO UPDATE SET
             status = 'running', input = EXCLUDED.input, trigger = EXCLUDED.trigger,
             started_at = EXCLUDED.started_at, workflow = EXCLUDED.workflow,
             thread_id = COALESCE(EXCLUDED.thread_id, runs.thread_id),
             user_id = COALESCE(EXCLUDED.user_id, runs.user_id),
             agent_version = COALESCE(EXCLUDED.agent_version, runs.agent_version),
             parent_span_id = COALESCE(EXCLUDED.parent_span_id, runs.parent_span_id),
             channel = COALESCE(EXCLUDED.channel, runs.channel),
             external_conversation_id = COALESCE(EXCLUDED.external_conversation_id, runs.external_conversation_id)`,
          [
            rec.runId,
            rec.agentName ?? "",
            p.input !== undefined ? jsonbStringify(p.input) : null,
            p.trigger ?? null,
            rec.ts,
            p.threadId ?? null,
            p.userId ?? null,
            p.agentVersion ?? null,
            rec.parentSpanId ?? null,
            p.channel ?? null,
            p.externalConversationId ?? null,
          ],
        );
        // First run on a conversation establishes the thread; later turns keep it
        // and advance last_run_id. No FK on last_run_id — mapping outlives runs.
        if (p.channel && p.externalConversationId) {
          await client.query(
            `INSERT INTO channel_conversations (channel, external_conversation_id, thread_id, last_run_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $5)
             ON CONFLICT (channel, external_conversation_id) DO UPDATE SET
               thread_id = COALESCE(channel_conversations.thread_id, EXCLUDED.thread_id),
               last_run_id = EXCLUDED.last_run_id,
               updated_at = EXCLUDED.updated_at`,
            [p.channel, p.externalConversationId, p.threadId ?? null, rec.runId, rec.ts],
          );
        }
        break;

      case "run.completed":
        await client.query(
          `UPDATE runs SET status = 'completed', result = $2, finished_at = $3 WHERE id = $1`,
          [rec.runId, p.result !== undefined ? jsonbStringify(p.result) : null, rec.ts],
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
        // Round to 1e-12 to match the in-memory fold for parity.
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
      case "run.started": {
        const isWorkflow = (p.spanKind ?? "agent") === "workflow";
        const kind = isWorkflow ? "workflow" : "agent";
        const attributes = isWorkflow
          ? { workflow: rec.agentName, trigger: p.trigger }
          : { agentName: rec.agentName, agentVersion: p.agentVersion, model: p.model, iterations: 0, usage: { inputTokens: 0, outputTokens: 0 } };
        await client.query(
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, input, attributes, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, rec.agentName ?? "run", kind, p.input !== undefined ? jsonbStringify(p.input) : null, jsonbStringify(attributes), rec.ts],
        );
        break;
      }

      case "run.completed":
        await client.query(
          `UPDATE spans SET status = 'ok', output = $2, finished_at = $3 WHERE id = $1`,
          [spanId, p.result !== undefined ? jsonbStringify(p.result) : null, rec.ts],
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
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, input, attributes, started_at)
           VALUES ($1, $2, $3, $4, $5, 'tool', 'running', $6, $7, $8)
           ON CONFLICT (id) DO NOTHING`,
          [spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, p.name, p.input !== undefined ? jsonbStringify(p.input) : null, jsonbStringify({ toolName: p.name }), rec.ts],
        );
        break;

      case "tool.result":
        // Close the span and fold toolName/ok/latencyMs attributes.
        await client.query(
          `UPDATE spans SET
             status = $2,
             ${p.result.isError ? "error = $3" : "output = $3"},
             finished_at = $4,
             attributes = coalesce(attributes, '{}'::jsonb) || jsonb_build_object(
               'toolName', $5::text,
               'ok', $6::boolean,
               'latencyMs', round(extract(epoch from ($4::timestamptz - started_at)) * 1000)
             )
           WHERE id = $1`,
          [
            spanId,
            p.result.isError ? "error" : "ok",
            p.result.isError ? p.result.content : jsonbStringify(p.result.content),
            rec.ts,
            p.name,
            !p.result.isError,
          ],
        );
        break;

      case "step.started":
        await client.query(
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, attributes, started_at)
           VALUES ($1, $2, $3, $4, $5, 'step', 'running', $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, p.name, jsonbStringify({ step: p.name }), rec.ts],
        );
        break;

      case "step.completed":
        await client.query(
          `UPDATE spans SET status = 'ok', output = $2, finished_at = $3 WHERE id = $1`,
          [spanId, p.result !== undefined ? jsonbStringify(p.result) : null, rec.ts],
        );
        break;

      case "llm.call":
        await client.query(
          `INSERT INTO spans (id, run_id, parent_id, seq, name, kind, status, attributes, started_at, finished_at)
           VALUES ($1, $2, $3, $4, $5, 'llm', 'ok', $6, $7, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            spanId, rec.runId, rec.parentSpanId ?? null, rec.seq, p.model,
            jsonbStringify({
              usage: p.usage,
              costUsd: p.costUsd,
              stopReason: p.stopReason,
              latencyMs: p.latencyMs,
              "gen_ai.request.model": p.model,
              "gen_ai.usage.input_tokens": p.usage.inputTokens,
              "gen_ai.usage.output_tokens": p.usage.outputTokens,
              "gen_ai.response.finish_reasons": [p.stopReason],
            }),
            rec.ts,
          ],
        );
        // Accumulate model/iterations/usage onto the parent agent span (mirrors memory fold).
        if (rec.parentSpanId) {
          await client.query(
            `UPDATE spans SET attributes = coalesce(attributes, '{}'::jsonb) || jsonb_build_object(
               'model', coalesce(attributes->>'model', $2::text),
               'iterations', coalesce((attributes->>'iterations')::int, 0) + 1,
               'usage', jsonb_build_object(
                 'inputTokens',  coalesce((attributes#>>'{usage,inputTokens}')::int, 0) + $3::int,
                 'outputTokens', coalesce((attributes#>>'{usage,outputTokens}')::int, 0) + $4::int
               )
             )
             WHERE id = $1 AND kind = 'agent'`,
            [rec.parentSpanId, p.model, p.usage.inputTokens, p.usage.outputTokens],
          );
        }
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
          [p.toolCallId, rec.runId, idemKey, p.name, jsonbStringify(p.input), rec.ts],
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
      [rec.id, rec.runId, agentName ?? "", rec.seq, role, jsonbStringify(content), rec.ts],
    );
  }

  private async foldWorkflowSteps(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    if (p.type !== "step.completed") return;
    await client.query(
      `INSERT INTO workflow_steps (run_id, name, result, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id, name) DO NOTHING`,
      [rec.runId, p.name, jsonbStringify(p.result), rec.ts],
    );
  }

  private async foldInputs(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    switch (p.type) {
      case "input.requested":
        await client.query(
          `INSERT INTO input_requests (id, run_id, kind, tool_name, tool_input, prompt, value, agent_name, status, requested_at)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, 'pending', $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            p.inputRequestId,
            rec.runId,
            p.kind,
            p.toolName ?? null,
            p.input !== undefined ? jsonbStringify(p.input) : null,
            p.prompt ?? null,
            rec.agentName ?? "",
            rec.ts,
          ],
        );
        break;
      case "input.provided":
        await client.query(
          `UPDATE input_requests SET
             status = CASE WHEN kind = 'approval' THEN CASE WHEN $2 THEN 'approved' ELSE 'denied' END ELSE 'provided' END,
             value = $6,
             resolved_at = $3, provided_by = $4, reason = $5
           WHERE id = $1`,
          [
            p.inputRequestId,
            p.approved ?? false,
            rec.ts,
            p.providedBy ?? null,
            p.reason ?? null,
            p.value !== undefined ? jsonbStringify(p.value) : null,
          ],
        );
        break;
    }
  }

  private async foldThreadMessages(client: PoolClient, rec: RunEventRecord): Promise<void> {
    const p = rec.payload;
    if (p.type !== "message.user" && p.type !== "message.assistant") return;

    const runRes = await client.query<{ thread_id: string | null }>(
      "SELECT thread_id FROM runs WHERE id = $1",
      [rec.runId],
    );
    const threadId = runRes.rows[0]?.thread_id;
    if (!threadId) return;

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

export class PgRunStore implements RunStore, ThreadStore, OAuthStore, ScheduleStore {
  /** Exposed so a `PgJobQueue` can share the store's connection pool. */
  readonly pool: Pool;
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
              thread_id, user_id, agent_version, parent_span_id, channel, external_conversation_id, started_at, finished_at
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
    if (opts?.userId) {
      conditions.push(`user_id = $${paramIdx++}`);
      params.push(opts.userId);
    }
    if (opts?.roots) {
      conditions.push(`parent_span_id IS NULL`);
    }
    if (opts?.before) {
      // Keyset pagination on the cursor run's started_at
      conditions.push(`started_at < (SELECT started_at FROM runs WHERE id = $${paramIdx++})`);
      params.push(opts.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    // No limit ⇒ return all matching runs (parity with in-memory store).
    const limitClause = opts?.limit !== undefined ? `LIMIT $${paramIdx}` : "";
    const finalParams = opts?.limit !== undefined ? [...params, opts.limit] : params;

    const res = await this.pool.query<PgRunRow>(
      `SELECT id, workflow, status, input, result, error, trigger, total_cost_usd,
              thread_id, user_id, agent_version, parent_span_id, channel, external_conversation_id, started_at, finished_at
       FROM runs ${where}
       ORDER BY started_at DESC, id DESC
       ${limitClause}`,
      finalParams,
    );
    return res.rows.map(mapRunRow);
  }

  async listChildRuns(runId: string): Promise<RunRecord[]> {
    // Children hang off a span in the parent run: workflow fan-out points at the
    // root span (id === runId), LLM subagents at a tool-call span. Match either.
    const res = await this.pool.query<PgRunRow>(
      `SELECT id, workflow, status, input, result, error, trigger, total_cost_usd,
              thread_id, user_id, agent_version, parent_span_id, channel, external_conversation_id, started_at, finished_at
       FROM runs
       WHERE parent_span_id IS NOT NULL
         AND (parent_span_id = $1 OR parent_span_id IN (SELECT id FROM spans WHERE run_id = $1))
       ORDER BY started_at ASC, id ASC`,
      [runId],
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

  async getThreadAgentMessages(threadId: string, agentName: string): Promise<Message[]> {
    // Folds history across every run in the thread, ordered by run start (then
    // seq), for the chat lane's new-run-per-turn memory.
    const res = await this.pool.query<{ role: string; content: unknown }>(
      `SELECT rm.role, rm.content
       FROM run_messages rm
       JOIN runs r ON r.id = rm.run_id
       WHERE r.thread_id = $1 AND (rm.agent_name = $2 OR rm.agent_name = '')
       ORDER BY r.started_at, r.id, rm.seq`,
      [threadId, agentName],
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

  async getInputs(runId: string): Promise<InputRequestProjectionRecord[]> {
    const res = await this.pool.query<PgApprovalRow>(
      `SELECT id, run_id, kind, tool_name, tool_input, prompt, value, agent_name, status, requested_at, resolved_at, provided_by, reason
       FROM input_requests WHERE run_id = $1 ORDER BY requested_at`,
      [runId],
    );
    return res.rows.map(mapApprovalRow);
  }

  async getInputById(inputRequestId: string): Promise<InputRequestProjectionRecord | undefined> {
    const res = await this.pool.query<PgApprovalRow>(
      `SELECT id, run_id, kind, tool_name, tool_input, prompt, value, agent_name, status, requested_at, resolved_at, provided_by, reason
       FROM input_requests WHERE id = $1`,
      [inputRequestId],
    );
    return res.rows.length > 0 ? mapApprovalRow(res.rows[0]) : undefined;
  }

  async listInputs(opts?: ListInputsOptions): Promise<InputRequestProjectionRecord[]> {
    const params: unknown[] = [];
    const filters: string[] = [];
    if (opts?.status) {
      params.push(opts.status);
      filters.push(`status = $${params.length}`);
    }
    if (opts?.kind) {
      params.push(opts.kind);
      filters.push(`kind = $${params.length}`);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limitClause = opts?.limit !== undefined ? `LIMIT $${params.length + 1}` : "";
    if (opts?.limit !== undefined) params.push(opts.limit);
    const res = await this.pool.query<PgApprovalRow>(
      `SELECT id, run_id, kind, tool_name, tool_input, prompt, value, agent_name, status, requested_at, resolved_at, provided_by, reason
       FROM input_requests ${where} ORDER BY requested_at DESC ${limitClause}`,
      params,
    );
    return res.rows.map(mapApprovalRow);
  }

  async resolveConversation(channel: string, externalConversationId: string): Promise<ChannelConversation | undefined> {
    const res = await this.pool.query<{ channel: string; external_conversation_id: string; thread_id: string | null; last_run_id: string | null }>(
      `SELECT channel, external_conversation_id, thread_id, last_run_id
       FROM channel_conversations WHERE channel = $1 AND external_conversation_id = $2`,
      [channel, externalConversationId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      channel: row.channel,
      externalConversationId: row.external_conversation_id,
      threadId: row.thread_id ?? undefined,
      lastRunId: row.last_run_id ?? "",
    };
  }

  // --- ThreadStore (metadata in `threads`; transcript in `messages`) ---

  async createThread(thread: Thread): Promise<void> {
    await this.pool.query(
      `INSERT INTO threads (id, user_id, metadata, status, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        thread.id, thread.userId ?? null,
        thread.metadata !== undefined ? jsonbStringify(thread.metadata) : null,
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
    if (patch.metadata !== undefined) add("metadata", jsonbStringify(patch.metadata));
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
       FROM messages WHERE thread_id = $1 ORDER BY created_at, run_id, seq`,
      [threadId],
    );
    return res.rows.map(mapMessageRow);
  }

  // --- ScheduleStore (operational table; never auto-expired) ---

  async createSchedule(s: ScheduleRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO schedules (id, workflow, cron_expression, input, enabled, user_id, last_run_id, last_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        s.id, s.workflow, s.cronExpression,
        s.input !== undefined ? jsonbStringify(s.input) : null,
        s.enabled, s.userId ?? null, s.lastRunId ?? null, s.lastRunAt ?? null, s.createdAt, s.updatedAt,
      ],
    );
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    const res = await this.pool.query<PgScheduleRow>(
      `SELECT id, workflow, cron_expression, input, enabled, user_id, last_run_id, last_run_at, created_at, updated_at
       FROM schedules WHERE id = $1`,
      [id],
    );
    return res.rows.length > 0 ? mapScheduleRow(res.rows[0]) : undefined;
  }

  async updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (patch.workflow !== undefined) add("workflow", patch.workflow);
    if (patch.cronExpression !== undefined) add("cron_expression", patch.cronExpression);
    if (patch.input !== undefined) add("input", jsonbStringify(patch.input));
    if (patch.enabled !== undefined) add("enabled", patch.enabled);
    if (patch.lastRunId !== undefined) add("last_run_id", patch.lastRunId);
    if (patch.lastRunAt !== undefined) add("last_run_at", patch.lastRunAt);
    params.push(new Date().toISOString());
    sets.push(`updated_at = $${params.length}`);
    if (sets.length === 1) return; // only updated_at → nothing meaningful
    await this.pool.query(`UPDATE schedules SET ${sets.join(", ")} WHERE id = $1`, params);
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM schedules WHERE id = $1`, [id]);
  }

  async listSchedules(opts?: { userId?: string }): Promise<ScheduleRecord[]> {
    const res = opts?.userId
      ? await this.pool.query<PgScheduleRow>(
          `SELECT id, workflow, cron_expression, input, enabled, user_id, last_run_id, last_run_at, created_at, updated_at
           FROM schedules WHERE user_id = $1 ORDER BY created_at DESC`,
          [opts.userId],
        )
      : await this.pool.query<PgScheduleRow>(
          `SELECT id, workflow, cron_expression, input, enabled, user_id, last_run_id, last_run_at, created_at, updated_at
           FROM schedules ORDER BY created_at DESC`,
        );
    return res.rows.map(mapScheduleRow);
  }

  async listEnabled(): Promise<ScheduleRecord[]> {
    const res = await this.pool.query<PgScheduleRow>(
      `SELECT id, workflow, cron_expression, input, enabled, user_id, last_run_id, last_run_at, created_at, updated_at
       FROM schedules WHERE enabled = true ORDER BY created_at DESC`,
    );
    return res.rows.map(mapScheduleRow);
  }

  async cleanup(opts: RetentionOptions): Promise<RetentionResult> {
    const now = opts.now ?? new Date();
    const eventHorizon = new Date(now.getTime() - opts.eventRetentionDays * 86_400_000).toISOString();
    const runHorizon = new Date(now.getTime() - opts.runRetentionDays * 86_400_000).toISOString();
    const TERMINAL = ["completed", "failed", "cancelled"];
    const ageExpr = "COALESCE(finished_at, started_at)";

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const detail = await client.query<{ id: string }>(
        `SELECT id FROM runs WHERE status = ANY($1) AND ${ageExpr} < $2`,
        [TERMINAL, eventHorizon],
      );
      const detailIds = detail.rows.map((r) => r.id);
      if (detailIds.length > 0) {
        await this.deleteDetail(client, detailIds);
      }

      const summary = await client.query<{ id: string }>(
        `SELECT id FROM runs WHERE status = ANY($1) AND ${ageExpr} < $2`,
        [TERMINAL, runHorizon],
      );
      const summaryIds = summary.rows.map((r) => r.id);
      if (summaryIds.length > 0) {
        // Detail may still exist if runHorizon < eventHorizon; clear it first (FK).
        await this.deleteDetail(client, summaryIds);
        // Null schedule refs before deleting summaries (FK).
        await client.query(`UPDATE schedules SET last_run_id = NULL WHERE last_run_id = ANY($1)`, [summaryIds]);
        await client.query(`DELETE FROM runs WHERE id = ANY($1)`, [summaryIds]);
      }

      await client.query("COMMIT");
      return { eventDetailTrimmed: detailIds.length, runsDeleted: summaryIds.length };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async reapStaleRuns(opts: ReapOptions): Promise<ReapResult> {
    const now = opts.now ?? new Date();
    const horizon = new Date(now.getTime() - opts.staleMs).toISOString();

    // Lane A roots only: non-terminal, no active queue job (Lane B is reclaimed
    // by the job queue's own reaper, never failed here), silent past the
    // horizon (most recent event predates it — progress resets the clock).
    const res = await this.pool.query<{ id: string }>(
      `SELECT r.id
         FROM runs r
        WHERE r.status IN ('running', 'pending')
          AND NOT EXISTS (
            SELECT 1 FROM run_jobs j
             WHERE j.run_id = r.id AND j.status IN ('queued', 'running')
          )
          AND COALESCE(
            (SELECT max(e.ts) FROM run_events e WHERE e.run_id = r.id),
            r.started_at
          ) < $1`,
      [horizon],
    );

    const runIds: string[] = [];
    for (const { id } of res.rows) {
      // Re-check so a run that settled in the tiny scan-to-now window isn't flipped to failed.
      const run = await this.getRun(id);
      if (!run || (run.status !== "running" && run.status !== "pending")) continue;
      await this.events.append(
        buildEventRecord(
          id,
          { type: "run.failed", error: "reaped: no progress (workflows host unreachable or task died)" },
          { agentName: run.workflow, spanId: id },
        ),
      );
      runIds.push(id);
    }
    return { reaped: runIds.length, runIds };
  }

  /** Delete event-detail rows for the given runs. `messages` (transcript) is preserved. */
  private async deleteDetail(client: PoolClient, runIds: string[]): Promise<void> {
    for (const table of ["spans", "run_messages", "tool_calls", "workflow_steps", "input_requests", "run_events"]) {
      await client.query(`DELETE FROM ${table} WHERE run_id = ANY($1)`, [runIds]);
    }
  }

  // --- OAuthStore (tokens encrypted at rest via AES-256-GCM) ---

  async getConnection(userId: string, provider: string): Promise<OAuthConnection | undefined> {
    const res = await this.pool.query<PgOAuthRow>(
      `SELECT id, user_id, provider, access_token, refresh_token, expires_at, scopes, created_at, updated_at
       FROM oauth_connections WHERE user_id = $1 AND provider = $2`,
      [userId, provider],
    );
    return res.rows.length > 0 ? mapOAuthRow(res.rows[0], encryptionKeyFromEnv()) : undefined;
  }

  async upsertConnection(conn: OAuthConnection): Promise<void> {
    const key = encryptionKeyFromEnv();
    await this.pool.query(
      `INSERT INTO oauth_connections (id, user_id, provider, access_token, refresh_token, expires_at, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at, scopes = EXCLUDED.scopes, updated_at = EXCLUDED.updated_at`,
      [
        conn.id, conn.userId, conn.provider,
        encrypt(conn.accessToken, key),
        conn.refreshToken !== undefined ? encrypt(conn.refreshToken, key) : null,
        conn.expiresAt ?? null, conn.scopes, conn.createdAt, conn.updatedAt,
      ],
    );
  }

  async deleteConnection(userId: string, provider: string): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_connections WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  }

  async listConnections(userId: string): Promise<OAuthConnection[]> {
    const key = encryptionKeyFromEnv();
    const res = await this.pool.query<PgOAuthRow>(
      `SELECT id, user_id, provider, access_token, refresh_token, expires_at, scopes, created_at, updated_at
       FROM oauth_connections WHERE user_id = $1`,
      [userId],
    );
    return res.rows.map((r) => mapOAuthRow(r, key));
  }

  /** In-process single-flight for token refresh, keyed by `${userId}:${provider}`.
   *  Cross-process coordination uses the `FOR UPDATE` lock in `doRefreshConnection`. */
  private readonly refreshLocks = new Map<string, Promise<OAuthConnection | undefined>>();

  async refreshConnection(
    userId: string,
    provider: string,
    isExpired: (conn: OAuthConnection) => boolean,
    doRefresh: (conn: OAuthConnection) => Promise<RefreshedTokens>,
  ): Promise<OAuthConnection | undefined> {
    const lockKey = `${userId}:${provider}`;
    const inflight = this.refreshLocks.get(lockKey);
    if (inflight) return inflight;
    const run = this.doRefreshConnection(userId, provider, isExpired, doRefresh);
    this.refreshLocks.set(lockKey, run);
    try {
      return await run;
    } finally {
      this.refreshLocks.delete(lockKey);
    }
  }

  private async doRefreshConnection(
    userId: string,
    provider: string,
    isExpired: (conn: OAuthConnection) => boolean,
    doRefresh: (conn: OAuthConnection) => Promise<RefreshedTokens>,
  ): Promise<OAuthConnection | undefined> {
    const key = encryptionKeyFromEnv();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Exclusive row lock → concurrent refreshers serialize and coalesce.
      const res = await client.query<PgOAuthRow>(
        `SELECT id, user_id, provider, access_token, refresh_token, expires_at, scopes, created_at, updated_at
         FROM oauth_connections WHERE user_id = $1 AND provider = $2 FOR UPDATE`,
        [userId, provider],
      );
      if (res.rows.length === 0) {
        await client.query("COMMIT");
        return undefined;
      }
      const current = mapOAuthRow(res.rows[0], key);
      if (!isExpired(current)) {
        await client.query("COMMIT");
        return current;
      }
      const tokens = await doRefresh(current);
      const updatedAt = new Date().toISOString();
      await client.query(
        `UPDATE oauth_connections SET access_token = $3, refresh_token = $4, expires_at = $5, updated_at = $6
         WHERE user_id = $1 AND provider = $2`,
        [
          userId, provider,
          encrypt(tokens.accessToken, key),
          tokens.refreshToken !== undefined ? encrypt(tokens.refreshToken, key) : (current.refreshToken !== undefined ? encrypt(current.refreshToken, key) : null),
          tokens.expiresAt ?? null, updatedAt,
        ],
      );
      await client.query("COMMIT");
      return {
        ...current,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? current.refreshToken,
        expiresAt: tokens.expiresAt,
        updatedAt,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
  channel: string | null;
  external_conversation_id: string | null;
  parent_span_id: string | null;
  started_at: Date;
  finished_at: Date | null;
}

interface PgApprovalRow {
  id: string;
  run_id: string;
  kind: "approval" | "message";
  tool_name: string | null;
  tool_input: unknown;
  prompt: string | null;
  value: unknown;
  agent_name: string | null;
  status: string;
  requested_at: Date;
  resolved_at: Date | null;
  provided_by: string | null;
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
    channel: row.channel ?? undefined,
    externalConversationId: row.external_conversation_id ?? undefined,
    parentSpanId: row.parent_span_id ?? undefined,
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

interface PgScheduleRow {
  id: string;
  workflow: string;
  cron_expression: string;
  input: unknown;
  enabled: boolean;
  user_id: string | null;
  last_run_id: string | null;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PgOAuthRow {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: Date | null;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
}

function mapOAuthRow(row: PgOAuthRow, key: Buffer): OAuthConnection {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    accessToken: decrypt(row.access_token, key),
    refreshToken: row.refresh_token !== null ? decrypt(row.refresh_token, key) : undefined,
    expiresAt: row.expires_at?.toISOString(),
    scopes: row.scopes ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
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

function mapScheduleRow(row: PgScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    workflow: row.workflow,
    cronExpression: row.cron_expression,
    input: coerceJson(row.input) ?? undefined,
    enabled: row.enabled,
    userId: row.user_id ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapApprovalRow(row: PgApprovalRow): InputRequestProjectionRecord {
  return {
    inputRequestId: row.id,
    runId: row.run_id,
    kind: row.kind,
    toolName: row.tool_name ?? undefined,
    input: coerceJson(row.tool_input),
    prompt: row.prompt ?? undefined,
    value: coerceJson(row.value),
    agentName: row.agent_name ?? undefined,
    status: row.status as InputRequestProjectionRecord["status"],
    requestedAt: row.requested_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString(),
    providedBy: row.provided_by ?? undefined,
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
