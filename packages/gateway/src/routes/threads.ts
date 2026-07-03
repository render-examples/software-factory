import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { RunStore, ThreadStore, Thread } from "@render-agents/store";
import { buildEventRecord } from "@render-agents/store";
import type { WorkflowDefinition } from "@render-agents/sdk";
import { getPrincipal, canAccess } from "../auth.js";

export interface ThreadRouteDeps {
  store: RunStore;
  threadStore: ThreadStore;
  workflows: Map<string, WorkflowDefinition>;
  defaultWorkflow?: string;
  /** Conversational agent for threads; takes precedence over defaultWorkflow when set. */
  defaultAgent?: string;
  startAgentRun?: (agentName: string, input: string, opts: { runId: string; threadId: string; userId?: string }) => Promise<void>;
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
  const { store, threadStore, workflows, defaultWorkflow, defaultAgent, startAgentRun, resume, awaitResume } = deps;

  const driveResume = (runId: string): Promise<void> => {
    if (!resume) return Promise.resolve();
    const p = Promise.resolve(resume(runId)).then(() => {}).catch((err) => console.error(`resume(${runId}) failed`, err));
    return awaitResume ? p : Promise.resolve();
  };

  // POST /threads — create + persist a thread owned by the caller
  app.post("/threads", async (c) => {
    const principal = getPrincipal(c);
    let body: { metadata?: Record<string, unknown>; title?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const now = new Date().toISOString();
    // Ownership comes from auth, never the client body (CR-D1).
    const thread: Thread = {
      id: randomUUID(),
      userId: principal.userId,
      metadata: body.metadata,
      status: "active",
      title: body.title,
      createdAt: now,
      updatedAt: now,
    };
    await threadStore.createThread(thread);
    return c.json(thread, 201);
  });

  // GET /threads — the caller's threads (operators see all; users see their own)
  app.get("/threads", async (c) => {
    const principal = getPrincipal(c);
    const threads = await threadStore.listThreads(
      principal.role === "operator" ? undefined : { userId: principal.userId },
    );
    return c.json({ threads });
  });

  // GET /threads/:id — thread metadata + transcript (ownership-scoped)
  app.get("/threads/:id", async (c) => {
    const principal = getPrincipal(c);
    const id = c.req.param("id");
    const thread = await threadStore.getThread(id);
    // 404 (not 403) on a foreign thread so ids aren't enumerable.
    if (!thread || !canAccess(thread.userId, principal)) {
      return c.json({ error: `Thread "${id}" not found` }, 404);
    }
    const messages = await threadStore.getThreadMessages(id);
    return c.json({ thread, messages });
  });

  // POST /threads/:id/messages — deliver a message to a thread
  app.post("/threads/:id/messages", async (c) => {
    const principal = getPrincipal(c);
    const threadId = c.req.param("id");
    let body: { content: string } = { content: "" };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.content || body.content.trim() === "") {
      return c.json({ error: "content is required and must be non-empty" }, 400);
    }

    const thread = await threadStore.getThread(threadId);
    if (!thread || !canAccess(thread.userId, principal)) {
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
      // Paused: route by pending input kind. Approval gates must be satisfied via
      // the dedicated inputs API; message input can be provided by posting here.
      const pending = (await store.getInputs(active.id)).filter((input) => input.status === "pending");
      const pendingApproval = pending.find((input) => input.kind === "approval");
      const pendingMessage = pending.find((input) => input.kind === "message");
      if (pendingApproval) {
        return c.json({
          error: "Run is paused awaiting approval; resolve it via POST /inputs/:id/provide",
          runId: active.id,
        }, 409);
      }
      if (pendingMessage) {
        await store.events.append(
          buildEventRecord(active.id, {
            type: "input.provided",
            inputRequestId: pendingMessage.inputRequestId,
            kind: "message",
            value: body.content,
          }),
        );
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

    // No active run — open a NEW run for this turn (Lane B, new-run-per-turn). A
    // conversational `defaultAgent` (interactive) is preferred: each message is
    // its own short run joined to the thread by `threadId`, and multi-turn memory
    // comes from the thread transcript (not a parked run). The warm chat worker
    // (queue) or the gateway itself (inline) drives the turn.
    if (defaultAgent && startAgentRun) {
      const runId = randomUUID();
      try {
        await startAgentRun(defaultAgent, body.content, { runId, threadId, userId: thread.userId });
      } catch (err) {
        // DB-level guard (concurrent message that slipped past the soft check
        // above): the partial unique index on one-active-run-per-thread rejects
        // the second `run.started`. Translate to a clean 409 like the workflow
        // path below, instead of leaking a 500.
        if (isUniqueViolation(err)) {
          return c.json({ error: "Thread is busy (active run mid-turn)" }, 409);
        }
        throw err;
      }
      return c.json({ runId, dispatched: true, agent: defaultAgent }, 202);
    }

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
        { threadId, userId: thread.userId },
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
