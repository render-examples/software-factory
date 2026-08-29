import { describe, it, expect } from "vitest";
import { mockModel, createTestRuntime } from "../src/testing.js";
import { bindAgentSet } from "../src/agents.js";
import type { AgentDefinition } from "@render-factory/engine";

const judgeAgent: AgentDefinition = {
  name: "judge",
  model: { provider: "anthropic", model: "claude-haiku-4-5" },
  systemPrompt: "You are a judge.",
  tools: [],
  output: { type: "object", properties: { decision: { type: "string" } }, required: ["decision"] },
};

const securityAgent: AgentDefinition = {
  name: "security",
  model: { provider: "anthropic", model: "claude-haiku-4-5" },
  systemPrompt: "You are a security reviewer.",
  tools: [],
};

describe("Agent run/task walking skeleton", () => {
  it("runs the real loop against a mock model and resolves with text, fully event-sourced", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: '{"decision":"approve"}' }],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    }));
    const runtime = await createTestRuntime({ model });
    const agents = bindAgentSet([judgeAgent], runtime);

    const out = await agents.get("judge").run<{ decision: string }>({ findings: [] });
    expect(out.text).toBe('{"decision":"approve"}');

    const runs = await runtime.store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].workflow).toBe("judge");
    expect(runs[0].totalCostUsd).toBeGreaterThan(0);
  });

  it("agent.task() with no dispatcher produces identical output to agent.run()", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: "verdict" }],
      usage: { inputTokens: 3, outputTokens: 2 },
      stopReason: "end_turn",
    }));
    const runtime = await createTestRuntime({ model });
    const agents = bindAgentSet([securityAgent], runtime);

    const viaRun = await agents.get("security").run("review");
    const viaTask = await agents.get("security").task("review");
    expect(viaTask.text).toBe(viaRun.text);
    expect(viaTask.usage).toEqual(viaRun.usage);
  });
});
