import { Hono } from "hono";
import type { RunStore } from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";

/**
 * HITL routes: list pending approvals, resolve them, and resume paused runs.
 */
export function hitlRoutes(deps: { store: RunStore }) {
  const app = new Hono();
  const { store } = deps;

  // GET /approvals — list pending approvals
  app.get("/approvals", async (c) => {
    const runs = await store.listRuns({ status: "paused", limit: 100 });
    const pending: Array<{ id: string; runId: string; toolName: string; input: unknown; requestedAt: string }> = [];

    for (const run of runs) {
      const events = await store.events.read(run.id);
      const requested = new Set<string>();
      const resolved = new Set<string>();

      for (const e of events) {
        if (e.payload.type === "approval.requested") {
          requested.add(e.payload.approvalRequestId);
          pending.push({
            id: e.payload.approvalRequestId,
            runId: run.id,
            toolName: e.payload.toolName,
            input: e.payload.input,
            requestedAt: e.ts,
          });
        }
        if (e.payload.type === "approval.resolved") {
          resolved.add(e.payload.approvalRequestId);
        }
      }

      // Remove already-resolved from the pending list
      for (let i = pending.length - 1; i >= 0; i--) {
        if (resolved.has(pending[i].id)) {
          pending.splice(i, 1);
        }
      }
    }

    return c.json({ approvals: pending });
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

    // Find the run containing this approval
    const runs = await store.listRuns({ status: "paused", limit: 100 });
    let targetRunId: string | undefined;

    for (const run of runs) {
      const events = await store.events.read(run.id);
      for (const e of events) {
        if (e.payload.type === "approval.requested" && e.payload.approvalRequestId === approvalId) {
          targetRunId = run.id;
          break;
        }
      }
      if (targetRunId) break;
    }

    if (!targetRunId) {
      return c.json({ error: `Approval "${approvalId}" not found or already resolved` }, 404);
    }

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
      return c.json({ resumed: true, runId, via: "approval" });
    }

    return c.json({ error: `Unknown pause reason` }, 400);
  });

  return app;
}
