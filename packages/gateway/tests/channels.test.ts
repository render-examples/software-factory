import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { workflow, bindWorkflow, idempotencyKey, slackChannel, type Channel, type WorkflowDefinition, type AgentDefinition } from "@render-agents/sdk";
import { createTestRuntime, mockModel } from "@render-agents/sdk/testing";
import { buildEventRecord } from "@render-agents/store";
import { createGatewayApp } from "../src/index.js";

function assistantDef(): AgentDefinition {
  return { name: "assistant", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "chat", tools: [], interactive: true };
}

describe("channels — inbound conversation mapping (P2)", () => {
  it("agent-target channel binds a conversation to a thread and remembers across turns", async () => {
    const runtime = await createTestRuntime({
      // Echo the number of user turns the model sees, to prove thread memory.
      model: mockModel((args) => {
        const users = args.messages.filter((m) => m.role === "user").length;
        return { content: [{ type: "text", text: `users=${users}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }),
    });
    runtime.agentDefinitions.set("assistant", assistantDef());

    const channel: Channel = {
      target: { agent: "assistant" },
      verify: "none",
      match: () => ({ event: "message" }),
      parse: async (req) => {
        const b = (await req.json()) as { conversationId: string; text: string };
        return { conversationId: b.conversationId, input: b.text, user: "ext-user" };
      },
    };
    const app = createGatewayApp({ runtime, channels: new Map([["chat", channel]]), disableAuth: true, awaitResume: true });

    const post = (conversationId: string, text: string) =>
      app.request("/channels/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, text }) });

    const b1 = await (await post("conv-1", "hello")).json();
    expect(b1.agent).toBe("assistant");
    expect(b1.threadId).toBeTruthy();

    const r2 = await post("conv-1", "again");
    expect(r2.status).toBe(202);
    const b2 = await r2.json();
    // Same conversation → same thread; a new run per turn.
    expect(b2.threadId).toBe(b1.threadId);
    expect(b2.runId).not.toBe(b1.runId);

    // The mapping resolves and the run carries the channel binding.
    const conv = await runtime.store.resolveConversation("chat", "conv-1");
    expect(conv?.threadId).toBe(b1.threadId);
    expect(conv?.lastRunId).toBe(b2.runId);
    const run1 = await runtime.store.getRun(b1.runId);
    expect(run1?.channel).toBe("chat");
    expect(run1?.externalConversationId).toBe("conv-1");

    // Multi-turn memory: the second turn saw two user messages (order-independent
    // assertion — the transcript's exact ordering is exercised elsewhere).
    const { messages } = await (await app.request(`/threads/${b1.threadId}`)).json();
    const assistant = messages.filter((m: { role: string }) => m.role === "assistant").map((m: { content: string }) => m.content);
    expect(assistant).toContain("users=2");

    // A different conversation gets its own thread.
    const b3 = await (await post("conv-2", "hi")).json();
    expect(b3.threadId).not.toBe(b1.threadId);
  });

  it("agent-target channel delivers the reply back to the surface inline (P3)", async () => {
    const runtime = await createTestRuntime({
      model: mockModel(() => ({ content: [{ type: "text", text: "the reply" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })),
    });
    runtime.agentDefinitions.set("assistant", assistantDef());

    const delivered: Array<{ conversationId: string; text: string }> = [];
    const channel: Channel = {
      target: { agent: "assistant" },
      verify: "none",
      match: () => ({ event: "message" }),
      parse: async (req) => {
        const b = (await req.json()) as { conversationId: string; text: string };
        return { conversationId: b.conversationId, input: b.text };
      },
      deliver: async (ctx) => { delivered.push({ conversationId: ctx.conversationId, text: ctx.message.text }); },
    };
    const app = createGatewayApp({ runtime, channels: new Map([["chat", channel]]), disableAuth: true, awaitResume: true });

    const res = await app.request("/channels/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "conv-D", text: "hello" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();

    // Inline mode delivered the assistant reply back to the surface before acking.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ conversationId: "conv-D", text: "the reply" });
    // And recorded the idempotency marker on the run.
    const events = await runtime.store.events.read(body.runId);
    expect(events.some((e) => e.type === "channel.delivered")).toBe(true);
  });

  it("workflow-target channel stamps the channel binding on the dispatched run", async () => {
    const runtime = await createTestRuntime({
      model: mockModel(() => ({ content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })),
    });
    const wf = workflow(async (ctx) => String((ctx.input as { diff?: string }).diff ?? ""));
    bindWorkflow(wf, "review", runtime);
    const workflows = new Map<string, WorkflowDefinition>([["review", wf]]);

    const channel: Channel = {
      target: { workflow: "review" },
      verify: "none",
      match: () => ({ event: "pr" }),
      parse: async () => ({ conversationId: "pr-7", input: { diff: "x" } }),
    };
    const app = createGatewayApp({ runtime, workflows, channels: new Map([["gh", channel]]), disableAuth: true });

    const res = await app.request("/channels/gh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.workflow).toBe("review");

    const run = await runtime.store.getRun(body.runId);
    expect(run?.channel).toBe("gh");
    expect(run?.externalConversationId).toBe("pr-7");
    // Workflow channels needn't bind a thread; the mapping still records the run.
    const conv = await runtime.store.resolveConversation("gh", "pr-7");
    expect(conv?.threadId).toBeUndefined();
    expect(conv?.lastRunId).toBe(body.runId);
  });

  it("rejects an oversized inbound payload with 413", async () => {
    const prev = process.env.RENDER_AGENTS_MAX_CHANNEL_BODY_BYTES;
    process.env.RENDER_AGENTS_MAX_CHANNEL_BODY_BYTES = "64";
    try {
      const runtime = await createTestRuntime();
      const channel: Channel = {
        target: { workflow: "review" },
        verify: "none",
        match: () => ({ event: "pr" }),
        parse: async () => ({ conversationId: "pr-9", input: {} }),
      };
      const wf = workflow(async () => "ok");
      bindWorkflow(wf, "review", runtime);
      const app = createGatewayApp({
        runtime,
        workflows: new Map<string, WorkflowDefinition>([["review", wf]]),
        channels: new Map([["gh", channel]]),
        disableAuth: true,
      });
      const res = await app.request("/channels/gh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "x", text: "x".repeat(200) }),
      });
      expect(res.status).toBe(413);
    } finally {
      if (prev === undefined) delete process.env.RENDER_AGENTS_MAX_CHANNEL_BODY_BYTES;
      else process.env.RENDER_AGENTS_MAX_CHANNEL_BODY_BYTES = prev;
    }
  });
});

describe("channels — HITL over a channel (P5)", () => {
  it("a later message satisfies a paused message-input, resumes the run, and delivers the reply", async () => {
    const runtime = await createTestRuntime({
      model: mockModel(() => ({ content: [{ type: "text", text: "nice to meet you, Alice" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })),
    });
    runtime.agentDefinitions.set("assistant", assistantDef());

    const delivered: Array<{ conversationId: string; text: string; isPrompt: boolean }> = [];
    const channel: Channel = {
      target: { agent: "assistant" },
      verify: "none",
      match: () => ({ event: "message" }),
      parse: async (req) => {
        const b = (await req.json()) as { conversationId: string; text: string };
        return { conversationId: b.conversationId, input: b.text };
      },
      deliver: async (ctx) => { delivered.push({ conversationId: ctx.conversationId, text: ctx.message.text, isPrompt: !!ctx.input }); },
    };
    const app = createGatewayApp({ runtime, channels: new Map([["chat", channel]]), disableAuth: true, awaitResume: true });

    // Seed a channel-bound run that PAUSED awaiting a message input, on the thread
    // the channel derives for this conversation (as if a prior turn called ask()).
    const threadId = idempotencyKey("chat", "conv-H");
    const runId = "hitl-run";
    const now = new Date().toISOString();
    await runtime.threadStore.createThread({ id: threadId, status: "active", createdAt: now, updatedAt: now });
    const irId = idempotencyKey(runId, "input:message");
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "chat", externalConversationId: "conv-H", threadId, input: "hi" }, { agentName: "assistant", spanId: runId }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "message.user", content: [{ type: "text", text: "hi" }] }, { agentName: "assistant" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "input.requested", inputRequestId: irId, kind: "message", prompt: "What's your name?" }, { agentName: "assistant" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: [irId] }, { agentName: "assistant", spanId: runId }));
    expect((await runtime.store.getRun(runId))?.status).toBe("paused");

    // The human replies on the SAME conversation → satisfies the input + resumes
    // the SAME run (not a new turn).
    const res = await app.request("/channels/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "conv-H", text: "Alice" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId, delivered: true });

    // The message satisfied the pending input (input.provided) and drove to completion.
    const events = await runtime.store.events.read(runId);
    expect(events.some((e) => e.type === "input.provided")).toBe(true);
    expect((await runtime.store.getRun(runId))?.status).toBe("completed");
    // The reply (not a prompt) was delivered back to the surface.
    const reply = delivered.find((d) => !d.isPrompt);
    expect(reply).toMatchObject({ conversationId: "conv-H", text: "nice to meet you, Alice" });
  });

  it("rejects a channel message to an approval-paused run (must use the inputs API)", async () => {
    const runtime = await createTestRuntime({
      model: mockModel(() => ({ content: [{ type: "text", text: "x" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })),
    });
    runtime.agentDefinitions.set("assistant", assistantDef());
    const channel: Channel = {
      target: { agent: "assistant" },
      verify: "none",
      match: () => ({ event: "message" }),
      parse: async (req) => { const b = (await req.json()) as { conversationId: string; text: string }; return { conversationId: b.conversationId, input: b.text }; },
    };
    const app = createGatewayApp({ runtime, channels: new Map([["chat", channel]]), disableAuth: true, awaitResume: true });

    const threadId = idempotencyKey("chat", "conv-A");
    const runId = "appr-run";
    const now = new Date().toISOString();
    await runtime.threadStore.createThread({ id: threadId, status: "active", createdAt: now, updatedAt: now });
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "chat", externalConversationId: "conv-A", threadId, input: "go" }, { agentName: "assistant", spanId: runId }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "input.requested", inputRequestId: "a1", kind: "approval", toolName: "deploy", input: {} }, { agentName: "assistant" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: ["a1"] }, { agentName: "assistant", spanId: runId }));

    const res = await app.request("/channels/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: "conv-A", text: "yes do it" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("approval");
  });
});

describe("channels — Slack reference channel end-to-end (P4)", () => {
  const prevSecret = process.env.SLACK_SIGNING_SECRET;
  const prevToken = process.env.SLACK_BOT_TOKEN;
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.SLACK_SIGNING_SECRET; else process.env.SLACK_SIGNING_SECRET = prevSecret;
    if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = prevToken;
  });

  it("verifies a signed Slack event, drives the agent, and posts the reply back threaded", async () => {
    const secret = "slack-signing-secret";
    process.env.SLACK_SIGNING_SECRET = secret;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const runtime = await createTestRuntime({
      model: mockModel(() => ({ content: [{ type: "text", text: "hi from the agent" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })),
    });
    runtime.agentDefinitions.set("assistant", assistantDef());

    // Capture the outbound chat.postMessage instead of hitting Slack.
    const posted: Array<{ auth?: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      posted.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const channel = slackChannel({ target: { agent: "assistant" }, fetchImpl });
    const app = createGatewayApp({ runtime, channels: new Map([["slack", channel]]), disableAuth: true, awaitResume: true });

    // A signed Slack app_mention (the gateway verifies v0=HMAC over the raw body).
    const reqTs = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: "C42", user: "U7", text: "<@U0BOT> hello", ts: "170.5" } });
    const sig = "v0=" + createHmac("sha256", secret).update(`v0:${reqTs}:${body}`).digest("hex");

    const res = await app.request("/channels/slack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-signature": sig, "x-slack-request-timestamp": reqTs },
      body,
    });
    expect(res.status).toBe(202);
    const acked = await res.json();

    // The run is bound to the Slack conversation (channel:ts).
    const run = await runtime.store.getRun(acked.runId);
    expect(run?.channel).toBe("slack");
    expect(run?.externalConversationId).toBe("C42:170.5");

    // The agent's reply was posted back, threaded under the originating message.
    expect(posted).toHaveLength(1);
    expect(posted[0].auth).toBe("Bearer xoxb-test");
    expect(posted[0].body).toEqual({ channel: "C42", thread_ts: "170.5", text: "hi from the agent" });
  });

  it("answers the url_verification handshake (still signature-checked) without a run", async () => {
    const secret = "slack-signing-secret";
    process.env.SLACK_SIGNING_SECRET = secret;

    const runtime = await createTestRuntime({ model: mockModel(() => ({ content: [{ type: "text", text: "x" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })) });
    runtime.agentDefinitions.set("assistant", assistantDef());
    const app = createGatewayApp({ runtime, channels: new Map([["slack", slackChannel()]]), disableAuth: true });

    const reqTs = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ type: "url_verification", challenge: "chal-xyz" });
    const sig = "v0=" + createHmac("sha256", secret).update(`v0:${reqTs}:${body}`).digest("hex");

    const res = await app.request("/channels/slack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-signature": sig, "x-slack-request-timestamp": reqTs },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "chal-xyz" });
    // No run was created for the handshake.
    expect((await runtime.store.listRuns({ limit: 10 })).length).toBe(0);
  });

  it("rejects a Slack event with a bad signature (401) before any dispatch", async () => {
    process.env.SLACK_SIGNING_SECRET = "the-real-secret";
    const runtime = await createTestRuntime({ model: mockModel(() => ({ content: [{ type: "text", text: "x" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" })) });
    runtime.agentDefinitions.set("assistant", assistantDef());
    const app = createGatewayApp({ runtime, channels: new Map([["slack", slackChannel()]]), disableAuth: true });

    const reqTs = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: "C1", ts: "1.1", text: "hi" } });
    const badSig = "v0=" + createHmac("sha256", "wrong-secret").update(`v0:${reqTs}:${body}`).digest("hex");

    const res = await app.request("/channels/slack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-signature": badSig, "x-slack-request-timestamp": reqTs },
      body,
    });
    expect(res.status).toBe(401);
    expect((await runtime.store.listRuns({ limit: 10 })).length).toBe(0);
  });
});
