import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { RunStore } from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";
import type { WorkflowDefinition } from "@render-agents/sdk";

export interface ThreadRouteDeps {
  store: RunStore;
  workflows: Map<string, WorkflowDefinition>;
  defaultWorkflow?: string;
  resume?: (runId: string) => Promise<unknown>;
}

/**
 * Thread management routes: create, list, send messages.
 * Threads are the top-level unit of multi-turn work.
 */
export function threadRoutes(deps: ThreadRouteDeps) {
  const app = new Hono();
  const { store, workflows, defaultWorkflow, resume } = deps;

  // POST /threads — create a thread
  app.post("/threads", async (c) => {
    let body: { userId?: string; metadata?: Record<string, unknown>; workflow?: string; title?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const thread = {
      id: randomUUID(),
      userId: body.userId,
      metadata: body.metadata,
      status: "active" as const,
      title: body.title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Store the thread (via a run_events-independent table — threads are operational)
    // For now, threads are tracked via the runs table's thread_id FK.
    // Full ThreadStore implementation comes with the Postgres impl.
    return c.json(thread, 201);
  });

  // GET /threads — list threads
  app.get("/threads", async (c) => {
    // Thread listing reads from the runs projection grouped by thread_id
    const userId = c.req.query("userId");
    const runs = await store.listRuns({ limit: 100 });
    const threadIds = new Set<string>();
    const threads = runs
      .filter((r): r is typeof r & { threadId: string } => !!r.threadId)
      .filter((r) => !userId || r.userId === userId)
      .filter((r) => {
        if (threadIds.has(r.threadId)) return false;
        threadIds.add(r.threadId);
        return true;
      })
      .map((r) => ({
        id: r.threadId,
        userId: r.userId,
        status: "active",
        latestRunId: r.id,
        latestRunStatus: r.status,
        startedAt: r.startedAt,
      }));
    return c.json({ threads });
  });

  // POST /threads/:id/messages — deliver a message to a thread
  app.post("/threads/:id/messages", async (c) => {
    const threadId = c.req.param("id");
    let body: { content: string; userId?: string } = { content: "" };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.content || body.content.trim() === "") {
      return c.json({ error: "content is required and must be non-empty" }, 400);
    }

    // Find the active run for this thread
    const runs = await store.listRuns({ limit: 50 });
    const activeRun = runs.find(
      (r) => r.threadId === threadId && (r.status === "running" || r.status === "paused" || r.status === "pending"),
    );

    if (activeRun) {
      if (activeRun.status === "running") {
        return c.json({ error: "Thread is busy (active run mid-turn)" }, 409);
      }

      // Deliver into the paused run (awaiting input), then re-drive it.
      await store.events.append(
        buildEventRecord(activeRun.id, {
          type: "message.user",
          content: [{ type: "text", text: body.content }],
        }),
      );
      if (resume) {
        try { await resume(activeRun.id); } catch (err) { console.error(`resume(${activeRun.id}) failed`, err); }
      }

      return c.json({ runId: activeRun.id, delivered: true }, 200);
    }

    // No active run — dispatch a new one for this thread
    const workflowName = defaultWorkflow ?? "default";
    const workflow = workflows.get(workflowName);
    if (!workflow) {
      return c.json({
        error: `No active run and default workflow "${workflowName}" not found`,
      }, 500);
    }

    const run = await workflow.dispatch({ message: body.content, threadId }, "thread_message");
    return c.json({ runId: run.id, dispatched: true }, 202);
  });

  return app;
}
