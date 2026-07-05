import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { RunEvent, RunStore } from "../../src/index.js";
import { buildEventRecord, createMemoryStore, replay } from "../../src/memory-store.js";
import { PgRunStore } from "../../src/pg/postgres-store.js";

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

/** Drop the store-local, wall-clock-derived `latencyMs` for cross-store compare. */
function stripLatency(attrs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!attrs) return attrs;
  const { latencyMs: _omit, ...rest } = attrs as Record<string, unknown>;
  void _omit;
  return rest;
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

    // Span ids are the global `spans.id` PK, so scope them to this run to avoid
    // cross-test collisions (production ids are UUID / idempotencyKey-derived).
    const A = `${runId}-agent`, L1 = `${runId}-llm1`, L2 = `${runId}-llm2`, T = `${runId}-tool`;
    const events: Array<{ event: RunEvent; meta?: { agentName?: string; spanId?: string; parentSpanId?: string } }> = [
      { event: { type: "run.started", input: "x", agentVersion: "v1", model: "claude-sonnet-4-6" }, meta: { agentName: "security", spanId: A } },
      { event: { type: "llm.call", model: "claude-sonnet-4-6", usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01, stopReason: "tool_use", latencyMs: 42 }, meta: { spanId: L1, parentSpanId: A } },
      { event: { type: "tool.called", toolCallId: `t-${runId}`, name: "search", input: { q: "a" } }, meta: { spanId: T, parentSpanId: A } },
      { event: { type: "tool.result", toolCallId: `t-${runId}`, name: "search", result: { content: "found" } }, meta: { spanId: T, parentSpanId: A } },
      { event: { type: "llm.call", model: "claude-sonnet-4-6", usage: { inputTokens: 8, outputTokens: 3 }, costUsd: 0.02, stopReason: "end_turn", latencyMs: 20 }, meta: { spanId: L2, parentSpanId: A } },
      { event: { type: "run.completed", result: "done" }, meta: { spanId: A } },
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
      // Span attributes fold identically across stores — except `latencyMs`,
      // which is derived from each store's own append timestamp (the test emits
      // a fresh record per store), so it is store-local rather than a fold of
      // the shared log. Compare it for type, the rest byte-for-byte.
      expect(stripLatency(pgSpans[i]!.attributes)).toEqual(stripLatency(memSpans[i]!.attributes));
    }
    // Tool span latency is present and numeric in both stores.
    expect(typeof (memSpans.find((s) => s.id === T)!.attributes as { latencyMs?: number }).latencyMs).toBe("number");
    expect(typeof (pgSpans.find((s) => s.id === T)!.attributes as { latencyMs?: number }).latencyMs).toBe("number");

    // Agent span carries the spec's required attributes, accumulated from llm.call.
    const memAgent = memSpans.find((s) => s.id === A)!;
    expect(memAgent.kind).toBe("agent");
    expect(memAgent.attributes).toMatchObject({
      agentName: "security",
      agentVersion: "v1",
      model: "claude-sonnet-4-6",
      iterations: 2,
      usage: { inputTokens: 18, outputTokens: 8 },
    });
    // LLM span carries gen_ai.* aliases; tool span carries latency + ok.
    expect(memSpans.find((s) => s.id === L1)!.attributes).toMatchObject({
      "gen_ai.request.model": "claude-sonnet-4-6",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.response.finish_reasons": ["tool_use"],
    });
    expect(memSpans.find((s) => s.id === T)!.attributes).toMatchObject({ toolName: "search", ok: true });
  });

  it("folds a workflow root span as kind 'workflow'", async () => {
    const runId = `parity-wf-${Date.now()}`;
    const events: Array<{ event: RunEvent; meta?: { agentName?: string; spanId?: string } }> = [
      { event: { type: "run.started", input: {}, trigger: "api", spanKind: "workflow" }, meta: { agentName: "code-review", spanId: runId } },
      { event: { type: "step.started", name: "prepare" }, meta: { agentName: "code-review", spanId: `${runId}-step` } },
      { event: { type: "step.completed", name: "prepare", result: 1 }, meta: { agentName: "code-review", spanId: `${runId}-step` } },
      { event: { type: "run.completed", result: "ok" }, meta: { agentName: "code-review", spanId: runId } },
    ];
    for (const { event, meta } of events) {
      await emit(pgStore, runId, event, meta);
      await emit(memStore, runId, event, meta);
    }
    const pgRoot = (await pgStore.listSpans(runId)).find((s) => s.id === runId)!;
    const memRoot = (await memStore.listSpans(runId)).find((s) => s.id === runId)!;
    expect(memRoot.kind).toBe("workflow");
    expect(pgRoot.kind).toBe("workflow");
    expect(pgRoot.attributes).toEqual(memRoot.attributes);
    expect(memRoot.status).toBe("ok");
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

  it("handles repeated toolCallId across different runs identically", async () => {
    const runA = `parity-toolid-a-${Date.now()}`;
    const runB = `parity-toolid-b-${Date.now()}`;
    const sharedToolCallId = "call_0";

    for (const store of [pgStore, memStore]) {
      for (const [runId, content] of [[runA, "from-a"], [runB, "from-b"]] as const) {
        await store.events.append(buildEventRecord(runId, { type: "run.started", input: {} }, { agentName: AGENT, spanId: runId }));
        await store.events.append(buildEventRecord(runId, { type: "tool.called", toolCallId: sharedToolCallId, name: "search", input: {} }, { agentName: AGENT, spanId: `${runId}-tool` }));
        await store.events.append(buildEventRecord(runId, { type: "tool.result", toolCallId: sharedToolCallId, name: "search", result: { content } }, { agentName: AGENT, spanId: `${runId}-tool` }));
      }
    }

    expect((await pgStore.getToolResult(runA, sharedToolCallId))?.content).toBe("from-a");
    expect((await pgStore.getToolResult(runB, sharedToolCallId))?.content).toBe("from-b");
    expect((await memStore.getToolResult(runA, sharedToolCallId))?.content).toBe("from-a");
    expect((await memStore.getToolResult(runB, sharedToolCallId))?.content).toBe("from-b");
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

  it("listRuns before-cursor keyset matches memory semantics with tie timestamps", async () => {
    const tag = `parity-cursor-${Date.now()}`;
    const t = "2026-02-01T00:00:00.000Z";
    const runA = `${tag}-a`;
    const runB = `${tag}-b`;
    const runC = `${tag}-c`;

    // B and A share the same started_at; DESC id order is B then A.
    for (const store of [pgStore, memStore]) {
      await store.events.append(buildEventRecord(runA, { type: "run.started", input: {} }, { agentName: AGENT, spanId: runA, ts: t }));
      await store.events.append(buildEventRecord(runA, { type: "run.completed", result: "ok" }, { agentName: AGENT, spanId: runA, ts: t }));
      await store.events.append(buildEventRecord(runB, { type: "run.started", input: {} }, { agentName: AGENT, spanId: runB, ts: t }));
      await store.events.append(buildEventRecord(runB, { type: "run.completed", result: "ok" }, { agentName: AGENT, spanId: runB, ts: t }));
      await store.events.append(buildEventRecord(runC, { type: "run.started", input: {} }, { agentName: AGENT, spanId: runC, ts: "2026-01-01T00:00:00.000Z" }));
      await store.events.append(buildEventRecord(runC, { type: "run.completed", result: "ok" }, { agentName: AGENT, spanId: runC, ts: "2026-01-01T00:00:00.000Z" }));
    }

    const pgBeforeB = (await pgStore.listRuns({ before: runB, limit: 10 })).map((r) => r.id);
    const memBeforeB = (await memStore.listRuns({ before: runB, limit: 10 })).map((r) => r.id);
    expect(pgBeforeB).toEqual(memBeforeB);
    expect(pgBeforeB).toContain(runA);
    expect(pgBeforeB).toContain(runC);

    // Missing cursor id should behave like memory (no cursor filter applied).
    const pgMissing = (await pgStore.listRuns({ before: `${tag}-missing`, limit: 10 })).map((r) => r.id);
    const memMissing = (await memStore.listRuns({ before: `${tag}-missing`, limit: 10 })).map((r) => r.id);
    expect(pgMissing).toEqual(memMissing);
  });

  it("applies before-cursor even when the cursor run does not match status filter", async () => {
    const tag = `parity-cursor-filter-${Date.now()}`;
    const runNew = `${tag}-new-running`;
    const runCursor = `${tag}-cursor-completed`;
    const runOld = `${tag}-old-running`;

    for (const store of [pgStore, memStore]) {
      await store.events.append(buildEventRecord(runNew, { type: "run.started", input: {} }, { agentName: AGENT, spanId: runNew, ts: "2026-03-01T00:00:00.000Z" }));
      await store.events.append(buildEventRecord(runCursor, { type: "run.started", input: {} }, { agentName: AGENT, spanId: runCursor, ts: "2026-02-01T00:00:00.000Z" }));
      await store.events.append(buildEventRecord(runCursor, { type: "run.completed", result: "ok" }, { agentName: AGENT, spanId: runCursor, ts: "2026-02-01T00:00:00.000Z" }));
      await store.events.append(buildEventRecord(runOld, { type: "run.started", input: {} }, { agentName: AGENT, spanId: runOld, ts: "2026-01-01T00:00:00.000Z" }));
    }

    const pgRunning = (await pgStore.listRuns({ status: "running", before: runCursor, limit: 10 })).map((r) => r.id);
    const memRunning = (await memStore.listRuns({ status: "running", before: runCursor, limit: 10 })).map((r) => r.id);
    expect(pgRunning).toEqual(memRunning);
    expect(pgRunning).toEqual([runOld]);
  });

  it("combines roots-only and before-cursor pagination identically", async () => {
    const tag = `parity-roots-cursor-${Date.now()}`;
    const workflow = `${AGENT}-roots-edge`;
    const rootNew = `${tag}-root-new`;
    const rootCursor = `${tag}-root-cursor`;
    const childOld = `${tag}-child-old`;
    const rootOld = `${tag}-root-old`;

    for (const store of [pgStore, memStore]) {
      await store.events.append(buildEventRecord(rootNew, { type: "run.started", input: {} }, { agentName: workflow, spanId: rootNew, ts: "2026-04-01T00:00:00.000Z" }));
      await store.events.append(buildEventRecord(rootCursor, { type: "run.started", input: {} }, { agentName: workflow, spanId: rootCursor, ts: "2026-03-01T00:00:00.000Z" }));
      await store.events.append(buildEventRecord(childOld, { type: "run.started", input: {} }, { agentName: workflow, spanId: childOld, parentSpanId: `${tag}-parent-span`, ts: "2026-02-01T00:00:00.000Z" }));
      await store.events.append(buildEventRecord(rootOld, { type: "run.started", input: {} }, { agentName: workflow, spanId: rootOld, ts: "2026-01-01T00:00:00.000Z" }));
    }

    const pgRoots = (await pgStore.listRuns({ workflow, roots: true, before: rootCursor, limit: 10 })).map((r) => r.id);
    const memRoots = (await memStore.listRuns({ workflow, roots: true, before: rootCursor, limit: 10 })).map((r) => r.id);
    expect(pgRoots).toEqual(memRoots);
    expect(pgRoots).toEqual([rootOld]);
  });
});

describeWithPg("channel conversation mapping parity", () => {
  let pgStore: PgRunStore;
  let memStore: ReturnType<typeof createMemoryStore>;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
    memStore = createMemoryStore();
  });
  afterAll(async () => { await pgStore.close(); });

  it("folds run.started channel binding + resolveConversation identically", async () => {
    const tag = `chan-${Date.now()}`;
    const threadId = `${tag}-t`;
    const convId = `C:${tag}`;
    const now = new Date().toISOString();

    for (const store of [pgStore, memStore]) {
      // Thread must exist before a run references it (pg FK).
      await store.createThread({ id: threadId, status: "active", createdAt: now, updatedAt: now });
      // First turn establishes the thread; it must complete before the second
      // starts (one-active-run-per-thread unique index in Postgres).
      await store.events.append(buildEventRecord(`${tag}-r1`, { type: "run.started", threadId, channel: "slack", externalConversationId: convId }, { agentName: AGENT, spanId: `${tag}-r1` }));
      await store.events.append(buildEventRecord(`${tag}-r1`, { type: "run.completed", result: "ok" }, { agentName: AGENT, spanId: `${tag}-r1` }));
      // Second turn reuses the thread; the last-run pointer advances.
      await store.events.append(buildEventRecord(`${tag}-r2`, { type: "run.started", threadId, channel: "slack", externalConversationId: convId }, { agentName: AGENT, spanId: `${tag}-r2` }));
    }

    // The run record carries the binding identically.
    expect((await pgStore.getRun(`${tag}-r1`))?.channel).toBe("slack");
    expect((await memStore.getRun(`${tag}-r1`))?.channel).toBe("slack");
    expect((await pgStore.getRun(`${tag}-r1`))?.externalConversationId).toBe(convId);
    expect((await memStore.getRun(`${tag}-r1`))?.externalConversationId).toBe(convId);

    // The mapping resolves identically: same thread, last run advanced to r2.
    const pgConv = await pgStore.resolveConversation("slack", convId);
    const memConv = await memStore.resolveConversation("slack", convId);
    expect(pgConv?.threadId).toBe(threadId);
    expect(memConv?.threadId).toBe(threadId);
    expect(pgConv?.lastRunId).toBe(`${tag}-r2`);
    expect(memConv?.lastRunId).toBe(`${tag}-r2`);

    // An unbound conversation → undefined in both.
    expect(await pgStore.resolveConversation("slack", `missing-${tag}`)).toBeUndefined();
    expect(await memStore.resolveConversation("slack", `missing-${tag}`)).toBeUndefined();
  });
});

describeWithPg("threads — metadata, run thread_id, and transcript parity", () => {
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

  it("persists thread metadata, sets run.thread_id, and folds the transcript identically", async () => {
    const threadId = `thread-${Date.now()}`;
    const runId = `${threadId}-run`;
    const now = new Date().toISOString();
    const thread = { id: threadId, userId: "u1", status: "active" as const, title: "t", createdAt: now, updatedAt: now };

    // Thread must exist before a run references it (FK in Postgres).
    await pgStore.createThread(thread);
    await memStore.createThread(thread);

    const events: RunEvent[] = [
      { type: "run.started", threadId, userId: "u1", input: "hi" },
      { type: "message.user", content: [{ type: "text", text: "hello there" }] },
      { type: "message.assistant", agentName: AGENT, content: [{ type: "text", text: "hi back" }] },
      { type: "run.completed", result: "done" },
    ];
    for (const e of events) {
      await emit(pgStore, runId, e);
      await emit(memStore, runId, e);
    }

    // Thread metadata round-trips.
    const pgThread = await pgStore.getThread(threadId);
    const memThread = await memStore.getThread(threadId);
    expect(pgThread?.userId).toBe(memThread?.userId);
    expect(pgThread?.title).toBe("t");

    // Run carries the thread id.
    expect((await pgStore.getRun(runId))?.threadId).toBe(threadId);
    expect((await memStore.getRun(runId))?.threadId).toBe(threadId);

    // listRuns filters by thread identically.
    expect((await pgStore.listRuns({ threadId })).map(r => r.id)).toEqual(
      (await memStore.listRuns({ threadId })).map(r => r.id),
    );

    // Transcript folds identically (flattened text, user+assistant only).
    const pgMsgs = await pgStore.getThreadMessages(threadId);
    const memMsgs = await memStore.getThreadMessages(threadId);
    expect(pgMsgs.map(m => [m.role, m.content])).toEqual([["user", "hello there"], ["assistant", "hi back"]]);
    expect(memMsgs.map(m => [m.role, m.content])).toEqual(pgMsgs.map(m => [m.role, m.content]));
  });

  it("enforces one active run per thread (unique index → 23505)", async () => {
    const threadId = `thread-busy-${Date.now()}`;
    const now = new Date().toISOString();
    await pgStore.createThread({ id: threadId, status: "active", createdAt: now, updatedAt: now });

    await emit(pgStore, `${threadId}-r1`, { type: "run.started", threadId, input: "a" });
    // Second active run for the same thread must violate the partial unique index.
    await expect(
      emit(pgStore, `${threadId}-r2`, { type: "run.started", threadId, input: "b" }),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describeWithPg("OAuth connections — encryption at rest + single-flight refresh", () => {
  let pgStore: PgRunStore;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
  });

  afterAll(async () => {
    await pgStore.close();
  });

  it("stores tokens encrypted at rest and decrypts on read", async () => {
    const now = new Date().toISOString();
    await pgStore.upsertConnection({
      id: "uA:github", userId: "uA", provider: "github",
      accessToken: "plain-access", refreshToken: "plain-refresh", scopes: ["repo"], createdAt: now, updatedAt: now,
    });

    // Read-through decrypts.
    const conn = await pgStore.getConnection("uA", "github");
    expect(conn?.accessToken).toBe("plain-access");
    expect(conn?.refreshToken).toBe("plain-refresh");

    // The raw column is ciphertext, not the plaintext.
    const raw = await (pgStore as unknown as { ["pool"]: import("pg").Pool }).pool.query<{ access_token: string }>(
      "SELECT access_token FROM oauth_connections WHERE user_id = 'uA' AND provider = 'github'",
    );
    expect(raw.rows[0].access_token).not.toContain("plain-access");
    expect(raw.rows[0].access_token.split(":")).toHaveLength(3); // iv:tag:ciphertext
  });

  it("coalesces concurrent refreshes via SELECT ... FOR UPDATE", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await pgStore.upsertConnection({
      id: "uB:github", userId: "uB", provider: "github",
      accessToken: "stale", refreshToken: "rt", expiresAt: past, scopes: [], createdAt: past, updatedAt: past,
    });

    let refreshCount = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        pgStore.refreshConnection("uB", "github",
          (c) => (c.expiresAt ? Date.now() >= Date.parse(c.expiresAt) - 60_000 : false),
          async () => { refreshCount += 1; await new Promise(r => setTimeout(r, 10)); return { accessToken: "fresh", refreshToken: "rt2", expiresAt: new Date(Date.now() + 3600_000).toISOString() }; },
        ),
      ),
    );

    expect(refreshCount).toBe(1);
    expect(results.every((r) => r?.accessToken === "fresh")).toBe(true);
  });
});

describeWithPg("ScheduleStore parity", () => {
  let pgStore: PgRunStore;
  let memStore: ReturnType<typeof createMemoryStore>;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
    memStore = createMemoryStore();
  });
  afterAll(async () => { await pgStore.close(); });

  it("CRUD + listEnabled fold identically across stores", async () => {
    const id = `sched-${Date.now()}`;
    const ts = new Date().toISOString();
    const rec = { id, workflow: "code-review", cronExpression: "*/5 * * * *", input: { x: 1 }, enabled: true, createdAt: ts, updatedAt: ts };

    for (const store of [pgStore, memStore]) {
      await store.createSchedule(rec);
    }
    expect((await pgStore.getSchedule(id))).toMatchObject({ id, workflow: "code-review", cronExpression: "*/5 * * * *", input: { x: 1 }, enabled: true });
    expect(await pgStore.getSchedule(id)).toEqual(await memStore.getSchedule(id));

    for (const store of [pgStore, memStore]) {
      // (lastRunId references runs(id), so only toggle enabled here.)
      await store.updateSchedule(id, { enabled: false, lastRunAt: ts });
    }
    const pgEnabled = (await pgStore.listEnabled()).map((s) => s.id);
    const memEnabled = (await memStore.listEnabled()).map((s) => s.id);
    expect(pgEnabled).not.toContain(id);
    expect(pgEnabled.includes(id)).toBe(memEnabled.includes(id));

    for (const store of [pgStore, memStore]) await store.deleteSchedule(id);
    expect(await pgStore.getSchedule(id)).toBeUndefined();
    expect(await memStore.getSchedule(id)).toBeUndefined();
  });
});

describeWithPg("retention cleanup parity", () => {
  let pgStore: PgRunStore;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
  });
  afterAll(async () => { await pgStore.close(); });

  it("trims event-detail + old summaries, preserves transcript/thread/active runs", async () => {
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    const tag = `ret-${Date.now()}`;
    const threadId = `${tag}-thread`;
    await pgStore.createThread({ id: threadId, status: "active", createdAt: daysAgo(100), updatedAt: daysAgo(100) });

    const seed = async (runId: string, ts: string, threaded = false) => {
      await pgStore.events.append(buildEventRecord(runId, { type: "run.started", input: "x", threadId: threaded ? threadId : undefined }, { agentName: AGENT, ts }));
      await pgStore.events.append(buildEventRecord(runId, { type: "message.user", content: [{ type: "text", text: "hello" }] }, { agentName: AGENT, ts }));
      await pgStore.events.append(buildEventRecord(runId, { type: "run.completed", result: "ok" }, { agentName: AGENT, ts }));
    };
    await seed(`${tag}-old`, daysAgo(100), true);   // detail+summary gone, transcript kept
    await seed(`${tag}-mid`, daysAgo(45));          // detail gone, summary kept
    await seed(`${tag}-fresh`, daysAgo(2));         // untouched
    // ancient active run — never trimmed
    await pgStore.events.append(buildEventRecord(`${tag}-active`, { type: "run.started", input: "x" }, { agentName: AGENT, ts: daysAgo(300) }));
    await pgStore.events.append(buildEventRecord(`${tag}-active`, { type: "run.paused", reason: "input" }, { agentName: AGENT, ts: daysAgo(300) }));

    const res = await pgStore.cleanup({ eventRetentionDays: 30, runRetentionDays: 90, now });
    expect(res.eventDetailTrimmed).toBeGreaterThanOrEqual(2);
    expect(res.runsDeleted).toBeGreaterThanOrEqual(1);

    expect(await pgStore.getRun(`${tag}-old`)).toBeUndefined();
    expect((await pgStore.getRun(`${tag}-mid`))?.status).toBe("completed");
    expect(await pgStore.events.read(`${tag}-mid`)).toHaveLength(0);
    expect((await pgStore.events.read(`${tag}-fresh`)).length).toBe(3);
    expect((await pgStore.getRun(`${tag}-active`))?.status).toBe("paused");

    // The human-facing transcript outlives the trimmed run detail.
    const transcript = await pgStore.getThreadMessages(threadId);
    expect(transcript.length).toBeGreaterThanOrEqual(1);
  });

  it("a schedule pinning a trimmed run survives (FK ON DELETE SET NULL)", async () => {
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    const tag = `sched-ret-${Date.now()}`;
    const runId = `${tag}-run`;
    // Old terminal run, then a schedule referencing it as last_run_id.
    await pgStore.events.append(buildEventRecord(runId, { type: "run.started", input: "x" }, { agentName: AGENT, ts: daysAgo(100) }));
    await pgStore.events.append(buildEventRecord(runId, { type: "run.completed", result: "ok" }, { agentName: AGENT, ts: daysAgo(100) }));
    await pgStore.createSchedule({
      id: tag, workflow: "code-review", cronExpression: "0 4 * * *", enabled: true,
      lastRunId: runId, lastRunAt: daysAgo(100), createdAt: daysAgo(100), updatedAt: daysAgo(100),
    });

    // Retention deletes the run summary; the FK must clear the pointer, not block.
    await pgStore.cleanup({ eventRetentionDays: 30, runRetentionDays: 90, now });

    expect(await pgStore.getRun(runId)).toBeUndefined();
    const sched = await pgStore.getSchedule(tag);
    expect(sched).toBeDefined();
    expect(sched?.lastRunId).toBeUndefined(); // SET NULL
    await pgStore.deleteSchedule(tag);
  });
});

describeWithPg("schedule tenant scoping parity", () => {
  let pgStore: PgRunStore;
  let memStore: ReturnType<typeof createMemoryStore>;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
    memStore = createMemoryStore();
  });
  afterAll(async () => { await pgStore.close(); });

  it("stamps + filters schedule userId identically (memory + pg)", async () => {
    const tag = `sched-tenant-${Date.now()}`;
    const now = new Date().toISOString();
    const mk = (suffix: string, userId?: string) => ({
      id: `${tag}-${suffix}`, workflow: "code-review", cronExpression: "* * * * *",
      enabled: true, userId, createdAt: now, updatedAt: now,
    });
    for (const store of [pgStore, memStore]) {
      await store.createSchedule(mk("a1", "alice"));
      await store.createSchedule(mk("a2", "alice"));
      await store.createSchedule(mk("b1", "bob"));
      await store.createSchedule(mk("none")); // unowned (operator/legacy)
    }
    const ids = (arr: { id: string }[]) => arr.map((s) => s.id).filter((id) => id.startsWith(tag)).sort();

    // The per-tenant filter returns identical sets across stores.
    const pgAlice = ids(await pgStore.listSchedules({ userId: "alice" }));
    expect(pgAlice).toEqual([`${tag}-a1`, `${tag}-a2`]);
    expect(ids(await memStore.listSchedules({ userId: "alice" }))).toEqual(pgAlice);

    // userId round-trips through getSchedule in both stores.
    expect((await pgStore.getSchedule(`${tag}-b1`))?.userId).toBe("bob");
    expect((await memStore.getSchedule(`${tag}-b1`))?.userId).toBe("bob");

    // An unowned schedule is excluded from a tenant filter but present unfiltered.
    expect(ids(await pgStore.listSchedules({ userId: "alice" }))).not.toContain(`${tag}-none`);
    expect(ids(await pgStore.listSchedules())).toContain(`${tag}-none`);
    expect(ids(await memStore.listSchedules())).toContain(`${tag}-none`);

    for (const store of [pgStore, memStore]) {
      for (const s of ["a1", "a2", "b1", "none"]) await store.deleteSchedule(`${tag}-${s}`);
    }
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

describeWithPg("EventLogStore.readThread parity (BUG-07)", () => {
  let pgStore: PgRunStore;
  let memStore: ReturnType<typeof createMemoryStore>;

  beforeAll(async () => {
    pgStore = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await pgStore.init();
    memStore = createMemoryStore();
  });
  afterAll(async () => { await pgStore.close(); });

  it("returns a thread's events across runs in canonical (ts, runId, seq) order", async () => {
    const tId = `parity-thread-${Date.now()}`;
    const runA = `${tId}-A`;
    const runB = `${tId}-B`;
    const runC = `${tId}-C`; // different thread — excluded
    // Sequential turns on one thread: turn A completes before turn B starts, so
    // the one-active-run-per-thread invariant (`idx_runs_thread_active`) holds.
    // readThread must still stitch events across both runs in canonical order.
    const script: Array<{ runId: string; event: RunEvent; ts: string; spanId?: string }> = [
      { runId: runA, event: { type: "run.started", input: {}, threadId: tId }, ts: "2026-02-01T00:00:01.000Z", spanId: runA },
      { runId: runA, event: { type: "run.completed", result: "ok" }, ts: "2026-02-01T00:00:02.000Z" },
      { runId: runB, event: { type: "run.started", input: {}, threadId: tId }, ts: "2026-02-01T00:00:03.000Z", spanId: runB },
      { runId: runC, event: { type: "run.started", input: {}, threadId: "parity-other" }, ts: "2026-02-01T00:00:00.500Z", spanId: runC },
    ];
    for (const store of [pgStore, memStore]) {
      for (const s of script) {
        await store.events.append(buildEventRecord(s.runId, s.event, { agentName: AGENT, spanId: s.spanId, ts: s.ts }));
      }
    }

    const ids = (recs: Awaited<ReturnType<typeof pgStore.events.readThread>>) => recs.map((e) => `${e.runId}:${e.seq}`);
    const pg = ids(await pgStore.events.readThread(tId));
    const mem = ids(await memStore.events.readThread(tId));
    expect(pg).toEqual([`${runA}:1`, `${runA}:2`, `${runB}:1`]);
    expect(mem).toEqual(pg);
  });
});
