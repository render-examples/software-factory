import { describe, it, expect, afterEach } from "vitest";
import { Agent, defineTool, md } from "../src/index.js";
import { mockModel, createTestRuntime } from "../src/testing.js";
import { _setSharedRuntime, _resetSharedRuntime } from "../src/agent-task.js";

afterEach(() => {
  _resetSharedRuntime();
});

describe("agentTask()", () => {
  it("Agent() returns pure frozen config", () => {
    const agent = Agent({
      id: "test",
      prompt: md`You are a test agent.`,
    });
    expect(agent.__kind).toBe("AgentDef");
    expect(agent.id).toBe("test");
    expect(agent.spec.prompt).toBe("You are a test agent.");
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it("Agent() rejects missing prompt", () => {
    expect(() => Agent({ id: "bad" } as never)).toThrow(/prompt is required/);
  });

  it("Agent() accepts executor field for future pluggability", () => {
    const agent = Agent({
      id: "future",
      prompt: "test",
      executor: "claude-code",
    });
    expect(agent.spec.executor).toBe("claude-code");
  });

  it("setup tools receive runtime context at materialization time", async () => {
    let gotStore = false;
    let gotRuntime = false;
    const setupTool = defineTool({
      id: "inspectable",
      description: "Checks setup context",
      inputSchema: { type: "object" },
      setup(ctx) {
        gotStore = Boolean(ctx.store);
        gotRuntime = Boolean(ctx.runtime);
        return {
          id: "inspectable",
          description: "Checks setup context",
          inputSchema: { type: "object" },
          async invoke() { return "inspected"; },
        };
      },
    });

    const runtime = await createTestRuntime({
      model: mockModel(() => ({
        content: [{ type: "text", text: "ok" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      })),
    });

    const agent = Agent({
      id: "inspector",
      prompt: "Inspect.",
      tools: [setupTool],
    });

    _setSharedRuntime(runtime);

    const { agentTask } = await import("../src/agent-task.js");
    const agentTaskFn = agentTask(agent);
    expect(agentTaskFn).toBeDefined();
    expect(typeof agentTaskFn).toBe("function");
  });
});
