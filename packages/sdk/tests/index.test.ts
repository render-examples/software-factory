import { describe, it, expect } from "vitest";
import { createRuntime, defineTool, defineMcpSource, Agent, md, idempotencyKey, InProcessDispatcher, matchesRepoAllowlist } from "../src/index.js";
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

  it("Agent() returns a frozen AgentDef with pure config", () => {
    const agent = Agent({
      id: "test-agent",
      prompt: md`You are a test agent.`,
    });
    expect(agent.__kind).toBe("AgentDef");
    expect(agent.id).toBe("test-agent");
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it("Agent() requires prompt", () => {
    expect(() => Agent({ id: "bad" } as never)).toThrow(/prompt is required/);
  });

  it("defineTool returns a ToolSource", () => {
    const source = defineTool({ id: "test", description: "test", inputSchema: {}, invoke: async () => "" });
    expect(source.id).toBe("test");
  });

  it("defineMcpSource returns a ToolSource (connects on mount)", () => {
    const source = defineMcpSource({ transport: "stdio" });
    expect(source.id).toBe("mcp");
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

  it("matchesRepoAllowlist treats punctuation literally with segment wildcards", () => {
    expect(matchesRepoAllowlist("render/foo.bar", ["render/foo.bar"])).toBe(true);
    expect(matchesRepoAllowlist("render/fooXbar", ["render/foo.bar"])).toBe(false);
    expect(matchesRepoAllowlist("render/anything", ["render/*"])).toBe(true);
    expect(matchesRepoAllowlist("render/nested/repo", ["render/*"])).toBe(false);
  });
});
