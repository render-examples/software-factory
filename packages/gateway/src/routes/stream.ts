import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type { DeltaBus, RunEventRecord, RunStore, StreamDelta } from "@render-agents/store";

/**
 * SSE streaming routes. A stream is a live tail of the durable event log
 * (filtered by runId or threadId, resumable from a seq offset) merged with the
 * transient token-delta bus (D13) for live, token-level streaming.
 *
 * Durable events carry an SSE `id` (their `seq`) so `Last-Event-ID` reconnects
 * resume exactly. Transient `text.delta` frames carry NO `id` — they are never
 * persisted and never replayed; a reconnecting client skips them and converges
 * on the durable `message.assistant`.
 */
export function streamRoutes(deps: { store: RunStore; deltaBus?: DeltaBus }) {
  const app = new Hono();
  const { store, deltaBus } = deps;

  // GET /runs/:id/stream — SSE of a single run's events + live token deltas
  app.get("/runs/:id/stream", async (c) => {
    const runId = c.req.param("id");
    const run = await store.getRun(runId);
    if (!run) {
      return c.json({ error: `Run "${runId}" not found` }, 404);
    }

    const fromSeq = Number(c.req.query("seq") ?? c.req.header("Last-Event-ID") ?? "0");

    return streamSSE(c, async (stream) => {
      // Catch-up: replay existing durable events from the requested seq.
      const existing = await store.events.read(runId, fromSeq > 0 ? fromSeq : undefined);
      for (const event of existing) {
        await writeEvent(stream, event.category, event.payload, event.seq);
      }

      // If the run is already terminal, close the stream.
      const currentRun = await store.getRun(runId);
      if (currentRun && isTerminal(currentRun.status)) {
        return;
      }

      const controller = new AbortController();
      const onClose = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", onClose);

      try {
        const merged = mergeEventsAndDeltas(
          store.events.tail({ runId }, controller.signal),
          deltaBus?.subscribe({ runId }, controller.signal),
          controller.signal,
        );
        for await (const item of merged) {
          if (item.kind === "delta") {
            await writeDelta(stream, item.value);
            continue;
          }
          const event = item.value;
          await writeEvent(stream, event.category, event.payload, event.seq);
          // Close when the run reaches a terminal state.
          if (event.payload.type === "run.completed" ||
              event.payload.type === "run.failed" ||
              event.payload.type === "run.cancelled") {
            break;
          }
        }
      } finally {
        c.req.raw.signal.removeEventListener("abort", onClose);
        controller.abort();
      }
    });
  });

  // GET /events/stream — global live tail across ALL runs (operator rail). No
  // token deltas here: the rail counts runs/approvals, not assistant text.
  app.get("/events/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const onClose = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", onClose);

      try {
        const tail = store.events.tail({}, controller.signal);
        for await (const event of tail) {
          await stream.writeSSE({
            id: String(event.seq),
            event: event.category,
            data: JSON.stringify({
              runId: event.runId,
              seq: event.seq,
              ts: event.ts,
              category: event.category,
              type: event.type,
              agentName: event.agentName,
              spanId: event.spanId,
              parentSpanId: event.parentSpanId,
              payload: event.payload,
            }),
          });
        }
      } finally {
        c.req.raw.signal.removeEventListener("abort", onClose);
      }
    });
  });

  // GET /threads/:id/stream — thread stream spanning all runs + live token deltas
  app.get("/threads/:id/stream", async (c) => {
    const threadId = c.req.param("id");
    const fromSeq = Number(c.req.query("seq") ?? c.req.header("Last-Event-ID") ?? "0");

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const onClose = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", onClose);

      try {
        const merged = mergeEventsAndDeltas(
          store.events.tail({ threadId }, controller.signal),
          deltaBus?.subscribe({ threadId }, controller.signal),
          controller.signal,
        );
        for await (const item of merged) {
          if (item.kind === "delta") {
            await writeDelta(stream, item.value);
            continue;
          }
          const event = item.value;
          if (fromSeq > 0 && event.seq <= fromSeq) continue;
          await writeEvent(stream, event.category, event.payload, event.seq);
        }
      } finally {
        c.req.raw.signal.removeEventListener("abort", onClose);
        controller.abort();
      }
    });
  });

  return app;
}

/** Write a durable event: SSE `id` = seq so `Last-Event-ID` reconnect resumes exactly. */
function writeEvent(
  stream: SSEStreamingApi,
  category: string,
  payload: unknown,
  seq: number,
): Promise<void> {
  return stream.writeSSE({ id: String(seq), event: category, data: JSON.stringify(payload) });
}

/**
 * Write a transient token delta as a `message`-category `text.delta` frame. No
 * SSE `id` — deltas are non-durable and must not move the reconnect cursor.
 */
function writeDelta(stream: SSEStreamingApi, delta: StreamDelta): Promise<void> {
  return stream.writeSSE({
    event: "message",
    data: JSON.stringify({
      type: "text.delta",
      runId: delta.runId,
      agentName: delta.agentName,
      seq: delta.seq,
      text: delta.text,
    }),
  });
}

type MergedItem =
  | { kind: "event"; value: RunEventRecord }
  | { kind: "delta"; value: StreamDelta };

/**
 * Merge the durable event tail with the transient delta stream into a single
 * ordered-by-arrival async sequence, so one consumer writes both without
 * concurrent-write hazards. The delta source is optional (no bus wired).
 */
async function* mergeEventsAndDeltas(
  events: AsyncIterable<RunEventRecord>,
  deltas: AsyncIterable<StreamDelta> | undefined,
  signal: AbortSignal,
): AsyncGenerator<MergedItem> {
  const sources: Array<{ it: AsyncIterator<RunEventRecord | StreamDelta>; kind: "event" | "delta" }> = [
    { it: events[Symbol.asyncIterator](), kind: "event" },
  ];
  if (deltas) sources.push({ it: deltas[Symbol.asyncIterator](), kind: "delta" });

  const pending = new Map<number, Promise<{ index: number; res: IteratorResult<RunEventRecord | StreamDelta> }>>();
  sources.forEach((s, i) => pending.set(i, s.it.next().then((res) => ({ index: i, res }))));

  try {
    while (pending.size > 0) {
      if (signal.aborted) return;
      const { index, res } = await Promise.race(pending.values());
      if (res.done) {
        pending.delete(index);
        continue;
      }
      const kind = sources[index].kind;
      yield kind === "event"
        ? { kind: "event", value: res.value as RunEventRecord }
        : { kind: "delta", value: res.value as StreamDelta };
      pending.set(index, sources[index].it.next().then((r) => ({ index, res: r })));
    }
  } finally {
    for (const s of sources) void s.it.return?.();
  }
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
