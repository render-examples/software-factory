import { describe, it, expect } from "vitest";
import { createRuntime, defineTool, defineMcpSource, defineAgent, defineWorkflow, defineFactory, md, idempotencyKey, InProcessDispatcher } from "../src/index.js";
import { mockModel, createTestRuntime } from "../src/testing.js";

describe("@render-factory/sdk", () => {
  it("createRuntime returns an in-memory runtime with an in-process dispatcher", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    }));
    const runtime = await createRuntime({ tenantId: "test-tenant", model });
    expect(runtime.store).toBeDefined();
    expect(runtime.runners.has("default")).toBe(true);
    expect(runtime.dispatcher).toBeInstanceOf(InProcessDispatcher);
  });

  it("defineAgent returns a frozen AgentDef", () => {
    const agent = defineAgent({
      id: "test-agent",
      prompt: md`You are a test agent.`,
    });
    expect(agent.__brand).toBe("AgentDef");
    expect(agent.id).toBe("test-agent");
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it("defineWorkflow returns a frozen WorkflowDef", () => {
    const agent = defineAgent({ id: "a", prompt: "test" });
    const wf = defineWorkflow({
      id: "test-wf",
      agents: [agent] as const,
      run: async () => {},
    });
    expect(wf.__brand).toBe("WorkflowDef");
    expect(wf.id).toBe("test-wf");
    expect(Object.isFrozen(wf)).toBe(true);
  });

  it("defineTool returns a ToolSource", () => {
    const source = defineTool({ id: "test", description: "test", inputSchema: {}, invoke: async () => "" });
    expect(source.id).toBe("test");
  });

  it("defineMcpSource returns a ToolSource (connects on mount)", () => {
    const source = defineMcpSource({ transport: "stdio" });
    expect(source.id).toBe("mcp");
  });

  it("defineFactory returns a frozen FactoryDef", () => {
    const agent = defineAgent({ id: "a", prompt: "test" });
    const wf = defineWorkflow({ id: "wf", agents: [agent] as const, run: async () => {} });
    const factory = defineFactory({ workflows: [wf] });
    expect(factory.__brand).toBe("FactoryDef");
    expect(Object.isFrozen(factory)).toBe(true);
  });

  it("md strips common indentation", () => {
    const text = md`
      Hello
        World
    `;
    expect(text).toBe("Hello\n  World");
  });

  it("idempotencyKey is deterministic", () => {
    expect(idempotencyKey("a", "b")).toBe(idempotencyKey("a", "b"));
    expect(idempotencyKey("a", "b")).not.toBe(idempotencyKey("a", "c"));
  });
});
