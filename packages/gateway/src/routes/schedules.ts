import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { ScheduleStore, ScheduleRecord } from "@render-agents/store";
import { validateCron, dueSchedules } from "@render-agents/store";
import type { WorkflowDefinition } from "@render-agents/sdk";

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
    try {
      // Stamp lastRunAt to the firing minute *before* dispatch so a concurrent
      // / retried tick in the same minute sees it as already fired (dedupe).
      await deps.scheduleStore.updateSchedule(s.id, { lastRunAt: now.toISOString() });
      const run = await workflow.dispatch(s.input ?? {}, "cron");
      await deps.scheduleStore.updateSchedule(s.id, { lastRunId: run.id, lastRunAt: now.toISOString() });
      result.fired.push({ scheduleId: s.id, workflow: s.workflow, runId: run.id });
    } catch (err) {
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

  // POST /admin/schedules/tick — fire all due schedules (Render Cron, per minute)
  app.post("/admin/schedules/tick", async (c) => {
    const result = await reconcileDueSchedules(deps, now());
    return c.json(result);
  });

  // POST /schedules — create a schedule
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
    const record: ScheduleRecord = {
      id: randomUUID(),
      workflow: body.workflow,
      cronExpression: body.cronExpression,
      input: body.input,
      enabled: body.enabled ?? true,
      createdAt: ts,
      updatedAt: ts,
    };
    await scheduleStore.createSchedule(record);
    return c.json(record, 201);
  });

  // GET /schedules — list all schedules
  app.get("/schedules", async (c) => {
    const schedules = await scheduleStore.listSchedules();
    return c.json({ schedules });
  });

  // GET /schedules/:id — fetch one
  app.get("/schedules/:id", async (c) => {
    const schedule = await scheduleStore.getSchedule(c.req.param("id"));
    if (!schedule) return c.json({ error: "Schedule not found" }, 404);
    return c.json(schedule);
  });

  // PATCH /schedules/:id — update cron / input / enabled
  app.patch("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await scheduleStore.getSchedule(id);
    if (!existing) return c.json({ error: "Schedule not found" }, 404);

    let body: Partial<Pick<ScheduleRecord, "workflow" | "cronExpression" | "input" | "enabled">> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
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

  // DELETE /schedules/:id
  app.delete("/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await scheduleStore.getSchedule(id);
    if (!existing) return c.json({ error: "Schedule not found" }, 404);
    await scheduleStore.deleteSchedule(id);
    return c.json({ deleted: id });
  });

  return app;
}
