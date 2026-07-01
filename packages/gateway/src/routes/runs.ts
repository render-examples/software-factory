import { Hono, type Context } from "hono";
import type { RunStore, CancelStore, RunRecord } from "@render-agents/store";
import { aggregateRunCost } from "@render-agents/store";
import type { WorkflowDefinition } from "@render-agents/sdk";
import { getPrincipal, canAccess } from "../auth.js";

/** Upper bound on a single `/runs` page (CR-22). */
const MAX_LIST_LIMIT = 100;
/** Valid `?status=` filter values (CR-22). */
const RUN_STATUSES = new Set(["pending", "running", "paused", "completed", "failed", "cancelled"]);

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

  /** Load a run only if the caller may access it (operators: any; users: own).
   *  Returns undefined for missing OR foreign runs so ids aren't enumerable. */
  const loadOwnedRun = async (c: Context, id: string): Promise<RunRecord | undefined> => {
    const run = await store.getRun(id);
    return run && canAccess(run.userId, getPrincipal(c)) ? run : undefined;
  };

  // POST /workflows/:name — dispatch a workflow run (owned by the caller)
  app.post("/workflows/:name", async (c) => {
    const principal = getPrincipal(c);
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

    // Stamp ownership so the caller can see their own dispatched run.
    const run = await workflow.dispatch(body.input, body.trigger, { userId: principal.userId });
    return c.json(run, 202);
  });

  // GET /runs — list runs with keyset pagination
  app.get("/runs", async (c) => {
    const workflow = c.req.query("workflow");
    const statusRaw = c.req.query("status");
    // Validate status against the known set so a typo returns 400 rather than
    // silently yielding an empty list (CR-22).
    if (statusRaw !== undefined && !RUN_STATUSES.has(statusRaw)) {
      return c.json({ error: `invalid status "${statusRaw}"` }, 400);
    }
    const status = statusRaw as import("@render-agents/store").RunStatus | undefined;
    const threadId = c.req.query("threadId");
    const before = c.req.query("before");
    // Clamp limit to a sane maximum and reject non-finite/negative input so a
    // caller can't request an unbounded/NaN page (CR-22).
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: "limit must be a positive number" }, 400);
      }
      limit = Math.min(Math.floor(n), MAX_LIST_LIMIT);
    }
    // Default to top-level roots so the list isn't cluttered with workflow
    // fan-out / subagent child runs; pass roots=false to include them. A chat
    // thread's turns are themselves roots, so `threadId` + roots-only lets the UI
    // derive a thread's active run (the one non-terminal turn) without the data
    // model carrying a UI-shaped `currentRunId`.
    const roots = c.req.query("roots") !== "false";

    // Tenant scoping: operators (shared key) see all by default and may filter
    // with ?userId; end users are always confined to their own runs (CR-D1).
    const principal = getPrincipal(c);
    const userId = principal.role === "operator" ? c.req.query("userId") : principal.userId;

    const runs = await store.listRuns({ workflow, status, threadId, userId, before, limit, roots });
    return c.json({ runs });
  });

  // GET /runs/:id/children — child runs spawned by this run (workflow fan-out
  // or subagents), for cross-run trace stitching in the operator UI.
  app.get("/runs/:id/children", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const runs = await store.listChildRuns(id);
    return c.json({ runs });
  });

  // GET /runs/:id — run details (+ all-in cost incl. subagent descendants)
  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const aggregateCostUsd = await aggregateRunCost(store, id);
    // Surface *why* a run is paused (approval vs input) so clients don't have to
    // infer it from the approval list — the authoritative signal is the last
    // `run.paused` event's reason (BUG-12). Only computed for a paused run.
    let pauseReason: "approval" | "input" | undefined;
    if (run.status === "paused") {
      const events = await store.events.read(id);
      for (let i = events.length - 1; i >= 0; i--) {
        const p = events[i].payload;
        if (p.type === "run.paused") { pauseReason = p.reason; break; }
      }
    }
    return c.json({ ...run, aggregateCostUsd, pauseReason });
  });

  // GET /runs/:id/spans — span tree for a run
  app.get("/runs/:id/spans", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const spans = await store.listSpans(id);
    return c.json({ spans });
  });

  // GET /runs/:id/tool-calls — tool calls + results
  app.get("/runs/:id/tool-calls", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
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
    const run = await loadOwnedRun(c, id);
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
    const run = await loadOwnedRun(c, id);
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
