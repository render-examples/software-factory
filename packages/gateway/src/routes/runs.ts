import { Hono } from "hono";
import type { RunStore, CancelStore } from "@render-agents/store";
import { aggregateRunCost } from "@render-agents/store";
import type { WorkflowDefinition } from "@render-agents/sdk";

/**
 * Core run-facing routes: dispatch, list, inspect, cancel.
 * Reads are pure projection queries against the RunStore.
 */
export function runRoutes(deps: {
  store: RunStore;
  cancelStore: CancelStore;
  workflows: Map<string, WorkflowDefinition>;
}) {
  const app = new Hono();
  const { store, cancelStore, workflows } = deps;

  // POST /workflows/:name — dispatch a workflow run
  app.post("/workflows/:name", async (c) => {
    const name = c.req.param("name");
    const workflow = workflows.get(name);
    if (!workflow) {
      return c.json({ error: `Workflow "${name}" not found` }, 404);
    }

    let body: { input?: unknown; trigger?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body.input === undefined || body.input === null || body.input === "") {
      return c.json({ error: "input is required and must be non-empty" }, 400);
    }

    const run = await workflow.dispatch(body.input, body.trigger);
    return c.json(run, 202);
  });

  // GET /runs — list runs with keyset pagination
  app.get("/runs", async (c) => {
    const workflow = c.req.query("workflow");
    const status = c.req.query("status") as import("@render-agents/store").RunStatus | undefined;
    const before = c.req.query("before");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

    const runs = await store.listRuns({ workflow, status, before, limit });
    return c.json({ runs });
  });

  // GET /runs/:id — run details (+ all-in cost incl. subagent descendants)
  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await store.getRun(id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const aggregateCostUsd = await aggregateRunCost(store, id);
    return c.json({ ...run, aggregateCostUsd });
  });

  // GET /runs/:id/spans — span tree for a run
  app.get("/runs/:id/spans", async (c) => {
    const id = c.req.param("id");
    const run = await store.getRun(id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const spans = await store.listSpans(id);
    return c.json({ spans });
  });

  // GET /runs/:id/tool-calls — tool calls + results
  app.get("/runs/:id/tool-calls", async (c) => {
    const id = c.req.param("id");
    const run = await store.getRun(id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const events = await store.events.read(id);
    const toolCalls = events
      .filter((e) => e.payload.type === "tool.called" || e.payload.type === "tool.result")
      .map((e) => ({
        seq: e.seq,
        eventType: e.payload.type,
        payload: e.payload,
      }));
    return c.json({ toolCalls });
  });

  // GET /runs/:id/events — the ordered raw event log for a run (debug lens).
  // Convenience read for the operator UI's event-log inspector; the same data is
  // otherwise reconstructable from the SSE stream's catch-up replay.
  app.get("/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const run = await store.getRun(id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const fromSeq = c.req.query("seq") ? Number(c.req.query("seq")) : undefined;
    const events = await store.events.read(id, fromSeq);
    return c.json({ events });
  });

  // POST /runs/:id/cancel — cancel a running or paused run
  app.post("/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const run = await store.getRun(id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    if (run.status !== "running" && run.status !== "paused" && run.status !== "pending") {
      return c.json({ error: `Run "${id}" is already ${run.status}` }, 409);
    }
    await cancelStore.requestCancel(id);
    return c.json({ status: "cancelled", runId: id });
  });

  return app;
}
