import { Hono } from "hono";
import type { RunStore } from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";

/**
 * HITL routes: list pending approvals, resolve them, and resume paused runs.
 *
 * Resolving an approval / delivering input appends the resolution event and then
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

  // GET /approvals — list pending approvals (read directly from the projection)
  app.get("/approvals", async (c) => {
    const records = await store.listApprovals({ status: "pending" });
    const approvals = records.map((a) => ({
      id: a.approvalRequestId,
      runId: a.runId,
      toolName: a.toolName,
      input: a.input,
      agentName: a.agentName,
      requestedAt: a.requestedAt,
    }));
    return c.json({ approvals });
  });

  // POST /approvals/:id/resolve — approve or deny
  app.post("/approvals/:id/resolve", async (c) => {
    const approvalId = c.req.param("id");
    let body: { approved: boolean; resolvedBy?: string; reason?: string } = { approved: true };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body.approved !== "boolean") {
      return c.json({ error: "approved (boolean) is required" }, 400);
    }

    // Find the run containing this approval via the projection (any status).
    const all = await store.listApprovals();
    const target = all.find((a) => a.approvalRequestId === approvalId);
    if (!target) {
      return c.json({ error: `Approval "${approvalId}" not found` }, 404);
    }
    if (target.status !== "pending") {
      return c.json({ error: `Approval "${approvalId}" already ${target.status}` }, 409);
    }
    const targetRunId = target.runId;

    // Emit resolution event
    await store.events.append(
      buildEventRecord(targetRunId, {
        type: "approval.resolved",
        approvalRequestId: approvalId,
        approved: body.approved,
        resolvedBy: body.resolvedBy,
        reason: body.reason,
      }),
    );

    // Re-drive the paused run now that the approval is resolved.
    await driveResume(targetRunId);

    return c.json({ resolved: true, approvalId, runId: targetRunId });
  });

  // POST /runs/:id/input — resume a paused run with user input
  app.post("/runs/:id/input", async (c) => {
    const runId = c.req.param("id");
    const run = await store.getRun(runId);
    if (!run) {
      return c.json({ error: `Run "${runId}" not found` }, 404);
    }
    if (run.status !== "paused") {
      return c.json({ error: `Run "${runId}" is not paused (status: ${run.status})` }, 409);
    }

    let body: { content?: string; approved?: boolean; approvalId?: string; resolvedBy?: string; reason?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Route by pause reason: check last run.paused event
    const events = await store.events.read(runId);
    const lastPause = [...events].reverse().find((e) => e.payload.type === "run.paused");
    const reason = lastPause?.payload.type === "run.paused" ? lastPause.payload.reason : undefined;

    if (reason === "input") {
      if (!body.content) {
        return c.json({ error: "content is required for input-paused runs" }, 400);
      }
      await store.events.append(
        buildEventRecord(runId, {
          type: "message.user",
          content: [{ type: "text", text: body.content }],
        }),
      );
      await driveResume(runId);
      return c.json({ resumed: true, runId, via: "message" });
    }

    if (reason === "approval") {
      if (!body.approvalId) {
        return c.json({ error: "approvalId is required for approval-paused runs" }, 400);
      }
      await store.events.append(
        buildEventRecord(runId, {
          type: "approval.resolved",
          approvalRequestId: body.approvalId,
          approved: body.approved ?? true,
          resolvedBy: body.resolvedBy,
          reason: body.reason,
        }),
      );
      await driveResume(runId);
      return c.json({ resumed: true, runId, via: "approval" });
    }

    return c.json({ error: `Unknown pause reason` }, 400);
  });

  return app;
}
