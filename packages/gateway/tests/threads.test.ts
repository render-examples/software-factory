import { describe, it, expect } from "vitest";
import { buildEventRecord, PgRunStore } from "@render-agents/store";
import { workflow, bindWorkflow, type AgentDefinition, type WorkflowDefinition } from "@render-agents/sdk";
import { createTestRuntime, mockModel } from "@render-agents/sdk/testing";
import { createGatewayApp } from "../src/index.js";
import { threadRoutes, type ThreadRouteDeps } from "../src/routes/threads.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPg = TEST_DATABASE_URL ? describe : describe.skip;

function responderDef(): AgentDefinition {
  return {
    name: "responder",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    systemPrompt: "reply",
    tools: [],
  };
}

async function buildApp() {
  const runtime = await createTestRuntime({
    model: mockModel(() => ({ content: [{ type: "text", text: "hi back" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })),
  });
  runtime.agentDefinitions.set("responder", responderDef());

  const chat = workflow(async (ctx) => {
    const msg = typeof ctx.input === "object" && ctx.input !== null ? (ctx.input as { message?: string }).message ?? "" : String(ctx.input);
    const out = await ctx.agents.get("responder").run(msg);
    return out.text;
  });
  bindWorkflow(chat, "chat", runtime);
  const workflows = new Map<string, WorkflowDefinition>([["chat", chat]]);

  const app = createGatewayApp({ runtime, workflows, defaultWorkflow: "chat", disableAuth: true });
  return { app, runtime };
}

describe("gateway threads — conversational (interactive agent) memory", () => {
  async function buildChatApp() {
    const runtime = await createTestRuntime({
      model: mockModel((args) => {
        const users = args.messages.filter((m) => m.role === "user").length;
        return { content: [{ type: "text", text: `users=${users}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }),
    });
    runtime.agentDefinitions.set("assistant", {
      name: "assistant", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "chat", tools: [], interactive: true,
    });
    const app = createGatewayApp({ runtime, defaultAgent: "assistant", disableAuth: true, awaitResume: true });
    return { app, runtime };
  }

  it("opens a new run per turn and remembers across turns via the thread (D12)", async () => {
    const { app } = await buildChatApp();
    const thread = await (await app.request("/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();

    // Turn 1 — its own run; completes (turn-end is NOT a pause).
    const r1 = await app.request(`/threads/${thread.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.agent).toBe("assistant");

    // Turn 2 — a NEW run in the same thread (new-run-per-turn), not delivered into
    // a parked run. A different runId proves it.
    const r2 = await app.request(`/threads/${thread.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "again" }) });
    expect(r2.status).toBe(202);
    const b2 = await r2.json();
    expect(b2.agent).toBe("assistant");
    expect(b2.runId).not.toBe(b1.runId);

    // Transcript shows the conversation with memory (users=1 then users=2).
    const { messages } = await (await app.request(`/threads/${thread.id}`)).json();
    expect(messages.filter((m: { role: string }) => m.role === "assistant").map((m: { content: string }) => m.content)).toEqual(["users=1", "users=2"]);
  });
});

describe("gateway threads — end-to-end", () => {
  it("rejects invalid JSON when creating a thread", async () => {
    const { app } = await buildApp();
    const res = await app.request("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid create payload types", async () => {
    const { app } = await buildApp();
    const badTitle = await app.request("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: 123 }),
    });
    expect(badTitle.status).toBe(400);

    const badMetadata = await app.request("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metadata: "oops" }),
    });
    expect(badMetadata.status).toBe(400);
  });

  it("creates a thread, dispatches a thread run, and folds the transcript", async () => {
    const { app, runtime } = await buildApp();

    // Create a thread (persisted).
    const createRes = await app.request("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u1", title: "support" }),
    });
    expect(createRes.status).toBe(201);
    const thread = await createRes.json();
    expect(thread.id).toBeTruthy();

    // It shows up in the list.
    const listRes = await app.request("/threads?userId=u1");
    const { threads } = await listRes.json();
    expect(threads.map((t: { id: string }) => t.id)).toContain(thread.id);

    // Deliver a message → dispatches a run for the thread.
    const msgRes = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(msgRes.status).toBe(202);

    // The dispatched runs carry the thread id.
    const threadRuns = await runtime.store.listRuns({ threadId: thread.id });
    expect(threadRuns.length).toBeGreaterThan(0);
    expect(threadRuns.every((r) => r.threadId === thread.id)).toBe(true);

    // The transcript folded the user turn and the assistant reply.
    const detailRes = await app.request(`/threads/${thread.id}`);
    expect(detailRes.status).toBe(200);
    const { messages } = await detailRes.json();
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(messages.find((m: { role: string }) => m.role === "user")?.content).toBe("hello");
    expect(messages.find((m: { role: string }) => m.role === "assistant")?.content).toBe("hi back");
  });

  it("rejects a concurrent turn while a run is active (409 thread_busy)", async () => {
    const { app, runtime } = await buildApp();

    const createRes = await app.request("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const thread = await createRes.json();

    // Simulate an in-flight (running) run for this thread.
    await runtime.store.events.append(
      buildEventRecord("inflight-1", { type: "run.started", threadId: thread.id, input: "x" }, { agentName: "chat" }),
    );

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "second turn" }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects non-string message content with 400", async () => {
    const { app } = await buildApp();
    const thread = await (
      await app.request("/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json();
    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { text: "hello" } }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /threads/:id/view returns consolidated active-run and approval state", async () => {
    const { app, runtime } = await buildApp();
    const createRes = await app.request("/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const thread = await createRes.json();
    const runId = "view-run-1";

    await runtime.store.events.append(
      buildEventRecord(runId, { type: "run.started", threadId: thread.id, input: "hello" }, { spanId: runId, agentName: "chat" }),
    );
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "message.user", content: [{ type: "text", text: "hello" }] }, { agentName: "chat" }),
    );
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "input.requested", inputRequestId: "ap-view", kind: "approval", toolName: "deploy", input: {} }, { spanId: runId, agentName: "chat" }),
    );
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: ["ap-view"] }, { spanId: runId, agentName: "chat" }),
    );

    const res = await app.request(`/threads/${thread.id}/view`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thread.id).toBe(thread.id);
    expect(body.activeRun).toMatchObject({ id: runId, status: "paused" });
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]).toMatchObject({ id: "ap-view", runId, status: "pending", kind: "approval" });
    expect(body.messages.some((m: { role: string }) => m.role === "user")).toBe(true);
  });

  // E4: the soft sequential-turn check can be lost to a genuine race (two
  // concurrent messages both observe "no active run"). The partial unique index
  // `idx_runs_thread_active` is the real backstop — the loser's `run.started`
  // append raises Postgres 23505. The agent (defaultAgent) path must translate
  // that to a clean 409, matching the workflow path, instead of leaking a 500.
  describe("concurrent-turn DB guard (E4)", () => {
    const thread = { id: "t1", status: "active" as const, createdAt: "", updatedAt: "" };
    const deps = (startAgentRun: ThreadRouteDeps["startAgentRun"]): ThreadRouteDeps =>
      ({
        store: { listRuns: async () => [], events: { append: async () => {} } },
        threadStore: { getThread: async () => thread, getThreadMessages: async () => [] },
        workflows: new Map(),
        defaultAgent: "assistant",
        startAgentRun,
      } as unknown as ThreadRouteDeps);

    const send = (app: ReturnType<typeof threadRoutes>) =>
      app.request("/threads/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      });

    it("translates a unique-violation (23505) into 409, not 500", async () => {
      const app = threadRoutes(deps(async () => {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }));
      const res = await send(app);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("busy");
    });

    it("still surfaces a genuine (non-unique) error as 500", async () => {
      const app = threadRoutes(deps(async () => {
        throw new Error("boom");
      }));
      const res = await send(app);
      expect(res.status).toBe(500);
    });
  });

  // E4 (real race): the in-memory tests above mock the throw; this drives two
  // genuinely concurrent messages against Postgres so the partial unique index
  // `idx_runs_thread_active` is the actual arbiter. Queue mode + no worker keeps
  // both turns active, so the loser can't "win" by the first run completing first.
  describeWithPg("concurrent-turn race over Postgres (E4)", () => {
    it("two simultaneous messages settle as exactly one 202 + one 409, one active run", async () => {
      const store = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
      await store.init();
      try {
        const runtime = await createTestRuntime({
          store,
          executionMode: "queue", // no worker started → opened runs stay active
          model: mockModel(() => ({ content: [{ type: "text", text: "hi" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })),
        });
        runtime.agentDefinitions.set("assistant", {
          name: "assistant", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "chat", tools: [], interactive: true,
        });
        const app = createGatewayApp({ runtime, defaultAgent: "assistant", disableAuth: true });

        const thread = (await (await app.request("/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { id: string };

        const send = (content: string) => app.request(`/threads/${thread.id}/messages`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
        });
        const [a, b] = await Promise.all([send("one"), send("two")]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([202, 409]); // one accepted, one rejected as busy

        // Exactly one active run survived the race (the unique index held).
        const active = (await store.listRuns({ threadId: thread.id })).filter(
          (r) => r.status === "running" || r.status === "pending" || r.status === "paused",
        );
        expect(active.length).toBe(1);
      } finally {
        await store.close();
      }
    });
  });

  it("rejects message delivery to an approval-paused run (must use the inputs API)", async () => {
    const { app, runtime } = await buildApp();
    const createRes = await app.request("/threads", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const thread = await createRes.json();

    // A run paused for approval input tied to this thread.
    await runtime.store.events.append(
      buildEventRecord("appr-run", { type: "run.started", threadId: thread.id, input: "x" }, { agentName: "chat" }),
    );
    await runtime.store.events.append(
      buildEventRecord("appr-run", { type: "input.requested", inputRequestId: "a1", kind: "approval", toolName: "deploy", input: {} }, { agentName: "chat" }),
    );
    await runtime.store.events.append(
      buildEventRecord("appr-run", { type: "run.paused", reason: "input", pendingInputIds: ["a1"] }, { agentName: "chat" }),
    );

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("approval");
  });

  it("rejects message delivery when paused run has no pending message input", async () => {
    const { app, runtime } = await buildApp();
    const createRes = await app.request("/threads", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const thread = await createRes.json();

    await runtime.store.events.append(
      buildEventRecord("stale-paused", { type: "run.started", threadId: thread.id, input: "x" }, { agentName: "chat" }),
    );
    await runtime.store.events.append(
      buildEventRecord("stale-paused", { type: "run.paused", reason: "input", pendingInputIds: ["missing"] }, { agentName: "chat" }),
    );

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no pending message input");
  });
});
