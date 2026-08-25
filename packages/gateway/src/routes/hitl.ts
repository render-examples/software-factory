import { Hono } from "hono";
import type { RunStore } from "@render-factory/store";
import { buildEventRecord } from "@render-factory/store";
import { getPrincipal, canAccess } from "../auth.js";

const INPUT_STATUSES = new Set(["pending", "approved", "denied", "provided", "all"]);
const INPUT_KINDS = new Set(["approval", "message"]);

/**
 * HITL routes: list pending input requests, provide values/decisions, and resume
 * paused runs.
 *
 * Providing input appends the resolution event and then
 * re-drives the paused run via `resume(runId)` so the loop continues from the
 * logged state (resume-by-replay). `resume` is awaited so the response reflects
 * the post-resume state; errors are isolated so a resume failure doesn't mask
 * the (durably recorded) resolution.
 */
export function hitlRoutes(deps: { store: RunStore; resume?: (runId: string) => Promise<unknown>; awaitResume?: boolean }) {
  const app = new Hono();
  const { store, resume, awaitResume } = deps;

  // Fire-and-forget by default (don't block the operator's HTTP call for the
  // full run); awaited only when `awaitResume` is set (tests). Errors are always
  // isolated so a resume failure never masks the durably-recorded resolution.
  const driveResume = (runId: string): Promise<void> => {
    if (!resume) return Promise.resolve();
    const p = Promise.resolve(resume(runId)).then(() => {}).catch((err) => console.error(`resume(${runId}) failed`, err));
    return awaitResume ? p : Promise.resolve();
  };

  const loadInputById = async (inputRequestId: string) => {
    if (typeof store.getInputById === "function") {
      return store.getInputById(inputRequestId);
    }
    const all = await store.listInputs();
    return all.find((input) => input.inputRequestId === inputRequestId);
  };

  const newRunCache = () => {
    const cache = new Map<string, Awaited<ReturnType<RunStore["getRun"]>>>();
    return async (runId: string) => {
      if (!cache.has(runId)) {
        cache.set(runId, await store.getRun(runId).catch(() => undefined));
      }
      return cache.get(runId);
    };
  };

  const parseInputFilters = (
    statusQ: string | undefined,
    kindQ: string | undefined,
  ):
    | { ok: true; opts: { status?: "pending" | "approved" | "denied" | "provided"; kind?: "approval" | "message" } }
    | { ok: false; error: string } => {
    if (statusQ && !INPUT_STATUSES.has(statusQ)) {
      return { ok: false, error: `invalid status "${statusQ}"` };
    }
    if (kindQ && !INPUT_KINDS.has(kindQ)) {
      return { ok: false, error: `invalid kind "${kindQ}"` };
    }
    if (!statusQ && !kindQ) {
      return { ok: true, opts: { status: "pending", kind: "approval" } };
    }
    return {
      ok: true,
      opts: {
        status: statusQ === "all" || !statusQ ? undefined : (statusQ as "pending" | "approved" | "denied" | "provided"),
        kind: kindQ as "approval" | "message" | undefined,
      },
    };
  };

  // Defaults to pending approvals to power the operator action queue.
  app.get("/inputs", async (c) => {
    const principal = getPrincipal(c);
    const statusQ = c.req.query("status");
    const kindQ = c.req.query("kind");
    const threadId = c.req.query("threadId");
    const runId = c.req.query("runId");
    const filters = parseInputFilters(statusQ, kindQ);
    if (!filters.ok) return c.json({ error: filters.error }, 400);
    const opts = filters.opts;
    let records = await store.listInputs(opts);
    if (principal.role !== "operator") {
      const loadRun = newRunCache();
      const owned = await Promise.all(
        records.map(async (input) => {
          const run = await loadRun(input.runId);
          return run && canAccess(run.userId, principal) ? input : null;
        }),
      );
      records = owned.filter((input): input is (typeof records)[number] => input != null);
    }
    if (runId) {
      records = records.filter((input) => input.runId === runId);
    }
    // Inputs carry only runId, so resolve threadId server-side (one round trip
    // vs the UI fanning out a getRun per input); candidate set is small.
    if (threadId) {
      const loadRun = newRunCache();
      const matches = await Promise.all(
        records.map(async (input) => {
          const run = await loadRun(input.runId);
          return run?.threadId === threadId ? input : null;
        }),
      );
      records = matches.filter((input): input is (typeof records)[number] => input != null);
    }
    const inputs = records.map((input) => ({
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
    }));
    return c.json({ inputs });
  });

  app.get("/inputs/counts", async (c) => {
    const principal = getPrincipal(c);
    const statusQ = c.req.query("status");
    const kindQ = c.req.query("kind");
    const threadId = c.req.query("threadId");
    const runId = c.req.query("runId");
    const filters = parseInputFilters(statusQ, kindQ);
    if (!filters.ok) return c.json({ error: filters.error }, 400);
    const opts = filters.opts;
    let records = await store.listInputs(opts);
    if (principal.role !== "operator") {
      const loadRun = newRunCache();
      const owned = await Promise.all(
        records.map(async (input) => {
          const run = await loadRun(input.runId);
          return run && canAccess(run.userId, principal) ? input : null;
        }),
      );
      records = owned.filter((input): input is (typeof records)[number] => input != null);
    }
    if (runId) {
      records = records.filter((input) => input.runId === runId);
    }
    if (threadId) {
      const loadRun = newRunCache();
      const matches = await Promise.all(
        records.map(async (input) => {
          const run = await loadRun(input.runId);
          return run?.threadId === threadId ? input : null;
        }),
      );
      records = matches.filter((input): input is (typeof records)[number] => input != null);
    }
    const pendingApprovals = records.filter((input) => input.kind === "approval" && input.status === "pending").length;
    return c.json({ count: records.length, pendingApprovals });
  });

  app.post("/inputs/:id/provide", async (c) => {
    const inputId = c.req.param("id");
    const actor = getPrincipal(c);
    let body: { approved?: boolean; value?: unknown; content?: string; reason?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const target = await loadInputById(inputId);
    if (!target) {
      return c.json({ error: `Input "${inputId}" not found` }, 404);
    }
    const ownerRun = await store.getRun(target.runId).catch(() => undefined);
    if (!ownerRun || !canAccess(ownerRun.userId, actor)) {
      return c.json({ error: `Input "${inputId}" not found` }, 404);
    }
    if (target.status !== "pending") {
      return c.json({ error: `Input "${inputId}" already ${target.status}` }, 409);
    }
    if (target.kind === "approval" && typeof body.approved !== "boolean") {
      return c.json({ error: "approved (boolean) is required for approval inputs" }, 400);
    }
    const value = target.kind === "message" ? (body.value ?? body.content) : undefined;
    if (target.kind === "message" && value === undefined) {
      return c.json({ error: "value (or content) is required for message inputs" }, 400);
    }

    const targetRunId = target.runId;
    await store.events.append(
      buildEventRecord(targetRunId, {
        type: "input.provided",
        inputRequestId: inputId,
        kind: target.kind,
        approved: target.kind === "approval" ? body.approved : undefined,
        value,
        providedBy: actor.userId,
        reason: body.reason,
      }),
    );
    if (target.kind === "message") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      await store.events.append(
        buildEventRecord(targetRunId, {
          type: "message.user",
          content: [{ type: "text", text }],
        }),
      );
    }

    await driveResume(targetRunId);
    return c.json({ provided: true, inputId, runId: targetRunId });
  });

  app.post("/runs/:id/input", async (c) => {
    const actor = getPrincipal(c);
    const runId = c.req.param("id");
    const run = await store.getRun(runId);
    if (!run || !canAccess(run.userId, actor)) {
      return c.json({ error: `Run "${runId}" not found` }, 404);
    }
    if (run.status !== "paused") {
      return c.json({ error: `Run "${runId}" is not paused (status: ${run.status})` }, 409);
    }

    let body: { content?: string; inputId?: string; approved?: boolean; value?: unknown; reason?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const pending = (await store.getInputs(runId)).filter((input) => input.status === "pending");
    if (pending.length === 0) {
      return c.json({ error: `Run "${runId}" has no pending input requests` }, 409);
    }
    let target = pending[0];
    if (body.inputId) {
      const byId = pending.find((input) => input.inputRequestId === body.inputId);
      if (!byId) {
        return c.json({ error: `Input "${body.inputId}" not found for run "${runId}"` }, 404);
      }
      target = byId;
    } else if (body.content !== undefined) {
      const byMessage = pending.find((input) => input.kind === "message");
      if (byMessage) target = byMessage;
    }
    if (!target) {
      return c.json({ error: `Input "${body.inputId}" not found for run "${runId}"` }, 404);
    }
    const value = target.kind === "message" ? (body.value ?? body.content) : undefined;
    if (target.kind === "message" && value === undefined) {
      return c.json({ error: "content (or value) is required for message inputs" }, 400);
    }
    if (target.kind === "approval" && typeof body.approved !== "boolean") {
      return c.json({ error: "approved (boolean) is required for approval inputs" }, 400);
    }
    await store.events.append(
      buildEventRecord(runId, {
        type: "input.provided",
        inputRequestId: target.inputRequestId,
        kind: target.kind,
        approved: target.kind === "approval" ? body.approved : undefined,
        value,
        providedBy: actor.userId,
        reason: body.reason,
      }),
    );
    if (target.kind === "message") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      await store.events.append(
        buildEventRecord(runId, {
          type: "message.user",
          content: [{ type: "text", text }],
        }),
      );
    }
    await driveResume(runId);
    return c.json({ resumed: true, runId, via: target.kind });

  });

  return app;
}
