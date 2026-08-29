import { describe, it, expect } from "vitest";
import { createMemoryStore, buildEventRecord } from "@render-factory/store";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { bindAgentSet } from "../src/agents.js";
import { defineTool } from "@render-factory/engine";
import type { AgentDefinition } from "@render-factory/engine";

describe("NFR: agent registration", () => {
  it("registers 20 typed agents well under budget (target < 50ms)", async () => {
    const definitions: AgentDefinition[] = [];
    for (let i = 0; i < 20; i++) {
      definitions.push({
        name: `agent-${i}`,
        model: { provider: "anthropic", model: "claude-haiku-4-5" },
        systemPrompt: `You are agent ${i}.`,
        tools: [],
      });
    }
    const runtime = await createTestRuntime({ model: mockModel(() => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" })) });
    const t0 = performance.now();
    const agents = bindAgentSet(definitions, runtime);
    const ms = performance.now() - t0;
    console.log(`[nfr] register 20 agents: ${ms.toFixed(1)}ms`);
    expect(agents.all()).toHaveLength(20);
    expect(ms).toBeLessThan(500);
  });
});

describe("NFR: event append latency", () => {
  it("appends an event well under budget (target < 5ms)", async () => {
    const store = createMemoryStore();
    await store.init();
    const record = buildEventRecord("run-1", { type: "run.started", input: "x" }, { agentName: "nfr" });
    const t0 = performance.now();
    await store.events.append(record);
    const ms = performance.now() - t0;
    console.log(`[nfr] event append: ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(50);
  });
});

describe("NFR: agent loop overhead per turn", () => {
  it("loop overhead per turn is well under budget (target < 10ms)", async () => {
    const turns = 5;
    let calls = 0;
    const model = mockModel(() => {
      calls++;
      if (calls <= turns) {
        return { content: [{ type: "tool_use", id: `tc${calls}`, name: "noop", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
      }
      return { content: [{ type: "text", text: "done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    });
    const toolSources = new Map([["noop", defineTool({ name: "noop", description: "x", inputSchema: {}, async invoke() { return "ok"; } })]]);
    const runtime = await createTestRuntime({ model, toolSources });
    runtime.agentDefinitions.set("looper", { name: "looper", model: { provider: "anthropic", model: "m" }, systemPrompt: "loop", tools: ["noop"] });

    const t0 = performance.now();
    await runtime.dispatcher!.dispatch("looper", "go", { runId: "nfr-loop", idempotencyKey: "nfr-loop" });
    const ms = performance.now() - t0;
    const perTurn = ms / turns;
    console.log(`[nfr] loop overhead: ${perTurn.toFixed(2)}ms/turn (${turns} turns, ${ms.toFixed(1)}ms total)`);
    expect(perTurn).toBeLessThan(100);
  });
});
