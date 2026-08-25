import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ScheduleStore, ScheduleRecord } from "@render-factory/store";
import { validateCron, dueSchedules } from "@render-factory/store";
import type { WorkflowDefinition } from "@render-factory/sdk";
import { getPrincipal, canAccess } from "../auth.js";

const PATCHABLE_SCHEDULE_FIELDS = new Set(["workflow", "cronExpression", "input", "enabled"]);

export interface ScheduleRoutesDeps {
  scheduleStore: ScheduleStore;
  workflows: Map<string, WorkflowDefinition>;
  /** Clock injection for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Result of one reconcile pass — what the tick fired (and skipped).
 */
export interface ReconcileResult {
  checked: number;
  fired: Array<{ scheduleId: string; workflow: string; runId: string }>;
  skipped: Array<{ scheduleId: string; reason: string }>;
}

/**
 * Fire every schedule that is due at `now`: enabled, cron matches the current
 * minute, and not already fired this minute (idempotent under tick retries).
 * Each fire dispatches the schedule's workflow (trigger `"cron"`) and stamps
 * `lastRunId`/`lastRunAt`. A missing workflow or a dispatch failure is recorded
 * in `skipped` and never aborts the rest of the pass.
 */
export async function reconcileDueSchedules(deps: ScheduleRoutesDeps, now: Date): Promise<ReconcileResult> {
  const enabled = await deps.scheduleStore.listEnabled();
  const due = dueSchedules(enabled, now);
  const result: ReconcileResult = { checked: enabled.length, fired: [], skipped: [] };

  for (const s of due) {
    const workflow = deps.workflows.get(s.workflow);
    if (!workflow) {
      result.skipped.push({ scheduleId: s.id, reason: `workflow "${s.workflow}" not found` });
      continue;
    }
    // Snapshot the dedupe marker so a failed dispatch can be rolled back.
    const previousLastRunAt = s.lastRunAt;
    try {
      // Stamp before dispatch so a concurrent/retried tick in the same minute dedupes.
      await deps.scheduleStore.updateSchedule(s.id, { lastRunAt: now.toISOString() });
      const run = await workflow.dispatch(s.input ?? {}, "cron", { userId: s.userId });
      await deps.scheduleStore.updateSchedule(s.id, { lastRunId: run.id, lastRunAt: now.toISOString() });
      result.fired.push({ scheduleId: s.id, workflow: s.workflow, runId: run.id });
    } catch (err) {
      // Roll dedupe marker back to a pre-minute timestamp so the next tick
      // retries (CR-11); defined value needed since updateSchedule treats
      // undefined as "no change".
      const restore = previousLastRunAt ?? new Date(now.getTime() - 60_000).toISOString();
      await deps.scheduleStore.updateSchedule(s.id, { lastRunAt: restore }).catch(() => {});
      result.skipped.push({ scheduleId: s.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Runtime-managed schedule routes: CRUD over the schedule store plus the
 * reconcile tick. The tick is driven by a per-minute Render Cron hitting
 * `POST /admin/schedules/tick` (the same operational pattern as
 * `/admin/retention`), so no in-process timer is needed.
 */
export function scheduleRoutes(deps: ScheduleRoutesDeps) {
  const app = new Hono();
  const { scheduleStore, workflows } = deps;
  const now = deps.now ?? (() => new Date());

  app.post("/admin/schedules/tick", async (c) => {
    const result = await reconcileDueSchedules(deps, now());
    return c.json(result);
  });

  app.post("/schedules", async (c) => {
    let body: { workflow?: string; cronExpression?: string; input?: unknown; enabled?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.workflow || typeof body.workflow !== "string") {
      return c.json({ error: "workflow is required" }, 400);
    }
    if (!workflows.has(body.workflow)) {
      return c.json({ error: `Workflow "${body.workflow}" not found` }, 400);
    }
    if (!body.cronExpression || typeof body.cronExpression !== "string") {
      return c.json({ error: "cronExpression is required" }, 400);
    }
    const cronError = validateCron(body.cronExpression);
    if (cronError) {
      return c.json({ error: cronError }, 400);
    }
    const ts = now().toISOString();
    // Ownership comes from auth, never the client body (CR-D1).
    const record: ScheduleRecord = {
      id: randomUUID(),
      workflow: body.workflow,
      cronExpression: body.cronExpression,
      input: body.input,
      enabled: body.enabled ?? true,
      userId: getPrincipal(c).userId,
      createdAt: ts,
      updatedAt: ts,
    };
    await scheduleStore.createSchedule(record);
    return c.json(record, 201);
  });

  app.get("/schedules", async (c) => {
    const principal = getPrincipal(c);
    const userId = principal.role === "operator" ? c.req.query("userId") : principal.userId;
    const schedules = await scheduleStore.listSchedules({ userId });
    return c.json({ schedules });
  });

  app.get("/schedules/:id", async (c) => {
    const schedule = await scheduleStore.getSchedule(c.req.param("id"));
    if (!schedule || !canAccess(schedule.userId, getPrincipal(c))) {
      return c.json({ error: "Schedule not found" }, 404);
    }
    return c.json(schedule);
  });

  app.patch("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await scheduleStore.getSchedule(id);
    if (!existing || !canAccess(existing.userId, getPrincipal(c))) {
      return c.json({ error: "Schedule not found" }, 404);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "PATCH body must be a JSON object" }, 400);
    }
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      return c.json({ error: "PATCH body must include at least one updatable field" }, 400);
    }
    const unknown = keys.filter((k) => !PATCHABLE_SCHEDULE_FIELDS.has(k));
    if (unknown.length > 0) {
      return c.json({ error: `Unsupported field(s): ${unknown.join(", ")}` }, 400);
    }

    const body: Partial<Pick<ScheduleRecord, "workflow" | "cronExpression" | "input" | "enabled">> = {};
    if ("workflow" in raw) body.workflow = (raw as { workflow?: unknown }).workflow as string;
    if ("cronExpression" in raw) body.cronExpression = (raw as { cronExpression?: unknown }).cronExpression as string;
    if ("input" in raw) body.input = (raw as { input?: unknown }).input;
    if ("enabled" in raw) body.enabled = (raw as { enabled?: unknown }).enabled as boolean;

    if (body.workflow !== undefined && typeof body.workflow !== "string") {
      return c.json({ error: "workflow must be a string" }, 400);
    }
    if (body.cronExpression !== undefined && typeof body.cronExpression !== "string") {
      return c.json({ error: "cronExpression must be a string" }, 400);
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    if (body.cronExpression !== undefined) {
      const cronError = validateCron(body.cronExpression);
      if (cronError) return c.json({ error: cronError }, 400);
    }
    if (body.workflow !== undefined && !workflows.has(body.workflow)) {
      return c.json({ error: `Workflow "${body.workflow}" not found` }, 400);
    }
    await scheduleStore.updateSchedule(id, body);
    return c.json(await scheduleStore.getSchedule(id));
  });

  app.delete("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await scheduleStore.getSchedule(id);
    if (!existing || !canAccess(existing.userId, getPrincipal(c))) {
      return c.json({ error: "Schedule not found" }, 404);
    }
    await scheduleStore.deleteSchedule(id);
    return c.json({ deleted: id });
  });

  return app;
}
