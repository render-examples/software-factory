import { describe, it, expect, afterEach } from "vitest";
import { createMemoryStore, buildEventRecord, type RunStore, type Tracer } from "@render-factory/store";
import { InProcessRunContext } from "../src/run-context.js";
import { passThroughContextManager } from "../src/context-manager.js";
import { ReplaySuspender, type Suspender, type SuspendRequest } from "../src/suspender.js";
import { RunPaused } from "../src/agent.js";

const noopTracer: Tracer = { onStart: () => {}, onEnd: () => {} };

/**
 * A continuation-preserving (native Render Workflows-style) suspender: instead
 * of throwing to unwind, `park` simulates the external resume by recording the
 * resolution in the same log the ctx reads, then returns — so the awaited call
 * resumes in place and reads its answer, exactly as the native path will.
 */
function nativeStyleSuspender(getStore: () => RunStore, resolution: Record<string, unknown>): Suspender {
  return {
    async park(req: SuspendRequest): Promise<void> {
      await getStore().events.append(
        buildEventRecord(req.runId, {
          type: "input.provided",
          inputRequestId: req.inputRequestId,
          kind: req.kind,
          ...resolution,
        }, { agentName: "tester" }),
      );
    },
  };
}

describe("Suspender seam", () => {
  const KEY = "RENDER_FACTORY_STRICT_APPROVAL";
  afterEach(() => { delete process.env[KEY]; });

  it("default (ReplaySuspender) unwinds requestInput via RunPaused", async () => {
    process.env[KEY] = "1";
    const store = createMemoryStore();
    const ctx = new InProcessRunContext({
      runId: "r0",
      store,
      tracer: noopTracer,
      model: { provider: "anthropic", model: "claude-haiku-4-5" },
      agentName: "tester",
      contextManager: passThroughContextManager,
      signal: new AbortController().signal,
      suspender: new ReplaySuspender(),
    });

    await expect(ctx.requestInput("deploy", {}, "tc1")).rejects.toBeInstanceOf(RunPaused);
    const types = (await store.events.read("r0")).map((e) => e.type);
    expect(types).toContain("input.requested");
    expect(types).toContain("run.paused");
  });

  it("continuation-preserving suspender resolves requestInput inline (no throw)", async () => {
    process.env[KEY] = "1";
    const store = createMemoryStore();
    const ctx = new InProcessRunContext({
      runId: "r1",
      store,
      tracer: noopTracer,
      model: { provider: "anthropic", model: "claude-haiku-4-5" },
      agentName: "tester",
      contextManager: passThroughContextManager,
      signal: new AbortController().signal,
      suspender: nativeStyleSuspender(() => store, { approved: true }),
    });

    const result = await ctx.requestInput("deploy", {}, "tc1");
    expect(result).toEqual({ approved: true });
    const types = (await store.events.read("r1")).map((e) => e.type);
    // The pause is still recorded (operator UI / delivery depend on it).
    expect(types).toContain("input.requested");
    expect(types).toContain("run.paused");
    expect(types).toContain("input.provided");
  });

  it("continuation-preserving suspender resolves awaitInput inline with the delivered message", async () => {
    const store = createMemoryStore();
    const ctx = new InProcessRunContext({
      runId: "r2",
      store,
      tracer: noopTracer,
      model: { provider: "anthropic", model: "claude-haiku-4-5" },
      agentName: "tester",
      contextManager: passThroughContextManager,
      signal: new AbortController().signal,
      suspender: nativeStyleSuspender(() => store, { value: "resumed answer" }),
    });

    await expect(ctx.awaitInput()).resolves.toEqual([{ type: "text", text: "resumed answer" }]);
    const types = (await store.events.read("r2")).map((e) => e.type);
    expect(types).toContain("run.paused");
  });
});
