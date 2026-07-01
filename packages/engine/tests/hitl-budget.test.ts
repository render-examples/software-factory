import { describe, it, expect, afterEach } from "vitest";
import { createMemoryStore, buildEventRecord, idempotencyKey, type MemoryRunStore } from "@render-agents/store";
import type { Tracer } from "@render-agents/store";
import type { AgentDefinition } from "../src/agent.js";
import { RunPaused } from "../src/agent.js";
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

function makeCtx(store: MemoryRunStore, agent: AgentDefinition, runId: string, tools?: Map<string, Tool>): InProcessRunContext {
  return new InProcessRunContext({
    runId,
    store,
    tracer: noopTracer,
    model: agent.model,
    agentName: agent.name,
    contextManager: passThroughContextManager,
    signal: new AbortController().signal,
    tools,
  });
}

async function types(store: MemoryRunStore, runId: string): Promise<string[]> {
  return (await store.events.read(runId)).map((e) => e.type);
}

describe("DefaultRunner — budget enforcement (C2)", () => {
  it("records the paid-for llm.call and assistant message before failing on cost budget", async () => {
    const store = createMemoryStore();
    const agent = makeAgent({ budget: { maxCostUsd: 0.0000001 } });
    const runner = new DefaultRunner(
      mockModel([
        // Within the default token budget, but well over the tiny cost budget.
        { content: [{ type: "text", text: "expensive" }], usage: { inputTokens: 500_000, outputTokens: 100_000 }, stopReason: "end_turn" },
      ]),
    );

    await expect(runner.run(agent, "go", makeCtx(store, agent, "r1"))).rejects.toThrow(/cost budget exhausted/);

    const evts = await types(store, "r1");
    // The LLM call we paid for is in the log and attributed before the failure.
    expect(evts).toContain("llm.call");
    expect(evts).toContain("message.assistant");
    expect(evts).toContain("run.failed");
    expect(evts.indexOf("llm.call")).toBeLessThan(evts.indexOf("run.failed"));

    const run = await store.getRun("r1");
    expect(run?.totalCostUsd).toBeGreaterThan(0);
  });
});

describe("DefaultRunner — strict HITL pause & resume (M1)", () => {
  const KEY = "RENDER_AGENTS_STRICT_APPROVAL";
  afterEach(() => { delete process.env[KEY]; });

  it("pauses on a gated tool, then resumes by replay once approved", async () => {
    process.env[KEY] = "1";
    const store = createMemoryStore();
    let invoked = 0;
    const tool: Tool = {
      name: "deploy",
      description: "x",
      inputSchema: {},
      async invoke() { invoked += 1; return { content: "deployed" }; },
    };
    const agent = makeAgent({ tools: ["deploy"], permissions: { requireApproval: ["deploy"] } });
    const responses: CompleteResult[] = [
      { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
      { content: [{ type: "text", text: "done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
    ];

    // First execution pauses awaiting approval.
    await expect(
      new DefaultRunner(mockModel(responses)).run(agent, "go", makeCtx(store, agent, "r1", new Map([["deploy", tool]]))),
    ).rejects.toBeInstanceOf(RunPaused);

    expect(invoked).toBe(0);
    const afterPause = await types(store, "r1");
    expect(afterPause).toContain("approval.requested");
    expect(afterPause).toContain("run.paused");
    expect(afterPause).not.toContain("tool.result");

    // Gateway resolves the approval.
    const approvalId = idempotencyKey("r1", "approval:tc1");
    await store.events.append(
      buildEventRecord("r1", { type: "approval.resolved", approvalRequestId: approvalId, approved: true }, { agentName: "tester" }),
    );

    // Resume: same runId, the loop replays and runs the now-approved tool.
    const out = await new DefaultRunner(mockModel(responses)).run(agent, "go", makeCtx(store, agent, "r1", new Map([["deploy", tool]])));
    expect(out.text).toBe("done");
    expect(invoked).toBe(1);

    const evts = await types(store, "r1");
    // run.started/message.user are not duplicated on resume.
    expect(evts.filter((t) => t === "run.started")).toHaveLength(1);
    expect(evts.filter((t) => t === "message.user")).toHaveLength(1);
    expect(evts).toContain("tool.result");
    expect(evts[evts.length - 1]).toBe("run.completed");
  });

  it("denies a gated tool when the recorded approval is rejected", async () => {
    process.env[KEY] = "1";
    const store = createMemoryStore();
    let invoked = 0;
    const tool: Tool = { name: "deploy", description: "x", inputSchema: {}, async invoke() { invoked += 1; return { content: "deployed" }; } };
    const agent = makeAgent({ tools: ["deploy"], permissions: { requireApproval: ["deploy"] } });
    const responses: CompleteResult[] = [
      { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
      { content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
    ];

    // Pre-resolve as denied before running.
    const approvalId = idempotencyKey("r1", "approval:tc1");
    await store.events.append(
      buildEventRecord("r1", { type: "approval.resolved", approvalRequestId: approvalId, approved: false, reason: "nope" }, { agentName: "tester" }),
    );

    const out = await new DefaultRunner(mockModel(responses)).run(agent, "go", makeCtx(store, agent, "r1", new Map([["deploy", tool]])));
    expect(invoked).toBe(0);
    expect(out.text).toBe("ok");
    const toolMsg = (await store.getMessages("r1", "tester")).find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ type: "tool_result", isError: true });
  });
});

describe("DefaultRunner — structured output schema validation (L1)", () => {
  it("retries when JSON parses but violates the schema, then succeeds", async () => {
    const store = createMemoryStore();
    const agent = makeAgent({
      output: { type: "object", properties: { decision: { type: "string", enum: ["approve", "reject"] } }, required: ["decision"] },
    });
    const runner = new DefaultRunner(
      mockModel([
        // Valid JSON, but wrong shape (missing required `decision`).
        { content: [{ type: "text", text: '{"verdict":"approve"}' }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
        // Schema-conforming.
        { content: [{ type: "text", text: '{"decision":"approve"}' }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
      ]),
    );

    const out = await runner.run(agent, "go", makeCtx(store, agent, "r1"));
    expect(out.data).toEqual({ decision: "approve" });
  });
});
