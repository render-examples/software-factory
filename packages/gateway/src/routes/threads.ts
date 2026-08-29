import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { RunStore, ThreadStore, Thread } from "@render-factory/store";
import { buildEventRecord } from "@render-factory/store";
import type { WorkflowDefinition } from "@render-factory/sdk";
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

  // --- Helpers ---

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

  const driveResume = (runId: string): Promise<void> => {
    if (!resume) return Promise.resolve();
    const p = Promise.resolve(resume(runId)).then(() => {}).catch((err) => console.error(`resume(${runId}) failed`, err));
    return awaitResume ? p : Promise.resolve();
  };

  // --- Thread CRUD ---

  app.post("/threads", async (c) => {
    const principal = getPrincipal(c);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "Thread create body must be a JSON object" }, 400);
    }
    const title = (raw as { title?: unknown }).title;
    if (title !== undefined && typeof title !== "string") {
      return c.json({ error: "title must be a string" }, 400);
    }
    const metadata = (raw as { metadata?: unknown }).metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
      return c.json({ error: "metadata must be a JSON object" }, 400);
    }

    const now = new Date().toISOString();
    // Ownership comes from auth, never the client body (CR-D1).
    const thread: Thread = {
      id: randomUUID(),
      userId: principal.userId,
      metadata: metadata as Record<string, unknown> | undefined,
      status: "active",
      title,
      createdAt: now,
      updatedAt: now,
    };
    await threadStore.createThread(thread);
    return c.json(thread, 201);
  });

  app.get("/threads", async (c) => {
    const principal = getPrincipal(c);
    const threads = await threadStore.listThreads(
      principal.role === "operator" ? undefined : { userId: principal.userId },
    );
    return c.json({ threads });
  });

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

  // --- Thread View ---

  // Consolidated payload to avoid N+1 fetches from the chat UI.
  app.get("/threads/:id/view", async (c) => {
    const principal = getPrincipal(c);
    const id = c.req.param("id");
    const thread = await threadStore.getThread(id);
    if (!thread || !canAccess(thread.userId, principal)) {
      return c.json({ error: `Thread "${id}" not found` }, 404);
    }
    const [messages, runs] = await Promise.all([
      threadStore.getThreadMessages(id),
      store.listRuns({ threadId: id, limit: 50 }),
    ]);
    const activeRun = runs.find(
      (r) => r.status === "pending" || r.status === "running" || r.status === "paused",
    );
    const approvals = activeRun
      ? (await store.getInputs(activeRun.id))
          .filter((input) => input.status === "pending" && input.kind === "approval")
          .map(toApproval)
      : [];
    return c.json({
      thread,
      messages,
      activeRun: activeRun ? { id: activeRun.id, status: activeRun.status } : null,
      approvals,
    });
  });

  // --- Send Message ---

  app.post("/threads/:id/messages", async (c) => {
    const principal = getPrincipal(c);
    const threadId = c.req.param("id");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "Message body must be a JSON object" }, 400);
    }
    const content = (raw as { content?: unknown }).content;
    if (typeof content !== "string" || content.trim() === "") {
      return c.json({ error: "content is required and must be a non-empty string" }, 400);
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
      // Approval gates must be satisfied via the inputs API; message input can be posted here.
      const pending = (await store.getInputs(active.id)).filter((input) => input.status === "pending");
      const pendingApproval = pending.find((input) => input.kind === "approval");
      const pendingMessage = pending.find((input) => input.kind === "message");
      if (pendingApproval) {
        return c.json({
          error: "Run is paused awaiting approval; resolve it via POST /inputs/:id/provide",
          runId: active.id,
        }, 409);
      }
      if (!pendingMessage) {
        return c.json({
          error: "Run is paused but has no pending message input; resolve it via POST /runs/:id/input",
          runId: active.id,
        }, 409);
      }
      await store.events.append(
        buildEventRecord(active.id, {
          type: "input.provided",
          inputRequestId: pendingMessage.inputRequestId,
          kind: "message",
          value: content,
        }),
      );
      await store.events.append(
        buildEventRecord(active.id, {
          type: "message.user",
          content: [{ type: "text", text: content }],
        }),
      );
      await driveResume(active.id);
      return c.json({ runId: active.id, delivered: true }, 200);
    }

    // No active run: open a new run for this turn. A conversational
    // defaultAgent is preferred, each message its own short run joined to the
    // thread; multi-turn memory comes from the thread transcript, not a parked run.
    if (defaultAgent && startAgentRun) {
      const runId = randomUUID();
      try {
        await startAgentRun(defaultAgent, content, { runId, threadId, userId: thread.userId });
      } catch (err) {
        // DB-level guard: partial unique index on one-active-run-per-thread
        // rejects a concurrent second run.started; translate to a clean 409.
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
        { message: content, threadId },
        "thread_message",
        { threadId, userId: thread.userId },
      );
      return c.json({ runId: run.id, dispatched: true }, 202);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "Thread is busy (active run mid-turn)" }, 409);
      }
      throw err;
    }
  });

  return app;
}
