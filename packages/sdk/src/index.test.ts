import { describe, it, expect } from "vitest";
import { createRuntime, loadAgents, workflow, defineTool, defineMcpSource, defineHook, idempotencyKey } from "../src/index.js";
import { mockModel, createTestRuntime } from "../src/testing.js";

describe("@render-agents/sdk", () => {
  it("createRuntime throws not implemented", () => {
    expect(() => createRuntime()).toThrow("not implemented");
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

  it("idempotencyKey throws not implemented", () => {
    expect(() => idempotencyKey("run1", "suffix")).toThrow("not implemented");
  });
});

describe("@render-agents/sdk/testing", () => {
  it("mockModel throws not implemented", () => {
    expect(() =>
      mockModel(() => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" })),
    ).toThrow("not implemented");
  });

  it("createTestRuntime throws not implemented", () => {
    expect(() => createTestRuntime()).toThrow("not implemented");
  });
});
