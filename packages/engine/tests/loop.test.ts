import { describe, it, expect } from "vitest";
import { createMemoryStore, buildEventRecord, type MemoryRunStore } from "@render-agents/store";
import type { Tracer } from "@render-agents/store";
import type { AgentDefinition } from "../src/agent.js";
import type { ModelClient, CompleteResult } from "../src/model.js";
import type { Tool } from "../src/tool.js";
import { DefaultRunner } from "../src/default-runner.js";
import { InProcessRunContext } from "../src/run-context.js";
import { passThroughContextManager } from "../src/context-manager.js";

const noopTracer: Tracer = { onStart: () => {}, onEnd: () => {} };

function mockModel(responses: CompleteResult[]): ModelClient {
  let i = 0;
  return {
    async complete() {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  };
}

function makeAgent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "tester",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    systemPrompt: "do stuff",
    tools: [],
    ...over,
  };
}

function makeCtx(
  store: MemoryRunStore,
  agent: AgentDefinition,
  runId: string,
  opts: {
    tools?: Map<string, Tool>;
    isCancelledFn?: () => boolean;
    cancelStore?: import("@render-agents/store").CancelStore;
    cancelScopeId?: string;
  } = {},
): InProcessRunContext {
  return new InProcessRunContext({
    runId,
    store,
    tracer: noopTracer,
    model: agent.model,
    agentName: agent.name,
    contextManager: passThroughContextManager,
    signal: new AbortController().signal,
    tools: opts.tools,
    isCancelledFn: opts.isCancelledFn,
    cancelStore: opts.cancelStore,
    cancelScopeId: opts.cancelScopeId,
  });
}

async function types(store: MemoryRunStore, runId: string): Promise<string[]> {
  return (await store.events.read(runId)).map((e) => e.type);
}

describe("DefaultRunner — simple completion", () => {
  it("emits a fully event-sourced run and resolves with text", async () => {
    const store = createMemoryStore();
    const agent = makeAgent();
    const runner = new DefaultRunner(
      mockModel([
        {
          content: [{ type: "text", text: "the answer" }],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "end_turn",
        },
      ]),
    );

    const out = await runner.run(agent, "question?", makeCtx(store, agent, "r1"));

    expect(out.text).toBe("the answer");
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(await types(store, "r1")).toEqual([
      "run.started",
      "message.user",
      "llm.call",
      "message.assistant",
      "run.completed",
    ]);

    const run = await store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.workflow).toBe("tester");
    expect(run?.result).toBe("the answer");
  });
});

describe("DefaultRunner — tool-use loop", () => {
  it("emits the canonical tool dispatch sequence and a correct span tree", async () => {
    const store = createMemoryStore();
    let invoked = 0;
    const searchTool: Tool = {
      name: "search",
      description: "search things",
      inputSchema: { type: "object" },
      async invoke() {
        invoked += 1;
        return { content: "found it" };
      },
    };
    const agent = makeAgent({ tools: ["search"] });
    const runner = new DefaultRunner(
      mockModel([
        {
          content: [{ type: "tool_use", id: "tc1", name: "search", input: { q: "x" } }],
          usage: { inputTokens: 4, outputTokens: 2 },
          stopReason: "tool_use",
        },
        {
          content: [{ type: "text", text: "done" }],
          usage: { inputTokens: 6, outputTokens: 3 },
          stopReason: "end_turn",
        },
      ]),
    );

    const out = await runner.run(
      agent,
      { task: "go" },
      makeCtx(store, agent, "r1", { tools: new Map([["search", searchTool]]) }),
    );

    expect(invoked).toBe(1);
    expect(out.text).toBe("done");
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(await types(store, "r1")).toEqual([
      "run.started",
      "message.user",
      "llm.call",
      "message.assistant",
      "tool.called",
      "tool.result",
      "message.tool",
      "llm.call",
      "message.assistant",
      "run.completed",
    ]);

    const spans = await store.listSpans("r1");
    const agentSpan = spans.find((s) => s.kind === "agent");
    const toolSpan = spans.find((s) => s.kind === "tool");
    const llmSpans = spans.filter((s) => s.kind === "llm");
    expect(agentSpan?.status).toBe("ok");
    expect(toolSpan?.parentId).toBe(agentSpan?.id);
    expect(toolSpan?.output).toBe("found it");
    expect(llmSpans).toHaveLength(2);
    expect(llmSpans.every((s) => s.parentId === agentSpan?.id)).toBe(true);
  });

  it("short-circuits a tool call already in the log (idempotency)", async () => {
    const store = createMemoryStore();
    let invoked = 0;
    const tool: Tool = {
      name: "search",
      description: "x",
      inputSchema: {},
      async invoke() {
        invoked += 1;
        return { content: "fresh" };
      },
    };
    // Pre-seed a canonical terminal result for tc1.
    await store.events.append(
      buildEventRecord("r1", { type: "tool.result", toolCallId: "tc1", name: "search", result: { content: "memoized" } }, { agentName: "tester" }),
    );

    const agent = makeAgent({ tools: ["search"] });
    const runner = new DefaultRunner(
      mockModel([
        {
          content: [{ type: "tool_use", id: "tc1", name: "search", input: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        },
        {
          content: [{ type: "text", text: "ok" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        },
      ]),
    );

    await runner.run(agent, "go", makeCtx(store, agent, "r1", { tools: new Map([["search", tool]]) }));
    expect(invoked).toBe(0); // memoized result used; tool not re-invoked

    const toolMsg = (await store.getMessages("r1", "tester")).find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ type: "tool_result", content: "memoized" });
  });
});

describe("DefaultRunner — control signals", () => {
  it("emits run.cancelled and exits when cancelled", async () => {
    const store = createMemoryStore();
    const agent = makeAgent();
    const runner = new DefaultRunner(
      mockModel([
        { content: [{ type: "text", text: "never" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
      ]),
    );

    const out = await runner.run(agent, "go", makeCtx(store, agent, "r1", { isCancelledFn: () => true }));
    expect(out.text).toBe("");
    expect(await types(store, "r1")).toEqual(["run.started", "message.user", "run.cancelled"]);
    expect((await store.getRun("r1"))?.status).toBe("cancelled");
  });

  it("cancel cascade (E3): a run is cancelled when its enclosing scope (root) is cancelled", async () => {
    const { MemoryCancelStore } = await import("@render-agents/store");
    const store = createMemoryStore();
    const agent = makeAgent();
    const cancelStore = new MemoryCancelStore();

    // A child whose own id is NOT cancelled, but whose scope (the root) is.
    const ctx = makeCtx(store, agent, "child-1", { cancelStore, cancelScopeId: "root-1" });
    expect(await ctx.isCancelled()).toBe(false);

    await cancelStore.requestCancel("root-1");
    expect(await ctx.isCancelled()).toBe(true);
  });

  it("cancel cascade: the runner exits a child when its scope root is cancelled", async () => {
    const { MemoryCancelStore } = await import("@render-agents/store");
    const store = createMemoryStore();
    const agent = makeAgent();
    const cancelStore = new MemoryCancelStore();
    await cancelStore.requestCancel("root-1"); // root cancelled before the child starts

    const runner = new DefaultRunner(
      mockModel([
        { content: [{ type: "text", text: "never" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
      ]),
    );
    const out = await runner.run(agent, "go", makeCtx(store, agent, "child-1", { cancelStore, cancelScopeId: "root-1" }));
    expect(out.text).toBe("");
    expect((await store.getRun("child-1"))?.status).toBe("cancelled");
  });

  it("cancel cascade (E3): stops a child *mid-flight* (after the scope is cancelled while a tool runs)", async () => {
    const { MemoryCancelStore } = await import("@render-agents/store");
    const store = createMemoryStore();
    const cancelStore = new MemoryCancelStore();

    // Deferreds to interleave: `started` fires when the tool begins; the tool
    // then blocks on `release` so the test can cancel the scope mid-run.
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => { signalStarted = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    let modelCalls = 0;
    const model: ModelClient = {
      async complete() {
        modelCalls += 1;
        // Iteration 1: ask for the gated tool (forces a second loop turn so the
        // top-of-loop cancel check runs again after the tool resolves). If the
        // model is ever called a second time the test fails on the count below.
        return { content: [{ type: "tool_use", id: "tc1", name: "gate", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
      },
    };
    const runner = new DefaultRunner(model);

    const gateTool: Tool = {
      name: "gate",
      description: "blocks until released",
      inputSchema: {},
      async invoke() {
        signalStarted();
        await gate;
        return { content: "done" };
      },
    };
    const agent = makeAgent({ tools: ["gate"] });
    const ctx = makeCtx(store, agent, "child-1", { tools: new Map([["gate", gateTool]]), cancelStore, cancelScopeId: "root-1" });

    const runPromise = runner.run(agent, "go", ctx);
    await started;                       // child is mid-tool
    await cancelStore.requestCancel("root-1"); // operator cancels the root while in flight
    release();                           // let the tool finish

    const out = await runPromise;
    expect(out.text).toBe("");
    expect(modelCalls).toBe(1);          // the second model turn was never reached
    const evTypes = await types(store, "child-1");
    expect(evTypes).toContain("run.cancelled");
    // Exactly one terminal event (no run.completed slipped through).
    expect(evTypes.filter((t) => t === "run.completed" || t === "run.failed" || t === "run.cancelled")).toEqual(["run.cancelled"]);
    expect((await store.getRun("child-1"))?.status).toBe("cancelled");
  });

  it("hook veto on tool.called yields a recoverable error result, not a crash (BUG-02)", async () => {
    const store = createMemoryStore();
    let invoked = 0;
    const tool: Tool = {
      name: "deploy",
      description: "x",
      inputSchema: {},
      async invoke() {
        invoked += 1;
        return { content: "deployed" };
      },
    };
    // A gate hook that vetoes the call by rejecting the `tool.called` event.
    store.setInterceptor({
      async intercept(event) {
        if (event.type === "tool.called") return { action: "reject", reason: "policy: deploys are frozen" };
        return { action: "continue" };
      },
    });

    const agent = makeAgent({ tools: ["deploy"] });
    const runner = new DefaultRunner(
      mockModel([
        { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
        { content: [{ type: "text", text: "understood, not deploying" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
      ]),
    );

    const out = await runner.run(agent, "go", makeCtx(store, agent, "r1", { tools: new Map([["deploy", tool]]) }));

    // The tool was never invoked, the run did NOT fail, and the model saw an
    // error tool_result it could recover from.
    expect(invoked).toBe(0);
    expect(out.text).toBe("understood, not deploying");
    const evTypes = await types(store, "r1");
    expect(evTypes).not.toContain("tool.called"); // vetoed pre-commit
    expect(evTypes).toContain("tool.result");
    expect(evTypes).toContain("run.completed");
    expect(evTypes).not.toContain("run.failed");
    expect((await store.getRun("r1"))?.status).toBe("completed");
    const toolMsg = (await store.getMessages("r1", "tester")).find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("auto-approves a gated tool and records input.auto", async () => {
    const store = createMemoryStore();
    let invoked = 0;
    const tool: Tool = {
      name: "deploy",
      description: "x",
      inputSchema: {},
      async invoke() {
        invoked += 1;
        return { content: "deployed" };
      },
    };
    const agent = makeAgent({ tools: ["deploy"], permissions: { requireApproval: ["deploy"] } });
    const runner = new DefaultRunner(
      mockModel([
        { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
        { content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
      ]),
    );

    await runner.run(agent, "go", makeCtx(store, agent, "r1", { tools: new Map([["deploy", tool]]) }));
    expect(invoked).toBe(1);
    expect(await types(store, "r1")).toContain("input.auto");
  });
});
