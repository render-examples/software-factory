import { describe, it, expect, vi } from "vitest";
import { createMemoryStore, buildEventRecord, idempotencyKey, type Tracer } from "@render-factory/store";
import { InProcessRunContext } from "../src/run-context.js";
import { passThroughContextManager } from "../src/context-manager.js";
import { RunPaused } from "../src/agent.js";
import type { ToolSource } from "../src/tool.js";

const noopTracer: Tracer = { onStart: () => {}, onEnd: () => {} };

function makeCtx(runId: string, toolSources?: Map<string, ToolSource>): {
  ctx: InProcessRunContext;
  store: ReturnType<typeof createMemoryStore>;
} {
  const store = createMemoryStore();
  const ctx = new InProcessRunContext({
    runId,
    store,
    tracer: noopTracer,
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    agentName: "tester",
    contextManager: passThroughContextManager,
    signal: new AbortController().signal,
    toolSources,
  });
  return { ctx, store };
}

function pausedId(err: unknown): string {
  expect(err).toBeInstanceOf(RunPaused);
  const paused = err as RunPaused;
  expect(paused.pendingInputIds?.length).toBeGreaterThan(0);
  return paused.pendingInputIds![0];
}

describe("InProcessRunContext.awaitInput", () => {
  it("reuses an unresolved message-input request on replay", async () => {
    const { ctx, store } = makeCtx("r1");

    let firstId = "";
    try {
      await ctx.awaitInput();
    } catch (err) {
      firstId = pausedId(err);
    }

    let secondId = "";
    try {
      await ctx.awaitInput();
    } catch (err) {
      secondId = pausedId(err);
    }

    expect(secondId).toBe(firstId);
    const events = await store.events.read("r1");
    const requested = events.filter((e) => e.payload.type === "input.requested" && e.payload.kind === "message");
    expect(requested).toHaveLength(1);
  });

  it("advances to a new deterministic request id after consuming prior input", async () => {
    const { ctx, store } = makeCtx("r2");

    let firstId = "";
    try {
      await ctx.awaitInput();
    } catch (err) {
      firstId = pausedId(err);
    }

    await store.events.append(
      buildEventRecord("r2", {
        type: "input.provided",
        inputRequestId: firstId,
        kind: "message",
        value: "hello",
      }, { agentName: "tester" }),
    );

    await expect(ctx.awaitInput()).resolves.toEqual([{ type: "text", text: "hello" }]);

    let nextId = "";
    try {
      await ctx.awaitInput();
    } catch (err) {
      nextId = pausedId(err);
    }

    expect(nextId).toBe(idempotencyKey("r2", "input:message:1"));
    expect(nextId).not.toBe(firstId);
  });
});

describe("InProcessRunContext.mountTools", () => {
  it("disposes already-opened sources when mount fails partway", async () => {
    const closeA = vi.fn(async () => {});
    const sourceA: ToolSource = {
      id: "a",
      async resolve() {
        return {
          tools: [{ name: "a", description: "a", inputSchema: {}, invoke: async () => ({ content: "ok" }) }],
          close: closeA,
        };
      },
    };
    const sourceB: ToolSource = {
      id: "b",
      async resolve() {
        throw new Error("boom");
      },
    };
    const { ctx } = makeCtx("r3", new Map([["a", sourceA], ["b", sourceB]]));

    await expect(ctx.mountTools(["a", "b"])).rejects.toThrow("boom");
    expect(closeA).toHaveBeenCalledTimes(1);
  });
});
