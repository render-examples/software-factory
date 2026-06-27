import { describe, it, expect } from "vitest";
import { createRuntime, loadAgents, workflow, defineTool, defineMcpSource, defineHook, idempotencyKey } from "../src/index.js";
import { mockModel, createTestRuntime } from "../src/testing.js";

describe("@render-agents/sdk", () => {
  it("createRuntime returns an in-memory, in-process-fallback runtime", async () => {
    const runtime = await createRuntime();
    expect(runtime.store).toBeDefined();
    expect(runtime.runners.has("default")).toBe(true);
    expect(runtime.dispatcher).toBeUndefined();
  });

  it("loadAgents returns an AgentSet", async () => {
    const agents = await loadAgents();
    expect(agents.all()).toEqual([]);
  });

  it("workflow throws not implemented", () => {
    expect(() => workflow(async () => {})).toThrow("not implemented");
  });

  it("defineTool throws not implemented", () => {
    expect(() =>
      defineTool({ name: "test", description: "test", inputSchema: {}, invoke: async () => "" }),
    ).toThrow("not implemented");
  });

  it("defineMcpSource throws not implemented", () => {
    expect(() => defineMcpSource({ transport: "stdio" })).toThrow("not implemented");
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

describe("@render-agents/sdk/testing", () => {
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

  it("createTestRuntime builds a memory runtime with no dispatcher", async () => {
    const runtime = await createTestRuntime();
    expect(runtime.dispatcher).toBeUndefined();
    expect(runtime.runners.has("default")).toBe(true);
  });
});
