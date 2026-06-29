import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { RunStore, ThreadStore, Thread } from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";
import type { WorkflowDefinition } from "@render-agents/sdk";

export interface ThreadRouteDeps {
  store: RunStore;
  threadStore: ThreadStore;
  workflows: Map<string, WorkflowDefinition>;
  defaultWorkflow?: string;
  resume?: (runId: string) => Promise<unknown>;
  awaitResume?: boolean;
}

/** Postgres unique-violation (one active run per thread) → treat as thread-busy. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Thread management routes: create, list, get, send messages. Threads are the
 * top-level unit of multi-turn work; each turn is a run carrying the thread id,
 * and the thread transcript folds from `message.*` events across those runs.
 */
export function threadRoutes(deps: ThreadRouteDeps) {
  const app = new Hono();
  const { store, threadStore, workflows, defaultWorkflow, resume, awaitResume } = deps;

  const driveResume = (runId: string): Promise<void> => {
    if (!resume) return Promise.resolve();
    const p = Promise.resolve(resume(runId)).then(() => {}).catch((err) => console.error(`resume(${runId}) failed`, err));
    return awaitResume ? p : Promise.resolve();
  };

  /** The reason of a run's most recent `run.paused`, if any. */
  const lastPauseReason = async (runId: string): Promise<"approval" | "input" | undefined> => {
    const events = await store.events.read(runId);
    for (let i = events.length - 1; i >= 0; i--) {
      const p = events[i].payload;
      if (p.type === "run.paused") return p.reason;
    }
    return undefined;
  };

  // POST /threads — create + persist a thread
  app.post("/threads", async (c) => {
    let body: { userId?: string; metadata?: Record<string, unknown>; title?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const now = new Date().toISOString();
    const thread: Thread = {
      id: randomUUID(),
      userId: body.userId,
      metadata: body.metadata,
      status: "active",
      title: body.title,
      createdAt: now,
      updatedAt: now,
    };
    await threadStore.createThread(thread);
    return c.json(thread, 201);
  });

  // GET /threads — list persisted threads (optionally by user)
  app.get("/threads", async (c) => {
    const userId = c.req.query("userId");
    const threads = await threadStore.listThreads(userId ? { userId } : undefined);
    return c.json({ threads });
  });

  // GET /threads/:id — thread metadata + transcript
  app.get("/threads/:id", async (c) => {
    const id = c.req.param("id");
    const thread = await threadStore.getThread(id);
    if (!thread) {
      return c.json({ error: `Thread "${id}" not found` }, 404);
    }
    const messages = await threadStore.getThreadMessages(id);
    return c.json({ thread, messages });
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

    const thread = await threadStore.getThread(threadId);
    if (!thread) {
      return c.json({ error: `Thread "${threadId}" not found` }, 404);
    }

    // Sequential-turn enforcement: at most one active run per thread.
    const active = (await store.listRuns({ threadId, limit: 50 })).find(
      (r) => r.status === "running" || r.status === "paused" || r.status === "pending",
    );

    if (active) {
      if (active.status === "running" || active.status === "pending") {
        return c.json({ error: "Thread is busy (active run mid-turn)", runId: active.id }, 409);
      }
      // Paused: only an input-pause accepts a user message. An approval-pause
      // must be resolved via the approvals API — delivering a message there would
      // just replay and re-pause.
      const reason = await lastPauseReason(active.id);
      if (reason === "approval") {
        return c.json({
          error: "Run is paused awaiting approval; resolve it via POST /approvals/:id/resolve",
          runId: active.id,
        }, 409);
      }
      await store.events.append(
        buildEventRecord(active.id, {
          type: "message.user",
          content: [{ type: "text", text: body.content }],
        }),
      );
      await driveResume(active.id);
      return c.json({ runId: active.id, delivered: true }, 200);
    }

    // No active run — dispatch a new one for this thread.
    const workflowName = defaultWorkflow ?? "default";
    const workflow = workflows.get(workflowName);
    if (!workflow) {
      return c.json({
        error: `No active run and default workflow "${workflowName}" not found`,
      }, 500);
    }

    try {
      const run = await workflow.dispatch(
        { message: body.content, threadId },
        "thread_message",
        { threadId, userId: body.userId ?? thread.userId },
      );
      return c.json({ runId: run.id, dispatched: true }, 202);
    } catch (err) {
      // DB-level guard (race that slipped past the soft check above).
      if (isUniqueViolation(err)) {
        return c.json({ error: "Thread is busy (active run mid-turn)" }, 409);
      }
      throw err;
    }
  });

  return app;
}
