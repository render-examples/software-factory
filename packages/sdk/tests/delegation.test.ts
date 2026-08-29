import { describe, it, expect } from "vitest";
import type { CompleteArgs, CompleteResult } from "@render-factory/engine";
import { mockModel, createTestRuntime } from "../src/testing.js";
import { bindAgentSet } from "../src/agents.js";
import type { AgentDefinition } from "@render-factory/engine";

const judgeAgent: AgentDefinition = {
  name: "judge",
  model: { provider: "anthropic", model: "claude-haiku-4-5" },
  systemPrompt: "You are a judge.",
  tools: [],
  subagents: ["security"],
  output: { type: "object", properties: { decision: { type: "string" } }, required: ["decision"] },
};

const securityAgent: AgentDefinition = {
  name: "security",
  model: { provider: "anthropic", model: "claude-haiku-4-5" },
  systemPrompt: "You are a security reviewer.",
  tools: [],
};

describe("subagent delegation", () => {
  it("a run-scoped agent can delegate to a declared subagent via tool_use", async () => {
    let callCount = 0;
    const model = mockModel((args: CompleteArgs): CompleteResult => {
      callCount++;
      if (callCount === 1) {
        return {
          content: [{ type: "tool_use", id: "tc1", name: "subagents__security", input: { input: "check this" } }],
          usage: { inputTokens: 5, outputTokens: 5 },
          stopReason: "tool_use",
        };
      }
      return {
        content: [{ type: "text", text: '{"decision":"approve"}' }],
        usage: { inputTokens: 5, outputTokens: 3 },
        stopReason: "end_turn",
      };
    });

    const runtime = await createTestRuntime({ model });
    const agents = bindAgentSet([judgeAgent, securityAgent], runtime);

    const out = await agents.get("judge").run<{ decision: string }>("check this");
    expect(out.data?.decision).toBe("approve");
    expect(callCount).toBeGreaterThan(1);
  });

  it("inline dispatch (no Render runtime) produces the same result as run()", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    }));
    const runtime = await createTestRuntime({ model });
    const agents = bindAgentSet([securityAgent], runtime);
    const security = agents.get("security");

    const viaRun = await security.run("review");
    const viaTask = await security.task("review");
    expect(viaTask.text).toBe(viaRun.text);
  });
});
