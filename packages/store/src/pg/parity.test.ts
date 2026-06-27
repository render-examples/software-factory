import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { RunEvent, RunStore } from "../index.js";
import { buildEventRecord, createMemoryStore, replay } from "../memory-store.js";
import { PgRunStore } from "../pg/postgres-store.js";

/**
 * Parity tests: run the same scripted event sequences against both memory and
 * Postgres stores, verify projections produce identical reads.
 *
 * Skips when TEST_DATABASE_URL is not set (local dev without Postgres).
 * CI provides a Postgres service; run with:
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPg = TEST_DATABASE_URL ? describe : describe.skip;

const AGENT = "judge";

async function emit(
  store: RunStore,
  runId: string,
  event: RunEvent,
  meta?: { agentName?: string; spanId?: string; parentSpanId?: string },
): Promise<void> {
  await store.events.append(buildEventRecord(runId, event, { agentName: AGENT, ...meta }));
}

describeWithPg("PgRunStore / MemoryRunStore parity", () => {
  let pgStore: PgRunStore;
  let memStore: ReturnType<typeof createMemoryStore>;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
    memStore = createMemoryStore();
  });

  afterAll(async () => {
    await pgStore.close();
  });

  it("folds run status and cost identically", async () => {
    const runId = `parity-run-${Date.now()}`;

    const events: Array<{ event: RunEvent; meta?: { agentName?: string; spanId?: string; parentSpanId?: string } }> = [
      { event: { type: "run.started", input: { findings: [] } }, meta: { spanId: "a1" } },
      {
        event: {
          type: "llm.call", model: "claude-opus-4-6",
          usage: { inputTokens: 10, outputTokens: 5 },
          costUsd: 0.001, stopReason: "end_turn", latencyMs: 12,
        },
        meta: { spanId: "llm-1", parentSpanId: "a1" },
      },
      {
        event: {
          type: "llm.call", model: "claude-opus-4-6",
          usage: { inputTokens: 20, outputTokens: 8 },
          costUsd: 0.002, stopReason: "end_turn", latencyMs: 9,
        },
        meta: { spanId: "llm-2", parentSpanId: "a1" },
      },
      { event: { type: "run.completed", result: "verdict" }, meta: { spanId: "a1" } },
    ];

    for (const { event, meta } of events) {
      await emit(pgStore, runId, event, meta);
      await emit(memStore, runId, event, meta);
    }

    const pgRun = await pgStore.getRun(runId);
    const memRun = await memStore.getRun(runId);

    expect(pgRun?.status).toBe(memRun?.status);
    expect(pgRun?.status).toBe("completed");
    expect(pgRun?.workflow).toBe(memRun?.workflow);
    expect(pgRun?.result).toEqual(memRun?.result);
    expect(Number(pgRun?.totalCostUsd)).toBeCloseTo(memRun?.totalCostUsd ?? 0, 10);
  });

  it("folds message history identically", async () => {
    const runId = `parity-msgs-${Date.now()}`;

    const events: Array<{ event: RunEvent; meta?: { agentName?: string; spanId?: string } }> = [
      { event: { type: "run.started" } },
      { event: { type: "message.user", content: [{ type: "text", text: "review this" }] } },
      { event: { type: "message.assistant", agentName: AGENT, content: [{ type: "text", text: "ok" }] } },
      { event: { type: "message.assistant", agentName: "other", content: [{ type: "text", text: "noise" }] } },
    ];

    for (const { event, meta } of events) {
      await emit(pgStore, runId, event, meta);
      await emit(memStore, runId, event, meta);
    }

    const pgMsgs = await pgStore.getMessages(runId, AGENT);
    const memMsgs = await memStore.getMessages(runId, AGENT);

    expect(pgMsgs.length).toBe(memMsgs.length);
    expect(pgMsgs.map(m => m.role)).toEqual(memMsgs.map(m => m.role));
    expect(pgMsgs.map(m => m.content)).toEqual(memMsgs.map(m => m.content));
  });

  it("folds the span tree identically", async () => {
    const runId = `parity-spans-${Date.now()}`;

    const events: Array<{ event: RunEvent; meta?: { agentName?: string; spanId?: string; parentSpanId?: string } }> = [
      { event: { type: "run.started", input: "x" }, meta: { spanId: "agent-1" } },
      { event: { type: "tool.called", toolCallId: `t-${runId}`, name: "search", input: { q: "a" } }, meta: { spanId: "tool-1", parentSpanId: "agent-1" } },
      { event: { type: "tool.result", toolCallId: `t-${runId}`, name: "search", result: { content: "found" } }, meta: { spanId: "tool-1", parentSpanId: "agent-1" } },
      { event: { type: "run.completed", result: "done" }, meta: { spanId: "agent-1" } },
    ];

    for (const { event, meta } of events) {
      await emit(pgStore, runId, event, meta);
      await emit(memStore, runId, event, meta);
    }

    const pgSpans = await pgStore.listSpans(runId);
    const memSpans = await memStore.listSpans(runId);

    expect(pgSpans.length).toBe(memSpans.length);
    for (let i = 0; i < pgSpans.length; i++) {
      expect(pgSpans[i]!.id).toBe(memSpans[i]!.id);
      expect(pgSpans[i]!.kind).toBe(memSpans[i]!.kind);
      expect(pgSpans[i]!.status).toBe(memSpans[i]!.status);
      expect(pgSpans[i]!.parentId).toBe(memSpans[i]!.parentId);
    }
  });

  it("records tool results for idempotency lookup", async () => {
    const runId = `parity-tools-${Date.now()}`;
    const toolCallId = `tc-${runId}`;

    const events: Array<{ event: RunEvent; meta?: { spanId?: string; parentSpanId?: string } }> = [
      { event: { type: "run.started" } },
      { event: { type: "tool.called", toolCallId, name: "search", input: {} }, meta: { spanId: "tool-1" } },
      { event: { type: "tool.result", toolCallId, name: "search", result: { content: "real data" } }, meta: { spanId: "tool-1" } },
    ];

    for (const { event, meta } of events) {
      await emit(pgStore, runId, event, meta);
      await emit(memStore, runId, event, meta);
    }

    const pgResult = await pgStore.getToolResult(runId, toolCallId);
    const memResult = await memStore.getToolResult(runId, toolCallId);

    expect(pgResult).toEqual(memResult);
    expect(pgResult?.content).toBe("real data");
  });

  it("memoizes step results by (runId, name)", async () => {
    const runId = `parity-steps-${Date.now()}`;

    const events: Array<{ event: RunEvent; meta?: { spanId?: string } }> = [
      { event: { type: "run.started" } },
      { event: { type: "step.started", name: "prepare" }, meta: { spanId: "step-1" } },
      { event: { type: "step.completed", name: "prepare", result: { diff: 3 } }, meta: { spanId: "step-1" } },
    ];

    for (const { event, meta } of events) {
      await emit(pgStore, runId, event, meta);
      await emit(memStore, runId, event, meta);
    }

    const pgStep = await pgStore.getStepResult(runId, "prepare");
    const memStep = await memStore.getStepResult(runId, "prepare");

    expect(pgStep).toEqual(memStep);
    expect(pgStep?.value).toEqual({ diff: 3 });
  });

  it("event read returns identical records", async () => {
    const runId = `parity-read-${Date.now()}`;

    await emit(pgStore, runId, { type: "run.started" });
    await emit(memStore, runId, { type: "run.started" });
    await emit(pgStore, runId, { type: "run.completed", result: "done" });
    await emit(memStore, runId, { type: "run.completed", result: "done" });

    const pgEvents = await pgStore.events.read(runId);
    const memEvents = await memStore.events.read(runId);

    expect(pgEvents.length).toBe(memEvents.length);
    expect(pgEvents.map(e => e.seq)).toEqual(memEvents.map(e => e.seq));
    expect(pgEvents.map(e => e.type)).toEqual(memEvents.map(e => e.type));
  });

  it("event read with fromSeq works identically", async () => {
    const runId = `parity-fromseq-${Date.now()}`;

    await emit(pgStore, runId, { type: "run.started" });
    await emit(memStore, runId, { type: "run.started" });
    await emit(pgStore, runId, { type: "message.user", content: [{ type: "text", text: "hi" }] });
    await emit(memStore, runId, { type: "message.user", content: [{ type: "text", text: "hi" }] });
    await emit(pgStore, runId, { type: "run.completed", result: "done" });
    await emit(memStore, runId, { type: "run.completed", result: "done" });

    const pgFrom2 = await pgStore.events.read(runId, 2);
    const memFrom2 = await memStore.events.read(runId, 2);

    expect(pgFrom2.map(e => e.seq)).toEqual(memFrom2.map(e => e.seq));
    expect(pgFrom2.map(e => e.type)).toEqual(memFrom2.map(e => e.type));
  });

  it("listRuns returns runs in descending start order", async () => {
    const run1 = `parity-list1-${Date.now()}`;
    const run2 = `parity-list2-${Date.now()}`;

    await emit(pgStore, run1, { type: "run.started" });
    await emit(memStore, run1, { type: "run.started" });
    // Small delay to ensure ordering
    await new Promise(r => setTimeout(r, 10));
    await emit(pgStore, run2, { type: "run.started" });
    await emit(memStore, run2, { type: "run.started" });

    const pgRuns = await pgStore.listRuns({ workflow: AGENT, limit: 2 });
    const memRuns = await memStore.listRuns({ workflow: AGENT, limit: 2 });

    // Both should list most recent first
    expect(pgRuns.length).toBeGreaterThanOrEqual(2);
    expect(memRuns.length).toBeGreaterThanOrEqual(2);
    expect(pgRuns[0]!.id).toBe(run2);
    expect(memRuns[0]!.id).toBe(run2);
  });
});

describeWithPg("PgRunStore.init() idempotency", () => {
  it("is safe to call multiple times (advisory lock)", async () => {
    const store = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await store.init();
    await store.init(); // second call should be a no-op
    await store.close();
  });
});

describeWithPg("PgEventLogStore.tail", () => {
  let pgStore: PgRunStore;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
  });

  afterAll(async () => {
    await pgStore.close();
  });

  it("delivers appended events via LISTEN/NOTIFY", async () => {
    const runId = `parity-tail-${Date.now()}`;
    const controller = new AbortController();
    const received: string[] = [];

    // Ensure the run exists first
    await emit(pgStore, runId, { type: "run.started" });

    const iter = pgStore.events.tail({ runId }, controller.signal);
    const consumer = (async () => {
      for await (const rec of iter) {
        received.push(rec.type);
        if (received.length === 2) {
          controller.abort();
          break;
        }
      }
    })();

    // Give the LISTEN client time to subscribe
    await new Promise(r => setTimeout(r, 100));

    await emit(pgStore, runId, { type: "message.user", content: [{ type: "text", text: "hello" }] });
    await emit(pgStore, `other-${Date.now()}`, { type: "run.started" }); // filtered out
    await emit(pgStore, runId, { type: "run.completed", result: "ok" });

    await consumer;
    expect(received).toEqual(["message.user", "run.completed"]);
  });
});
