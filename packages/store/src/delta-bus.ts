/**
 * The transient token-delta bus (D13) — the *streaming* side channel that lives
 * entirely OUTSIDE the event log. Token-level `text.delta`s are high-frequency,
 * ephemeral, and valueless as history, so they are never appended to
 * `run_events`, never folded into a projection, and never retained. The durable
 * `message.assistant` event (emitted once per turn) remains the single source of
 * truth; deltas are a pure live-preview layer that a reconnecting client simply
 * skips (it refetches the canonical transcript instead).
 *
 * Two implementations mirror the store/queue pattern:
 * - `MemoryDeltaBus` — in-process fan-out (local dev / `inline` mode, tests).
 * - `PgDeltaBus` — Postgres `LISTEN/NOTIFY` on a dedicated channel, so the warm
 *   worker (generation) and the gateway (SSE) can live in different processes
 *   (D12). Payloads are small and carried inline (well under the NOTIFY limit);
 *   nothing is persisted.
 */

/** A single coalesced token-delta for a run's in-flight assistant turn. */
export interface StreamDelta {
  runId: string;
  /** Set so a thread SSE stream can filter without a DB lookup on the hot path. */
  threadId?: string;
  agentName: string;
  /** Per-run monotonic delta sequence, independent of `run_events.seq`. */
  seq: number;
  text: string;
}

export interface DeltaBus {
  /** Publish one coalesced delta. Best-effort and non-durable — never throws into the loop. */
  publish(delta: StreamDelta): Promise<void>;
  /**
   * Live subscription to deltas matching a run or thread. Yields only deltas
   * published *after* subscription (no catch-up — there is no history to replay).
   */
  subscribe(
    filter: { runId?: string; threadId?: string },
    signal: AbortSignal,
  ): AsyncIterable<StreamDelta>;
}

/** The Postgres NOTIFY channel used by `PgDeltaBus`. Distinct from `run_events`. */
export const DELTA_CHANNEL = "run_deltas";

/**
 * In-process, single-consumer async queue with abort/close support and a
 * bounded backlog. Deltas are transient live-preview text, so if a subscriber
 * falls hopelessly behind (a stalled SSE socket during a fast stream) we drop
 * the OLDEST buffered deltas rather than grow memory without bound — the client
 * converges on the durable `message.assistant` regardless of any dropped preview.
 */
export class DeltaQueue<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  constructor(private readonly maxItems = 10_000) {}

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    if (this.items.length > this.maxItems) this.items.shift();
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *drain(signal: AbortSignal): AsyncGenerator<T> {
    const onAbort = () => this.wake?.();
    signal.addEventListener("abort", onAbort);
    try {
      while (!signal.aborted && !this.closed) {
        while (this.items.length > 0) {
          yield this.items.shift() as T;
        }
        if (signal.aborted || this.closed) return;
        await new Promise<void>((resolve) => { this.wake = resolve; });
        this.wake = null;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** True when `delta` should be delivered to a subscriber with `filter`. */
export function deltaMatchesFilter(
  filter: { runId?: string; threadId?: string },
  delta: StreamDelta,
): boolean {
  if (!filter.runId && !filter.threadId) return true;
  if (filter.runId && filter.runId === delta.runId) return true;
  if (filter.threadId && filter.threadId === delta.threadId) return true;
  return false;
}

/**
 * In-process delta bus: publishers and subscribers share one process. Used in
 * `inline` mode (gateway drives the turn itself), local dev, and tests.
 */
export class MemoryDeltaBus implements DeltaBus {
  private readonly subs = new Set<{
    filter: { runId?: string; threadId?: string };
    queue: DeltaQueue<StreamDelta>;
  }>();

  async publish(delta: StreamDelta): Promise<void> {
    for (const sub of this.subs) {
      if (deltaMatchesFilter(sub.filter, delta)) sub.queue.push(delta);
    }
  }

  subscribe(
    filter: { runId?: string; threadId?: string },
    signal: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const queue = new DeltaQueue<StreamDelta>();
    const entry = { filter, queue };
    this.subs.add(entry);
    const subs = this.subs;
    async function* generator(): AsyncGenerator<StreamDelta> {
      try {
        yield* queue.drain(signal);
      } finally {
        subs.delete(entry);
      }
    }
    return generator();
  }
}
