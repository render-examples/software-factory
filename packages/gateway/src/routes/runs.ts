import { Hono, type Context } from "hono";
import type { RunStore, CancelStore, RunRecord } from "@render-factory/store";
import { aggregateRunCost } from "@render-factory/store";
import type { WorkflowDefinition } from "@render-factory/sdk";
import { getPrincipal, canAccess } from "../auth.js";

/** Upper bound on a single `/runs` page (CR-22). */
const MAX_LIST_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;
/** Valid `?status=` filter values (CR-22). */
const RUN_STATUS_LIST = ["pending", "running", "paused", "completed", "failed", "cancelled"] as const;
const RUN_STATUSES = new Set<string>(RUN_STATUS_LIST);
const EVENT_CATEGORIES = new Set(["lifecycle", "message", "tool", "step", "model", "input", "delegation", "context"]);

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
  const toApproval = (input: Awaited<ReturnType<RunStore["getInputs"]>>[number]) => ({
    id: input.inputRequestId,
    runId: input.runId,
    kind: input.kind,
    toolName: input.toolName,
    input: input.input,
    prompt: input.prompt,
    value: input.value,
    agentName: input.agentName,
    status: input.status,
    requestedAt: input.requestedAt,
    resolvedAt: input.resolvedAt,
    providedBy: input.providedBy,
    reason: input.reason,
  });

  // --- Dispatch ---

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

    const run = await workflow.dispatch(body.input, body.trigger, { userId: principal.userId });
    return c.json(run, 202);
  });

  // --- List & Inspect ---

  app.get("/runs", async (c) => {
    const workflow = c.req.query("workflow");
    const statusRaw = c.req.query("status");
    // Validate against the known set so a typo 400s instead of silently empty (CR-22).
    if (statusRaw !== undefined && !RUN_STATUSES.has(statusRaw)) {
      return c.json({ error: `invalid status "${statusRaw}"` }, 400);
    }
    const status = statusRaw as import("@render-factory/store").RunStatus | undefined;
    const threadId = c.req.query("threadId");
    const before = c.req.query("before");
    // Clamp to a sane max and reject non-finite/negative input (CR-22).
    const rawLimit = c.req.query("limit");
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: "limit must be a positive number" }, 400);
      }
      limit = Math.min(Math.floor(n), MAX_LIST_LIMIT);
    }
    // Default to top-level roots (excludes fan-out/subagent children); a
    // thread's turns are themselves roots, so threadId + roots-only lets the UI
    // derive the active run without a UI-shaped currentRunId field.
    const roots = c.req.query("roots") !== "false";

    // Operators see all by default and may filter with ?userId; end users are
    // always confined to their own runs (CR-D1).
    const principal = getPrincipal(c);
    const userId = principal.role === "operator" ? c.req.query("userId") : principal.userId;

    const runs = await store.listRuns({ workflow, status, threadId, userId, before, limit, roots });
    return c.json({ runs });
  });

  app.get("/runs/counts", async (c) => {
    const workflow = c.req.query("workflow");
    const threadId = c.req.query("threadId");
    const roots = c.req.query("roots") !== "false";
    const principal = getPrincipal(c);
    const userId = principal.role === "operator" ? c.req.query("userId") : principal.userId;

    const buckets = await Promise.all(
      RUN_STATUS_LIST.map((status) =>
        store.listRuns({
          workflow,
          threadId,
          userId,
          roots,
          status: status as import("@render-factory/store").RunStatus,
        }),
      ),
    );
    const counts = {
      pending: buckets[0].length,
      running: buckets[1].length,
      paused: buckets[2].length,
      completed: buckets[3].length,
      failed: buckets[4].length,
      cancelled: buckets[5].length,
    };
    return c.json({ counts, active: counts.running + counts.paused });
  });

  // Child runs (fan-out/subagents), for cross-run trace stitching in the operator UI.
  app.get("/runs/:id/children", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const runs = await store.listChildRuns(id);
    return c.json({ runs });
  });

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const aggregateCostUsd = await aggregateRunCost(store, id);
    // Surface why a run is paused (approval vs input) from the authoritative
    // last run.paused event, rather than inferring it from the approval list (BUG-12).
    let pauseReason: "input" | undefined;
    if (run.status === "paused") {
      const events = await store.events.read(id);
      for (let i = events.length - 1; i >= 0; i--) {
        const p = events[i].payload;
        if (p.type === "run.paused") { pauseReason = p.reason; break; }
      }
    }
    return c.json({ ...run, aggregateCostUsd, pauseReason });
  });

  app.get("/runs/:id/view", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const [aggregateCostUsd, spans, inputs] = await Promise.all([
      aggregateRunCost(store, id),
      store.listSpans(id),
      store.getInputs(id),
    ]);
    let pauseReason: "input" | undefined;
    if (run.status === "paused") {
      const events = await store.events.read(id);
      for (let i = events.length - 1; i >= 0; i--) {
        const p = events[i].payload;
        if (p.type === "run.paused") { pauseReason = p.reason; break; }
      }
    }
    const approvals = inputs
      .filter((input) => input.status === "pending" && input.kind === "approval")
      .map(toApproval);
    return c.json({
      run: { ...run, aggregateCostUsd, pauseReason },
      spans,
      approvals,
    });
  });

  app.get("/runs/:id/spans", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const spans = await store.listSpans(id);
    return c.json({ spans });
  });

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

  // Convenience read for the operator UI's event-log inspector; same data is
  // otherwise reconstructable from the SSE stream's catch-up replay.
  app.get("/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const run = await loadOwnedRun(c, id);
    if (!run) {
      return c.json({ error: `Run "${id}" not found` }, 404);
    }
    const parsedSeq = parseNonNegativeInt(c.req.query("seq"), "seq");
    if (!parsedSeq.ok) {
      return c.json({ error: parsedSeq.error }, 400);
    }
    const category = c.req.query("category");
    if (category !== undefined && !EVENT_CATEGORIES.has(category)) {
      return c.json({ error: `invalid category "${category}"` }, 400);
    }
    const parsedLimit = parsePositiveInt(c.req.query("limit"), "limit");
    if (!parsedLimit.ok) {
      return c.json({ error: parsedLimit.error }, 400);
    }
    const q = c.req.query("q")?.trim().toLowerCase();
    const fromSeq = parsedSeq.value && parsedSeq.value > 0 ? parsedSeq.value : undefined;
    let events = await store.events.read(id, fromSeq);
    if (category) {
      events = events.filter((e) => e.category === category);
    }
    if (q) {
      events = events.filter((e) => {
        const hay = `${e.type} ${e.agentName ?? ""} ${JSON.stringify(e.payload)}`.toLowerCase();
        return hay.includes(q);
      });
    }
    const limit = Math.min(parsedLimit.value ?? MAX_EVENT_LIMIT, MAX_EVENT_LIMIT);
    if (events.length > limit) {
      events = events.slice(0, limit);
    }
    return c.json({ events });
  });

  // --- Cancel ---

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

function parseNonNegativeInt(
  raw: string | undefined,
  label: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(raw)) return { ok: false, error: `${label} must be a non-negative integer` };
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return { ok: false, error: `${label} is out of range` };
  return { ok: true, value: n };
}

function parsePositiveInt(
  raw: string | undefined,
  label: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(raw)) return { ok: false, error: `${label} must be a positive integer` };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, error: `${label} must be a positive integer` };
  return { ok: true, value: n };
}
