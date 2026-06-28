import { randomUUID } from "node:crypto";
import type {
  EventLogStore,
  EventInterceptor,
  RunEvent,
  RunEventRecord,
  ToolResult,
} from "./events.js";
import { categoryOf } from "./categories.js";
import type { Message } from "./messages.js";
import type { RunStore, RunRecord, SpanRecord, ListRunsOptions, ListApprovalsOptions } from "./run-store.js";
import type { Thread, ThreadMessage, ThreadStore } from "./thread-store.js";
import type { ApprovalProjectionRecord } from "./projections.js";
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

/**
 * In-memory append-only event log. `append` is the single write path: it runs
 * the optional pre-commit interceptor, assigns a gap-free per-run `seq`, folds
 * every registered projection, and notifies live tail subscribers — atomically
 * (synchronously here; the Postgres store makes this one transaction).
 */
export class MemoryEventLogStore implements EventLogStore {
  private byRun = new Map<string, RunEventRecord[]>();
  private subscribers = new Set<Subscriber>();
  private interceptor?: EventInterceptor;

  constructor(private readonly projections: Projections) {}

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

    const events = this.byRun.get(record.runId) ?? [];
    const expected = events.length + 1;
    // `append` assigns the seq. If the caller pinned one (e.g. a test), it must
    // match the next gap-free position — duplicates / out-of-order are rejected.
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
    this.projections.apply(stored);
    this.publish(stored);
  }

  async read(runId: string, fromSeq?: number): Promise<RunEventRecord[]> {
    const events = this.byRun.get(runId) ?? [];
    const slice = fromSeq !== undefined ? events.filter(e => e.seq >= fromSeq) : events;
    return slice.map(e => ({ ...e }));
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

  private publish(rec: RunEventRecord): void {
    const copy = { ...rec, payload: { ...rec.payload } };
    for (const sub of this.subscribers) {
      if (sub.filter.runId && sub.filter.runId !== rec.runId) continue;
      // The in-memory store has no thread→run mapping (threads are Postgres-only
      // for now). A threadId-only filter therefore matches nothing here rather
      // than incorrectly leaking every run's events.
      if (sub.filter.threadId && !sub.filter.runId) continue;
      sub.queue.push(copy);
      sub.wake?.();
    }
  }
}

/**
 * In-memory `RunStore`: reads are pure projections folded from the event log.
 * Writes go exclusively through `events.append` — there are no direct
 * projection writers.
 */
export class MemoryRunStore implements RunStore, ThreadStore {
  private readonly projections = new Projections();
  /** Thread metadata (created via the gateway API, not folded from events). */
  private readonly threads = new Map<string, Thread>();
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

  async getMessages(runId: string, agentName: string): Promise<Message[]> {
    return this.projections.getMessages(runId, agentName);
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

  async getApprovals(runId: string): Promise<ApprovalProjectionRecord[]> {
    return this.projections.getApprovals(runId);
  }

  async listApprovals(opts?: ListApprovalsOptions): Promise<ApprovalProjectionRecord[]> {
    return this.projections.listApprovals(opts);
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
