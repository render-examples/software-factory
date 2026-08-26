import { randomUUID } from "node:crypto";
import type {
  EventLogStore,
  EventInterceptor,
  EventQueryOptions,
  RunEvent,
  RunEventRecord,
  ToolResult,
} from "./events.js";
import { categoryOf } from "./categories.js";
import { isTransientEvent } from "./events.js";
import type { Message } from "./messages.js";
import type { RunStore, RunRecord, SpanRecord, ListRunsOptions, ListChildRunsOptions, ListInputsOptions, RetentionOptions, RetentionResult, ReapOptions, ReapResult } from "./run-store.js";
import { TERMINAL_STATUSES } from "./run-store.js";
import type { Thread, ThreadMessage, ThreadStore } from "./thread-store.js";
import type { OAuthConnection, OAuthStore, RefreshedTokens } from "./oauth-store.js";
import type { ScheduleRecord, ScheduleStore } from "./schedule-store.js";
import type { InputRequestProjectionRecord } from "./projections.js";
import { Projections, type ProjectionSnapshot } from "./projections.js";

/** Thrown by `append` when an `EventInterceptor` vetoes an event pre-commit. */
export class EventRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Event rejected: ${reason}`);
    this.name = "EventRejectedError";
    this.reason = reason;
  }
}

interface Subscriber {
  filter: { runId?: string; threadId?: string };
  queue: RunEventRecord[];
  wake?: () => void;
  done: boolean;
}
const MAX_EVENT_TAIL_QUEUE = 10_000;

/**
 * In-memory append-only event log. `append` is the single write path: it runs
 * the optional pre-commit interceptor, assigns a gap-free per-run `seq`, folds
 * every registered projection, and notifies live tail subscribers — atomically
 * (synchronously here; the Postgres store makes this one transaction).
 */
export class MemoryEventLogStore implements EventLogStore {
  private byRun = new Map<string, RunEventRecord[]>();
  /** runId → threadId, learned from `run.started`, so thread-scoped tails (chat) work in dev. */
  private runThread = new Map<string, string>();
  private subscribers = new Set<Subscriber>();
  private interceptor?: EventInterceptor;

  constructor(private readonly projections: Projections) {}

  setInterceptor(interceptor?: EventInterceptor): void {
    this.interceptor = interceptor;
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

    const events = this.byRun.get(record.runId) ?? [];
    const expected = events.length + 1;
    // If the caller pinned a seq (e.g. a test), it must match the next gap-free position.
    if (record.seq && record.seq !== expected) {
      throw new Error(
        `seq out of order for run ${record.runId}: expected ${expected}, got ${record.seq}`,
      );
    }

    const stored: RunEventRecord = {
      ...record,
      payload,
      type: payload.type,
      category: categoryOf(payload.type),
      seq: expected,
    };
    events.push(stored);
    this.byRun.set(record.runId, events);
    // Learn the run's thread from its opening event so thread-scoped tails match.
    if (stored.payload.type === "run.started" && stored.payload.threadId) {
      this.runThread.set(stored.runId, stored.payload.threadId);
    }
    this.projections.apply(stored);
    this.publish(stored);
  }

  async read(runId: string, fromSeq?: number): Promise<RunEventRecord[]> {
    const events = this.byRun.get(runId) ?? [];
    const slice = fromSeq !== undefined ? events.filter(e => e.seq >= fromSeq) : events;
    return slice.map(e => ({ ...e }));
  }

  async query(runId: string, opts?: EventQueryOptions): Promise<RunEventRecord[]> {
    let events = [...(this.byRun.get(runId) ?? [])];
    if (opts?.afterSeq !== undefined) events = events.filter((e) => e.seq > opts.afterSeq!);
    if (opts?.beforeSeq !== undefined) events = events.filter((e) => e.seq < opts.beforeSeq!);
    if (opts?.since !== undefined) events = events.filter((e) => e.ts >= opts.since!);
    if (opts?.types !== undefined) {
      const types = new Set(opts.types);
      events = events.filter((e) => types.has(e.type));
    }
    if (opts?.order === "desc") events.reverse();
    if (opts?.limit !== undefined) events = events.slice(0, opts.limit);
    return events.map((e) => ({ ...e }));
  }

  async readThread(threadId: string): Promise<RunEventRecord[]> {
    const out: RunEventRecord[] = [];
    for (const [runId, events] of this.byRun) {
      if (this.runThread.get(runId) !== threadId) continue;
      for (const e of events) out.push({ ...e });
    }
    // Canonical thread order: ts, then runId, then seq (matches the Pg query).
    out.sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1
        : a.runId < b.runId ? -1 : a.runId > b.runId ? 1
          : a.seq - b.seq,
    );
    return out;
  }

  tail(
    filter: { runId?: string; threadId?: string },
    signal: AbortSignal,
  ): AsyncIterable<RunEventRecord> {
    const subscribers = this.subscribers;
    const sub: Subscriber = { filter, queue: [], done: false };

    async function* generator(): AsyncGenerator<RunEventRecord> {
      if (signal.aborted) return;
      subscribers.add(sub);
      const onAbort = () => {
        sub.done = true;
        sub.wake?.();
      };
      signal.addEventListener("abort", onAbort);
      try {
        while (true) {
          let next = sub.queue.shift();
          while (next !== undefined) {
            yield next;
            next = sub.queue.shift();
          }
          if (sub.done) return;
          await new Promise<void>(resolve => {
            sub.wake = resolve;
          });
          sub.wake = undefined;
        }
      } finally {
        subscribers.delete(sub);
        signal.removeEventListener("abort", onAbort);
      }
    }

    return generator();
  }

  /** Drop all stored events for a run (retention event-detail trim). */
  deleteRun(runId: string): void {
    this.byRun.delete(runId);
    this.runThread.delete(runId);
  }

  private publish(rec: RunEventRecord): void {
    const copy = { ...rec, payload: { ...rec.payload } };
    for (const sub of this.subscribers) {
      if (sub.filter.runId && sub.filter.runId !== rec.runId) continue;
      // Thread-scoped tail: run→thread mapping is learned from run.started, so a
      // stream opened before a turn starts still picks up that turn's run.
      if (sub.filter.threadId && !sub.filter.runId) {
        if (this.runThread.get(rec.runId) !== sub.filter.threadId) continue;
      }
      sub.queue.push(copy);
      if (sub.queue.length > MAX_EVENT_TAIL_QUEUE) sub.queue.shift();
      sub.wake?.();
    }
  }
}

/**
 * In-memory `RunStore`: reads are pure projections folded from the event log.
 * Writes go exclusively through `events.append` — there are no direct
 * projection writers.
 */
export class MemoryRunStore implements RunStore, ThreadStore, OAuthStore, ScheduleStore {
  private readonly projections = new Projections();
  /** Thread metadata (created via the gateway API, not folded from events). */
  private readonly threads = new Map<string, Thread>();
  /** Runtime-managed schedules (operational table, not folded from events). */
  private readonly schedules = new Map<string, ScheduleRecord>();
  /** OAuth connections keyed by `${userId}:${provider}` (plaintext in-memory). */
  private readonly connections = new Map<string, OAuthConnection>();
  /** Per-connection refresh mutex so concurrent refreshes coalesce. */
  private readonly refreshLocks = new Map<string, Promise<OAuthConnection | undefined>>();
  readonly events: MemoryEventLogStore;

  constructor() {
    this.events = new MemoryEventLogStore(this.projections);
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  setInterceptor(interceptor?: EventInterceptor): void {
    this.events.setInterceptor(interceptor);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.projections.getRun(id);
  }

  async listRuns(opts?: ListRunsOptions): Promise<RunRecord[]> {
    return this.projections.listRuns(opts);
  }

  async listChildRuns(runId: string, opts?: ListChildRunsOptions): Promise<RunRecord[]> {
    let runs = this.projections.listChildRuns(runId);
    if (opts?.order === "desc") runs = runs.reverse();
    if (opts?.limit !== undefined) runs = runs.slice(0, opts.limit);
    return runs;
  }

  async getMessages(runId: string, agentName: string): Promise<Message[]> {
    return this.projections.getMessages(runId, agentName);
  }

  async getThreadAgentMessages(threadId: string, agentName: string): Promise<Message[]> {
    return this.projections.getThreadAgentMessages(threadId, agentName);
  }

  async listSpans(runId: string): Promise<SpanRecord[]> {
    return this.projections.listSpans(runId);
  }

  async getStepResult(runId: string, name: string): Promise<{ value: unknown } | undefined> {
    return this.projections.getStepResult(runId, name);
  }

  async getToolResult(runId: string, toolCallId: string): Promise<ToolResult | undefined> {
    return this.projections.getToolResult(runId, toolCallId);
  }

  async getInputs(runId: string): Promise<InputRequestProjectionRecord[]> {
    return this.projections.getInputs(runId);
  }

  async getInputById(inputRequestId: string): Promise<InputRequestProjectionRecord | undefined> {
    return this.projections.getInputById(inputRequestId);
  }

  async listInputs(opts?: ListInputsOptions): Promise<InputRequestProjectionRecord[]> {
    return this.projections.listInputs(opts);
  }

  async cleanup(opts: RetentionOptions): Promise<RetentionResult> {
    const now = (opts.now ?? new Date()).getTime();
    const eventHorizon = now - opts.eventRetentionDays * 86_400_000;
    const runHorizon = now - opts.runRetentionDays * 86_400_000;
    let eventDetailTrimmed = 0;
    let runsDeleted = 0;

    for (const run of this.projections.listRuns()) {
      if (!TERMINAL_STATUSES.has(run.status)) continue; // never trim active runs
      const age = Date.parse(run.finishedAt ?? run.startedAt);
      if (Number.isNaN(age)) continue;
      if (age < eventHorizon) {
        this.projections.trimEventDetail(run.id);
        this.events.deleteRun(run.id);
        eventDetailTrimmed += 1;
      }
      if (age < runHorizon) {
        this.projections.deleteRunSummary(run.id);
        runsDeleted += 1;
      }
    }
    return { eventDetailTrimmed, runsDeleted };
  }

  async reapStaleRuns(opts: ReapOptions): Promise<ReapResult> {
    const now = (opts.now ?? new Date()).getTime();
    const horizon = now - opts.staleMs;
    const runIds: string[] = [];
    // No durable queue in memory/inline mode, so there is no Lane B job to
    // protect: any non-terminal run with no recent activity is stranded.
    for (const run of this.projections.listRuns()) {
      if (run.status !== "running" && run.status !== "pending") continue;
      const events = await this.events.read(run.id);
      const last = events[events.length - 1];
      const lastTs = Date.parse(last?.ts ?? run.startedAt);
      if (Number.isNaN(lastTs) || lastTs >= horizon) continue;
      runIds.push(run.id);
    }
    for (const runId of runIds) {
      await this.events.append(
        buildEventRecord(
          runId,
          { type: "run.failed", error: "reaped: no progress (workflows host unreachable or task died)" },
          { agentName: this.projections.getRun(runId)?.workflow, spanId: runId },
        ),
      );
    }
    return { reaped: runIds.length, runIds };
  }

  // --- ThreadStore (metadata in-memory; transcript folded from the event log) ---

  async createThread(thread: Thread): Promise<void> {
    this.threads.set(thread.id, { ...thread });
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const t = this.threads.get(id);
    return t ? { ...t } : undefined;
  }

  async updateThread(id: string, patch: Partial<Thread>): Promise<void> {
    const t = this.threads.get(id);
    if (!t) return;
    this.threads.set(id, { ...t, ...patch, updatedAt: new Date().toISOString() });
  }

  async listThreads(opts?: { userId?: string }): Promise<Thread[]> {
    let rows = [...this.threads.values()];
    if (opts?.userId) rows = rows.filter(t => t.userId === opts.userId);
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return rows.map(t => ({ ...t }));
  }

  async getThreadMessages(threadId: string): Promise<ThreadMessage[]> {
    return this.projections.getThreadMessages(threadId);
  }

  // --- ScheduleStore (operational records; never auto-expired) ---

  async createSchedule(schedule: ScheduleRecord): Promise<void> {
    this.schedules.set(schedule.id, { ...schedule });
  }

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    const s = this.schedules.get(id);
    return s ? { ...s } : undefined;
  }

  async updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<void> {
    const s = this.schedules.get(id);
    if (!s) return;
    // `id`/`createdAt` are immutable; everything else is patchable.
    const { id: _id, createdAt: _createdAt, ...rest } = patch;
    void _id; void _createdAt;
    this.schedules.set(id, { ...s, ...rest, updatedAt: new Date().toISOString() });
  }

  async deleteSchedule(id: string): Promise<void> {
    this.schedules.delete(id);
  }

  async listSchedules(opts?: { userId?: string }): Promise<ScheduleRecord[]> {
    return [...this.schedules.values()]
      .filter((s) => opts?.userId === undefined || s.userId === opts.userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((s) => ({ ...s }));
  }

  async listEnabled(): Promise<ScheduleRecord[]> {
    return [...this.schedules.values()].filter((s) => s.enabled).map((s) => ({ ...s }));
  }

  // --- OAuthStore (plaintext in-memory; encryption is a Postgres at-rest concern) ---

  async getConnection(userId: string, provider: string): Promise<OAuthConnection | undefined> {
    const c = this.connections.get(`${userId}:${provider}`);
    return c ? { ...c } : undefined;
  }

  async upsertConnection(conn: OAuthConnection): Promise<void> {
    this.connections.set(`${conn.userId}:${conn.provider}`, { ...conn });
  }

  async deleteConnection(userId: string, provider: string): Promise<void> {
    this.connections.delete(`${userId}:${provider}`);
  }

  async listConnections(userId: string): Promise<OAuthConnection[]> {
    return [...this.connections.values()].filter(c => c.userId === userId).map(c => ({ ...c }));
  }

  async refreshConnection(
    userId: string,
    provider: string,
    isExpired: (conn: OAuthConnection) => boolean,
    doRefresh: (conn: OAuthConnection) => Promise<RefreshedTokens>,
  ): Promise<OAuthConnection | undefined> {
    const key = `${userId}:${provider}`;
    const inflight = this.refreshLocks.get(key);
    if (inflight) return inflight;

    const run = (async (): Promise<OAuthConnection | undefined> => {
      const conn = this.connections.get(key);
      if (!conn) return undefined;
      if (!isExpired(conn)) return { ...conn };
      const tokens = await doRefresh(conn);
      const updated: OAuthConnection = {
        ...conn,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? conn.refreshToken,
        expiresAt: tokens.expiresAt,
        updatedAt: new Date().toISOString(),
      };
      this.connections.set(key, updated);
      return { ...updated };
    })();

    this.refreshLocks.set(key, run);
    try {
      return await run;
    } finally {
      this.refreshLocks.delete(key);
    }
  }

  /** All projections for a run as a plain snapshot (used to validate replay equivalence). */
  snapshot(runId: string): ProjectionSnapshot {
    return this.projections.dump(runId);
  }
}

export function createMemoryStore(): MemoryRunStore {
  return new MemoryRunStore();
}

/**
 * Rebuilds every projection for a run purely from `read()`. If the result
 * matches the incrementally-folded projections, the folds are proven pure and
 * the log is sufficient to reconstruct all read models.
 */
export async function replay(events: EventLogStore, runId: string): Promise<ProjectionSnapshot> {
  const records = await events.read(runId);
  const projections = new Projections();
  for (const rec of records) projections.apply(rec);
  return projections.dump(runId);
}

/** Build a `RunEventRecord` from a `RunEvent` payload, filling defaults. `append` assigns the real `seq`. */
export function buildEventRecord(
  runId: string,
  event: RunEvent,
  meta?: { agentName?: string; spanId?: string; parentSpanId?: string; ts?: string; version?: number },
): RunEventRecord {
  return {
    id: randomUUID(),
    runId,
    seq: 0,
    ts: meta?.ts ?? new Date().toISOString(),
    category: categoryOf(event.type),
    type: event.type,
    agentName: meta?.agentName,
    spanId: meta?.spanId,
    parentSpanId: meta?.parentSpanId,
    payload: event,
    version: meta?.version ?? 1,
  };
}
