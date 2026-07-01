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
        await writeEvent(stream, event.category, event.payload, String(event.seq));
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
          await writeEvent(stream, event.category, event.payload, String(event.seq));
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
  //
  // Live-tail only by design (no connect-time replay): a global replay of the
  // whole log would be unbounded, and the operator UI already refetches counts
  // via REST on (re)connect, so the tail only needs to carry *new* events. The
  // SSE `id` is composite (`runId:seq`) so a reconnecting client can still
  // de-dupe reliably — per-run `seq` alone collides across runs (BUG-07).
  app.get("/events/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const onClose = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", onClose);

      try {
        const tail = store.events.tail({}, controller.signal);
        for await (const event of tail) {
          await stream.writeSSE({
            id: `${event.runId}:${event.seq}`,
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
        // Abort the tail on any exit (client disconnect, write error) so the
        // Postgres LISTEN connection is released promptly — the run/thread streams
        // already do this; the global stream must too (CR-21).
        controller.abort();
      }
    });
  });

  // GET /threads/:id/stream — thread stream spanning all runs + live token deltas
  app.get("/threads/:id/stream", async (c) => {
    const threadId = c.req.param("id");
    // Reconnect cursor is a composite `runId:seq` (see below); the numeric `seq`
    // query is unused for the thread stream since per-run seq is ambiguous here.
    const lastEventId = c.req.header("Last-Event-ID") ?? c.req.query("cursor") ?? undefined;

    return streamSSE(c, async (stream) => {
      // Catch-up replay so a (re)connecting client converges on the full thread
      // history instead of only seeing events after it happened to connect
      // (BUG-07). Events span multiple runs, so each carries a composite
      // `runId:seq` SSE id; the client resumes from its `Last-Event-ID`.
      const history = await store.events.readThread(threadId);
      const cid = (e: { runId: string; seq: number }) => `${e.runId}:${e.seq}`;
      let resumeFrom = 0;
      if (lastEventId && lastEventId.includes(":")) {
        const idx = history.findIndex((e) => cid(e) === lastEventId);
        if (idx >= 0) resumeFrom = idx + 1; // resume strictly after the last-seen event
      }
      // Track the catch-up ids so the live tail can drop the small overlap of
      // events appended between the history snapshot and the tail subscription.
      const replayed = new Set<string>();
      for (let i = resumeFrom; i < history.length; i++) {
        const e = history[i];
        replayed.add(cid(e));
        await writeEvent(stream, e.category, e.payload, cid(e));
      }

      const controller = new AbortController();
      const onClose = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", onClose);

      try {
        const merged = mergeEventsAndDeltas(
          store.events.tail({ threadId }, controller.signal),
          deltaBus?.subscribe({ threadId }, controller.signal),
          controller.signal,
        );
        let overlapCleared = false;
        for await (const item of merged) {
          if (item.kind === "delta") {
            await writeDelta(stream, item.value);
            continue;
          }
          const event = item.value;
          const id = cid(event);
          if (!overlapCleared) {
            // Once a live event isn't part of the catch-up set, the overlap is
            // past — every later event is new, so stop tracking (bounds memory).
            if (replayed.has(id)) continue;
            overlapCleared = true;
            replayed.clear();
          }
          await writeEvent(stream, event.category, event.payload, id);
        }
      } finally {
        c.req.raw.signal.removeEventListener("abort", onClose);
        controller.abort();
      }
    });
  });

  return app;
}

/**
 * Write a durable event with an explicit SSE `id` so `Last-Event-ID` reconnect
 * resumes exactly. Single-run streams pass the numeric `seq`; thread/global
 * streams pass a composite `runId:seq` because per-run `seq` restarts at 1 and
 * would otherwise collide across the runs in a thread (BUG-07).
 */
function writeEvent(
  stream: SSEStreamingApi,
  category: string,
  payload: unknown,
  id: string,
): Promise<void> {
  return stream.writeSSE({ id, event: category, data: JSON.stringify(payload) });
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
