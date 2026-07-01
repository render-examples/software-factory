import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, buildEventRecord } from "@render-agents/store";
import { loadAgents } from "../src/agents.js";
import { createTestRuntime, mockModel } from "../src/testing.js";

/**
 * Non-functional requirement gates (Operations → NFR). Encoded as automated
 * checks with generous margins to avoid CI-runner flakiness; the actual
 * measurement is logged for trend tracking. Targets: load < 500ms/20 agents,
 * event append < 5ms, loop overhead < 10ms/turn.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ra-nfr-"));
  await mkdir(join(dir, "agents"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    await writeFile(
      join(dir, "agents", `agent-${i}.md`),
      `---\nmodel: medium\ndescription: agent ${i}\n---\n\nYou are agent ${i}.\n`,
    );
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("NFR: agent load + validation", () => {
  it("loads + validates 20 agents well under budget (target < 500ms)", async () => {
    const runtime = await createTestRuntime({ model: mockModel(() => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" })) });
    const t0 = performance.now();
    const agents = await loadAgents(dir, runtime);
    const ms = performance.now() - t0;
    console.log(`[nfr] load 20 agents: ${ms.toFixed(1)}ms`);
    expect(agents.all()).toHaveLength(20);
    expect(ms).toBeLessThan(1500); // 3× margin over the 500ms target
  });
});

describe("NFR: event append latency", () => {
  it("appends + folds events with low latency (target < 5ms)", async () => {
    const store = createMemoryStore();
    const N = 300;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      await store.events.append(
        buildEventRecord("nfr-run", i === 0 ? { type: "run.started", input: "x" } : { type: "llm.call", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.001, stopReason: "end_turn", latencyMs: 1 }, { agentName: "a" }),
      );
    }
    const avg = (performance.now() - t0) / N;
    console.log(`[nfr] event append+fold avg: ${avg.toFixed(3)}ms over ${N}`);
    expect(avg).toBeLessThan(5);
  });
});

describe("NFR: LLM-loop overhead per turn", () => {
  it("keeps per-turn loop overhead low excluding model latency (target < 10ms)", async () => {
    const TURNS = 8;
    let calls = 0;
    // Each model call returns a tool_use until the last turn, then text — driving
    // multiple loop iterations. Model latency is ~0 so we measure loop overhead.
    const model = mockModel(() => {
      calls += 1;
      if (calls < TURNS) {
        return { content: [{ type: "tool_use", id: `tc${calls}`, name: "noop", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
      }
      return { content: [{ type: "text", text: "done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    });
    const { defineTool } = await import("../src/authoring.js");
    const toolSources = new Map([["noop", defineTool({ name: "noop", description: "x", inputSchema: {}, async invoke() { return "ok"; } })]]);
    const runtime = await createTestRuntime({ model, toolSources });
    runtime.agentDefinitions.set("looper", { name: "looper", model: { provider: "anthropic", model: "m" }, systemPrompt: "loop", tools: ["noop"] });

    const t0 = performance.now();
    await runtime.dispatcher!.dispatch("looper", "go", { runId: "nfr-loop", idempotencyKey: "nfr-loop" });
    const perTurn = (performance.now() - t0) / calls;
    console.log(`[nfr] loop overhead per turn: ${perTurn.toFixed(3)}ms over ${calls} model calls`);
    expect(perTurn).toBeLessThan(30); // 3× margin over the 10ms target (memory store)
  });
});
