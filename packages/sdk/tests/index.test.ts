import { describe, it, expect } from "vitest";
import { createRuntime, loadAgents, workflow, defineTool, defineMcpSource, defineHook, idempotencyKey, InProcessDispatcher } from "../src/index.js";
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

  it("loadAgents returns an AgentSet", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    }));
    const runtime = await createRuntime({ tenantId: "test-tenant", model });
    const agents = await loadAgents(".", runtime);
    expect(agents.all()).toEqual([]);
  });

  it("workflow returns a WorkflowDefinition", () => {
    const def = workflow(async () => {});
    expect(def.name).toBe("unnamed");
    expect(def.options.retries).toBe(0);
  });

  it("defineTool returns a ToolSource", () => {
    const source = defineTool({ name: "test", description: "test", inputSchema: {}, invoke: async () => "" });
    expect(source.id).toBe("test");
  });

  it("defineMcpSource returns a ToolSource (connects on mount)", () => {
    const source = defineMcpSource({ transport: "stdio" });
    expect(source.id).toBe("mcp");
  });

  it("defineHook returns the spec", () => {
    const hook = defineHook({
      name: "test",
      on: ["tool"],
      handle: async () => ({ action: "continue" as const }),
    });
    expect(hook.name).toBe("test");
  });

  it("idempotencyKey returns a SHA-256 hex digest", () => {
    expect(idempotencyKey("run1", "suffix")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("@render-factory/sdk/testing", () => {
  it("mockModel returns a ModelClient driven by the handler", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: "hi" }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    }));
    const result = await model.complete({
      model: { provider: "anthropic", model: "claude-haiku-4-5" },
      system: "",
      tools: [],
      messages: [],
      signal: new AbortController().signal,
    });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("createTestRuntime builds a memory runtime with an in-process dispatcher", async () => {
    const runtime = await createTestRuntime();
    expect(runtime.dispatcher).toBeInstanceOf(InProcessDispatcher);
    expect(runtime.runners.has("default")).toBe(true);
  });
});
