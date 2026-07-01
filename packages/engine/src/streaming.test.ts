import { describe, it, expect } from "vitest";
import { createMemoryStore, MemoryCancelStore, MemoryDeltaBus, type MemoryRunStore, type StreamDelta, type Tracer } from "@render-agents/store";
import type { AgentDefinition } from "./agent.js";
import type { ModelClient, CompleteResult, ModelStreamEvent } from "./model.js";
import { DefaultRunner } from "./default-runner.js";
import { InProcessRunContext } from "./run-context.js";
import { passThroughContextManager } from "./context-manager.js";

const noopTracer: Tracer = { onStart: () => {}, onEnd: () => {} };

/** A model that streams `chunks` as text_deltas then returns the final result. */
function streamingModel(chunks: string[], final: CompleteResult): ModelClient {
  return {
    async complete() { return final; },
    async *stream(): AsyncGenerator<ModelStreamEvent, CompleteResult> {
      for (const text of chunks) yield { type: "text_delta", text };
      return final;
    },
  };
}

function makeAgent(): AgentDefinition {
  return {
    name: "tester",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    systemPrompt: "do stuff",
    tools: [],
  };
}

function makeCtx(
  store: MemoryRunStore,
  agent: AgentDefinition,
  runId: string,
  deltaBus?: MemoryDeltaBus,
  cancelStore?: MemoryCancelStore,
): InProcessRunContext {
  return new InProcessRunContext({
    runId,
    store,
    tracer: noopTracer,
    model: agent.model,
    agentName: agent.name,
    contextManager: passThroughContextManager,
    signal: new AbortController().signal,
    threadId: "t1",
    deltaBus,
    cancelStore,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: timed out");
}

async function subscribe(bus: MemoryDeltaBus, runId: string): Promise<{ got: StreamDelta[]; stop: () => Promise<void> }> {
  const controller = new AbortController();
  const got: StreamDelta[] = [];
  const done = (async () => {
    for await (const d of bus.subscribe({ runId }, controller.signal)) got.push(d);
  })();
  await Promise.resolve();
  return {
    got,
    stop: async () => {
      // Let the serialized publish tail + subscriber queue drain, then close.
      await new Promise((r) => setTimeout(r, 15));
      controller.abort();
      await done;
    },
  };
}

describe("DefaultRunner — token streaming (D13)", () => {
  it("publishes coalesced text deltas to the DeltaBus while keeping the log durable-only", async () => {
    const store = createMemoryStore();
    const bus = new MemoryDeltaBus();
    const agent = makeAgent();
    const final: CompleteResult = {
      content: [{ type: "text", text: "Hello world" }],
      usage: { inputTokens: 3, outputTokens: 2 },
      stopReason: "end_turn",
    };
    const runner = new DefaultRunner(streamingModel(["Hello ", "world"], final));

    const sub = await subscribe(bus, "r1");
    const out = await runner.run(agent, "hi?", makeCtx(store, agent, "r1", bus));
    await sub.stop();

    // The stream reassembled the same answer, and deltas carry it verbatim.
    expect(out.text).toBe("Hello world");
    expect(sub.got.length).toBeGreaterThan(0);
    expect(sub.got.map((d) => d.text).join("")).toBe("Hello world");
    expect(sub.got.every((d) => d.threadId === "t1" && d.agentName === "tester")).toBe(true);
    // Per-run delta sequence is monotonic from 1.
    expect(sub.got.map((d) => d.seq)).toEqual([...sub.got.map((_, i) => i + 1)]);

    // The durable log holds the canonical turn, never a transient delta.
    const types = (await store.events.read("r1")).map((e) => e.type);
    expect(types).toEqual(["run.started", "message.user", "llm.call", "message.assistant", "run.completed"]);
    expect(types).not.toContain("text.delta");
  });

  it("falls back to complete() with no deltas when the client has no stream()", async () => {
    const store = createMemoryStore();
    const bus = new MemoryDeltaBus();
    const agent = makeAgent();
    const model: ModelClient = {
      async complete() {
        return { content: [{ type: "text", text: "no stream" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      },
    };
    const runner = new DefaultRunner(model);

    const sub = await subscribe(bus, "r1");
    const out = await runner.run(agent, "hi?", makeCtx(store, agent, "r1", bus));
    await sub.stop();

    expect(out.text).toBe("no stream");
    expect(sub.got).toHaveLength(0);
  });

  it("aborts in-flight streaming and records run.cancelled when cancelled mid-generation (Stop)", async () => {
    const store = createMemoryStore();
    const bus = new MemoryDeltaBus();
    const cancelStore = new MemoryCancelStore();
    const agent = makeAgent();
    const final: CompleteResult = {
      content: [{ type: "text", text: "AB" }],
      usage: { inputTokens: 1, outputTokens: 2 },
      stopReason: "end_turn",
    };

    // Two flush-sized chunks; the model parks on `gate` between them so the test
    // can request cancellation while the call is genuinely in flight.
    const chunkA = "A".repeat(150);
    const chunkB = "B".repeat(150);
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    const model: ModelClient = {
      async complete() { return final; },
      async *stream(): AsyncGenerator<ModelStreamEvent, CompleteResult> {
        yield { type: "text_delta", text: chunkA };
        await gate;
        yield { type: "text_delta", text: chunkB };
        return final;
      },
    };
    const runner = new DefaultRunner(model);

    const sub = await subscribe(bus, "r1");
    const runPromise = runner.run(agent, "hi?", makeCtx(store, agent, "r1", bus, cancelStore));

    // Once the first chunk has streamed, hit Stop and let generation resume.
    await waitFor(() => sub.got.length >= 1);
    await cancelStore.requestCancel("r1");
    releaseGate();

    const out = await runPromise;
    await sub.stop();

    // The turn ended as a cancellation with no assembled answer...
    expect(out.text).toBe("");
    // ...and the post-cancel chunk was never published (Stop halted generation).
    expect(sub.got.map((d) => d.text).join("")).toBe(chunkA);

    // The durable log records a cancellation, not a completed/failed turn.
    const types = (await store.events.read("r1")).map((e) => e.type);
    expect(types).toEqual(["run.started", "message.user", "run.cancelled"]);
    expect(types).not.toContain("run.completed");
    expect(types).not.toContain("run.failed");
    expect(types).not.toContain("message.assistant");
  });
});
