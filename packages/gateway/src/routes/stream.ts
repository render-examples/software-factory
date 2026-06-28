import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunStore } from "@render-agents/store";

/**
 * SSE streaming routes. The stream is a live tail of the event log
 * filtered by runId or threadId, resumable from a seq offset.
 */
export function streamRoutes(deps: { store: RunStore }) {
  const app = new Hono();
  const { store } = deps;

  // GET /runs/:id/stream — SSE of a single run's events
  app.get("/runs/:id/stream", async (c) => {
    const runId = c.req.param("id");
    const run = await store.getRun(runId);
    if (!run) {
      return c.json({ error: `Run "${runId}" not found` }, 404);
    }

    const fromSeq = Number(c.req.query("seq") ?? c.req.header("Last-Event-ID") ?? "0");

    return streamSSE(c, async (stream) => {
      // Catch-up: replay existing events from the requested seq
      const existing = await store.events.read(runId, fromSeq > 0 ? fromSeq : undefined);
      for (const event of existing) {
        await stream.writeSSE({
          id: String(event.seq),
          event: event.category,
          data: JSON.stringify(event.payload),
        });
      }

      // If the run is already terminal, close the stream
      const currentRun = await store.getRun(runId);
      if (currentRun && isTerminal(currentRun.status)) {
        return;
      }

      // Live tail
      const controller = new AbortController();
      const onClose = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", onClose);

      try {
        const tail = store.events.tail({ runId }, controller.signal);
        for await (const event of tail) {
          await stream.writeSSE({
            id: String(event.seq),
            event: event.category,
            data: JSON.stringify(event.payload),
          });

          // Close when run reaches terminal state
          if (event.payload.type === "run.completed" ||
              event.payload.type === "run.failed" ||
              event.payload.type === "run.cancelled") {
            break;
          }
        }
      } finally {
        c.req.raw.signal.removeEventListener("abort", onClose);
      }
    });
  });

  // GET /threads/:id/stream — thread stream spanning all runs
  app.get("/threads/:id/stream", async (c) => {
    const threadId = c.req.param("id");
    const fromSeq = Number(c.req.query("seq") ?? c.req.header("Last-Event-ID") ?? "0");

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const onClose = () => controller.abort();
      c.req.raw.signal.addEventListener("abort", onClose);

      try {
        // Thread streams stay open across runs — filter by threadId
        const tail = store.events.tail({ threadId }, controller.signal);
        for await (const event of tail) {
          if (fromSeq > 0 && event.seq <= fromSeq) continue;
          await stream.writeSSE({
            id: String(event.seq),
            event: event.category,
            data: JSON.stringify(event.payload),
          });
        }
      } finally {
        c.req.raw.signal.removeEventListener("abort", onClose);
      }
    });
  });

  return app;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
