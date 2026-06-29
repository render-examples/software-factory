import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { workflow, bindWorkflow, type AgentDefinition, type WorkflowDefinition } from "@render-agents/sdk";
import { createTestRuntime, mockModel } from "@render-agents/sdk/testing";
import { createGatewayApp } from "../src/index.js";

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

  it("dispatches a chat agent, parks, and remembers across turns via the thread", async () => {
    const { app } = await buildChatApp();
    const thread = await (await app.request("/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();

    // Turn 1
    const r1 = await app.request(`/threads/${thread.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
    expect(r1.status).toBe(202);
    expect((await r1.json()).agent).toBe("assistant");

    // Turn 2 — delivered into the same parked run (not a new dispatch).
    const r2 = await app.request(`/threads/${thread.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "again" }) });
    expect(r2.status).toBe(200);
    expect((await r2.json()).delivered).toBe(true);

    // Transcript shows the conversation with memory (users=1 then users=2).
    const { messages } = await (await app.request(`/threads/${thread.id}`)).json();
    expect(messages.filter((m: { role: string }) => m.role === "assistant").map((m: { content: string }) => m.content)).toEqual(["users=1", "users=2"]);
  });
});

describe("gateway threads — end-to-end", () => {
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

  it("rejects message delivery to an approval-paused run (must use the approvals API)", async () => {
    const { app, runtime } = await buildApp();
    const createRes = await app.request("/threads", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const thread = await createRes.json();

    // A run paused for *approval* (not input) tied to this thread.
    await runtime.store.events.append(
      buildEventRecord("appr-run", { type: "run.started", threadId: thread.id, input: "x" }, { agentName: "chat" }),
    );
    await runtime.store.events.append(
      buildEventRecord("appr-run", { type: "run.paused", reason: "approval", pendingApprovalIds: ["a1"] }, { agentName: "chat" }),
    );

    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("approval");
  });
});
