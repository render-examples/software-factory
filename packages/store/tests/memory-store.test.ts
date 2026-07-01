import { describe, it, expect } from "vitest";
import type { RunEvent, RunEventRecord } from "../src/events.js";
import {
  createMemoryStore,
  replay,
  buildEventRecord,
  EventRejectedError,
} from "../src/memory-store.js";
import { aggregateRunCost } from "../src/aggregate.js";

const AGENT = "judge";

/** Append a payload, letting the store assign seq; returns the appended record's seq. */
async function emit(
  store: ReturnType<typeof createMemoryStore>,
  runId: string,
  event: RunEvent,
  meta?: { agentName?: string; spanId?: string; parentSpanId?: string },
): Promise<void> {
  await store.events.append(buildEventRecord(runId, event, { agentName: AGENT, ...meta }));
}

describe("approvals read-surface", () => {
  it("getApprovals folds per-run; listApprovals spans runs with status filter", async () => {
    const store = createMemoryStore();
    // run A: one pending approval
    await emit(store, "A", { type: "run.started" });
    await emit(store, "A", { type: "approval.requested", approvalRequestId: "ap-A", toolName: "github", input: { x: 1 } });
    // run B: one approval, later resolved (approved)
    await emit(store, "B", { type: "run.started" });
    await emit(store, "B", { type: "approval.requested", approvalRequestId: "ap-B", toolName: "deploy", input: {} });
    await emit(store, "B", { type: "approval.resolved", approvalRequestId: "ap-B", approved: true, resolvedBy: "alice" });

    const aprA = await store.getApprovals("A");
    expect(aprA).toHaveLength(1);
    expect(aprA[0]).toMatchObject({ approvalRequestId: "ap-A", runId: "A", status: "pending", toolName: "github" });

    const pending = await store.listApprovals({ status: "pending" });
    expect(pending.map((a) => a.approvalRequestId)).toEqual(["ap-A"]);

    const approved = await store.listApprovals({ status: "approved" });
    expect(approved.map((a) => a.approvalRequestId)).toEqual(["ap-B"]);
    expect(approved[0].resolvedBy).toBe("alice");

    const all = await store.listApprovals();
    expect(all).toHaveLength(2);
  });
});

describe("reapStaleRuns (E6) — stranded Lane A roots", () => {
  const ts = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("fails a non-terminal run whose last event is older than the horizon", async () => {
    const store = createMemoryStore();
    // Stranded: run.started 20m ago, no further activity.
    await store.events.append(
      buildEventRecord("stranded", { type: "run.started", input: {}, spanKind: "workflow" }, { agentName: "wf", spanId: "stranded", ts: ts(20 * 60_000) }),
    );

    const res = await store.reapStaleRuns({ staleMs: 15 * 60_000 });

    expect(res.runIds).toEqual(["stranded"]);
    const run = await store.getRun("stranded");
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/no progress/);
  });

  it("leaves a run that is still progressing (recent event) untouched", async () => {
    const store = createMemoryStore();
    await store.events.append(
      buildEventRecord("live", { type: "run.started", input: {}, spanKind: "workflow" }, { agentName: "wf", spanId: "live", ts: ts(20 * 60_000) }),
    );
    // A fresh step.completed resets the liveness clock.
    await store.events.append(
      buildEventRecord("live", { type: "step.completed", name: "s", result: 1 }, { agentName: "wf", ts: ts(10_000) }),
    );

    const res = await store.reapStaleRuns({ staleMs: 15 * 60_000 });

    expect(res.reaped).toBe(0);
    expect((await store.getRun("live"))?.status).toBe("running");
  });

  it("never reaps paused or terminal runs", async () => {
    const store = createMemoryStore();
    await store.events.append(
      buildEventRecord("paused", { type: "run.started", input: {} }, { agentName: "wf", spanId: "paused", ts: ts(60 * 60_000) }),
    );
    await store.events.append(
      buildEventRecord("paused", { type: "run.paused", reason: "approval", pendingApprovalIds: ["a1"] }, { agentName: "wf", ts: ts(60 * 60_000) }),
    );
    await store.events.append(
      buildEventRecord("done", { type: "run.started", input: {} }, { agentName: "wf", spanId: "done", ts: ts(60 * 60_000) }),
    );
    await store.events.append(
      buildEventRecord("done", { type: "run.completed", result: "ok" }, { agentName: "wf", ts: ts(60 * 60_000) }),
    );

    const res = await store.reapStaleRuns({ staleMs: 15 * 60_000 });

    expect(res.reaped).toBe(0);
    expect((await store.getRun("paused"))?.status).toBe("paused");
    expect((await store.getRun("done"))?.status).toBe("completed");
  });

  it("is idempotent: a second pass reaps nothing (the run is already terminal)", async () => {
    const store = createMemoryStore();
    await store.events.append(
      buildEventRecord("stranded", { type: "run.started", input: {}, spanKind: "workflow" }, { agentName: "wf", spanId: "stranded", ts: ts(20 * 60_000) }),
    );

    const first = await store.reapStaleRuns({ staleMs: 15 * 60_000 });
    expect(first.reaped).toBe(1);

    // Re-running the reaper must not append a second run.failed (no double-fail).
    const second = await store.reapStaleRuns({ staleMs: 15 * 60_000 });
    expect(second.reaped).toBe(0);

    const types = (await store.events.read("stranded")).map((e) => e.type);
    expect(types.filter((t) => t === "run.failed")).toHaveLength(1);
  });

  it("respects the horizon boundary: just-inside is reaped, just-outside is spared", async () => {
    const store = createMemoryStore();
    const now = new Date();
    const staleMs = 15 * 60_000;
    // Pin `now` so the boundary is exact (no wall-clock drift between the two runs).
    await store.events.append(
      buildEventRecord("old", { type: "run.started", input: {}, spanKind: "workflow" }, { agentName: "wf", spanId: "old", ts: new Date(now.getTime() - staleMs - 1).toISOString() }),
    );
    await store.events.append(
      buildEventRecord("fresh", { type: "run.started", input: {}, spanKind: "workflow" }, { agentName: "wf", spanId: "fresh", ts: new Date(now.getTime() - staleMs + 1_000).toISOString() }),
    );

    const res = await store.reapStaleRuns({ staleMs, now });

    expect(res.runIds).toEqual(["old"]);
    expect((await store.getRun("old"))?.status).toBe("failed");
    expect((await store.getRun("fresh"))?.status).toBe("running");
  });
});

describe("events.readThread — thread-scoped catch-up (BUG-07)", () => {
  it("returns every run's events in canonical (ts, runId, seq) order, thread-scoped", async () => {
    const store = createMemoryStore();
    const tId = "thread-1";
    // Two runs in the thread, interleaved in time; each run's seq restarts at 1.
    await store.events.append(buildEventRecord("runA", { type: "run.started", input: {}, threadId: tId }, { agentName: AGENT, spanId: "runA", ts: "2026-01-01T00:00:01.000Z" }));
    await store.events.append(buildEventRecord("runB", { type: "run.started", input: {}, threadId: tId }, { agentName: AGENT, spanId: "runB", ts: "2026-01-01T00:00:02.000Z" }));
    await store.events.append(buildEventRecord("runA", { type: "run.completed", result: "ok" }, { agentName: AGENT, ts: "2026-01-01T00:00:03.000Z" }));
    // An event from a different thread must be excluded.
    await store.events.append(buildEventRecord("runC", { type: "run.started", input: {}, threadId: "other" }, { agentName: AGENT, spanId: "runC", ts: "2026-01-01T00:00:00.500Z" }));

    const events = await store.events.readThread(tId);
    expect(events.map((e) => `${e.runId}:${e.seq}`)).toEqual(["runA:1", "runB:1", "runA:2"]);
    expect(events.every((e) => e.runId !== "runC")).toBe(true);
  });

  it("returns an empty list for an unknown thread", async () => {
    const store = createMemoryStore();
    expect(await store.events.readThread("nope")).toEqual([]);
  });
});

describe("aggregateRunCost — cross-run subagent cost", () => {
  const llm = (cost: number): RunEvent => ({ type: "llm.call", model: "m", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: cost, stopReason: "end_turn", latencyMs: 1 });

  it("sums the run plus its subagent descendants (cycle-guarded)", async () => {
    const store = createMemoryStore();
    // parent (0.01) → child A (0.02) → grandchild (0.04); parent → child B (0.03)
    await store.events.append(buildEventRecord("parent", { type: "run.started" }, { agentName: "p", spanId: "p" }));
    await store.events.append(buildEventRecord("parent", llm(0.01), { agentName: "p", spanId: "l", parentSpanId: "p" }));
    await store.events.append(buildEventRecord("parent", { type: "subagent.spawned", agentName: "a", childRunId: "childA", toolCallId: "t1" }, { agentName: "p" }));
    await store.events.append(buildEventRecord("parent", { type: "subagent.spawned", agentName: "b", childRunId: "childB", toolCallId: "t2" }, { agentName: "p" }));

    await store.events.append(buildEventRecord("childA", { type: "run.started" }, { agentName: "a", spanId: "a" }));
    await store.events.append(buildEventRecord("childA", llm(0.02), { agentName: "a", spanId: "la", parentSpanId: "a" }));
    await store.events.append(buildEventRecord("childA", { type: "subagent.spawned", agentName: "g", childRunId: "grandchild", toolCallId: "t3" }, { agentName: "a" }));

    await store.events.append(buildEventRecord("childB", llm(0.03), { agentName: "b", spanId: "lb" }));
    await store.events.append(buildEventRecord("grandchild", llm(0.04), { agentName: "g", spanId: "lg" }));

    expect(await aggregateRunCost(store, "parent")).toBeCloseTo(0.10, 10);
    expect(await aggregateRunCost(store, "childA")).toBeCloseTo(0.06, 10);
  });
});

describe("retention cleanup", () => {
  /** Append a full terminal run with a fixed timestamp. */
  async function seedRun(store: ReturnType<typeof createMemoryStore>, runId: string, ts: string) {
    await store.events.append(buildEventRecord(runId, { type: "run.started", input: "x" }, { agentName: AGENT, ts }));
    await store.events.append(buildEventRecord(runId, { type: "message.user", content: [{ type: "text", text: "hi" }] }, { agentName: AGENT, ts }));
    await store.events.append(buildEventRecord(runId, { type: "run.completed", result: "ok" }, { agentName: AGENT, ts }));
  }

  it("trims event-detail at the event horizon, keeps summaries to the run horizon, guards active runs", async () => {
    const store = createMemoryStore();
    const now = new Date("2026-06-28T00:00:00Z");
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

    await seedRun(store, "old", daysAgo(100));     // > both horizons → detail + summary gone
    await seedRun(store, "mid", daysAgo(45));       // > event, < run → detail gone, summary kept
    await seedRun(store, "fresh", daysAgo(5));      // < both → untouched
    // An active (paused) run that is ancient must never be trimmed.
    await store.events.append(buildEventRecord("active", { type: "run.started", input: "x" }, { agentName: AGENT, ts: daysAgo(200) }));
    await store.events.append(buildEventRecord("active", { type: "run.paused", reason: "approval" }, { agentName: AGENT, ts: daysAgo(200) }));

    const res = await store.cleanup({ eventRetentionDays: 30, runRetentionDays: 90, now });
    expect(res).toEqual({ eventDetailTrimmed: 2, runsDeleted: 1 });

    // old: gone entirely.
    expect(await store.getRun("old")).toBeUndefined();
    // mid: summary kept, detail trimmed.
    expect((await store.getRun("mid"))?.status).toBe("completed");
    expect(await store.events.read("mid")).toHaveLength(0);
    expect(await store.getMessages("mid", AGENT)).toHaveLength(0);
    // fresh: intact.
    expect(await store.events.read("fresh")).toHaveLength(3);
    // active: untouched despite age.
    expect((await store.getRun("active"))?.status).toBe("paused");
    expect((await store.events.read("active")).length).toBeGreaterThan(0);
  });
});

describe("MemoryEventLogStore.append", () => {
  it("assigns a gap-free, monotonic seq per run", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "run.started" });
    await emit(store, "r1", { type: "run.completed", result: "ok" });
    await emit(store, "r2", { type: "run.started" });

    const r1 = await store.events.read("r1");
    expect(r1.map(e => e.seq)).toEqual([1, 2]);
    const r2 = await store.events.read("r2");
    expect(r2.map(e => e.seq)).toEqual([1]);
  });

  it("rejects out-of-order or duplicate seq", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "run.started" });
    const dup: RunEventRecord = buildEventRecord("r1", { type: "run.completed", result: "x" });
    dup.seq = 1; // already used
    await expect(store.events.append(dup)).rejects.toThrow(/seq out of order/);
  });

  it("read supports a fromSeq catch-up offset", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "run.started" });
    await emit(store, "r1", { type: "message.assistant", agentName: AGENT, content: [{ type: "text", text: "hi" }] });
    await emit(store, "r1", { type: "run.completed", result: "done" });

    const fromSeq2 = await store.events.read("r1", 2);
    expect(fromSeq2.map(e => e.seq)).toEqual([2, 3]);
  });
});

describe("projections", () => {
  it("folds run status and per-run cost from the log", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "run.started", input: { findings: [] } });
    await emit(store, "r1", {
      type: "llm.call",
      model: "claude-opus-4-6",
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.001,
      stopReason: "end_turn",
      latencyMs: 12,
    }, { spanId: "llm-1", parentSpanId: "agent-1" });
    await emit(store, "r1", {
      type: "llm.call",
      model: "claude-opus-4-6",
      usage: { inputTokens: 20, outputTokens: 8 },
      costUsd: 0.002,
      stopReason: "end_turn",
      latencyMs: 9,
    }, { spanId: "llm-2", parentSpanId: "agent-1" });
    await emit(store, "r1", { type: "run.completed", result: "verdict" });

    const run = await store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.workflow).toBe(AGENT);
    expect(run?.result).toBe("verdict");
    expect(run?.totalCostUsd).toBeCloseTo(0.003, 10);
  });

  it("folds model-visible message history (user + agent)", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "message.user", content: [{ type: "text", text: "review this" }] });
    await emit(store, "r1", { type: "message.assistant", agentName: AGENT, content: [{ type: "text", text: "ok" }] });
    await emit(store, "r1", { type: "message.assistant", agentName: "other", content: [{ type: "text", text: "noise" }] });

    const msgs = await store.getMessages("r1", AGENT);
    expect(msgs.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("assembles the span tree from span-producing events", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "run.started", input: "x" }, { spanId: "agent-1" });
    await emit(store, "r1", { type: "tool.called", toolCallId: "t1", name: "search", input: { q: "a" } }, { spanId: "tool-1", parentSpanId: "agent-1" });
    await emit(store, "r1", { type: "tool.result", toolCallId: "t1", name: "search", result: { content: "found" } }, { spanId: "tool-1", parentSpanId: "agent-1" });
    await emit(store, "r1", { type: "run.completed", result: "done" }, { spanId: "agent-1" });

    const spans = await store.listSpans("r1");
    const agent = spans.find(s => s.id === "agent-1");
    const tool = spans.find(s => s.id === "tool-1");
    expect(agent?.kind).toBe("agent");
    expect(agent?.status).toBe("ok");
    expect(tool?.kind).toBe("tool");
    expect(tool?.parentId).toBe("agent-1");
    expect(tool?.status).toBe("ok");
    expect(tool?.output).toBe("found");
  });

  it("folds the spec's span attributes (agent/llm/tool) and workflow root kind", async () => {
    const store = createMemoryStore();
    // Workflow root span.
    await emit(store, "wf", { type: "run.started", input: {}, trigger: "api", spanKind: "workflow" }, { spanId: "wf" });
    await emit(store, "wf", { type: "run.completed", result: "ok" }, { spanId: "wf" });
    const wfRoot = (await store.listSpans("wf")).find(s => s.id === "wf");
    expect(wfRoot?.kind).toBe("workflow");
    expect(wfRoot?.attributes).toMatchObject({ workflow: AGENT, trigger: "api" });

    // Agent run: attributes accumulate from llm.call; tool span gets latency/ok.
    await emit(store, "ar", { type: "run.started", input: "x", agentVersion: "v2", model: "claude-sonnet-4-6" }, { spanId: "a1" });
    await emit(store, "ar", { type: "llm.call", model: "claude-sonnet-4-6", usage: { inputTokens: 7, outputTokens: 2 }, costUsd: 0.01, stopReason: "tool_use", latencyMs: 11 }, { spanId: "l1", parentSpanId: "a1" });
    await emit(store, "ar", { type: "tool.called", toolCallId: "t1", name: "search", input: {} }, { spanId: "to1", parentSpanId: "a1" });
    await emit(store, "ar", { type: "tool.result", toolCallId: "t1", name: "search", result: { content: "ok" } }, { spanId: "to1", parentSpanId: "a1" });
    await emit(store, "ar", { type: "run.completed", result: "done" }, { spanId: "a1" });

    const spans = await store.listSpans("ar");
    expect(spans.find(s => s.id === "a1")?.attributes).toMatchObject({
      agentName: AGENT, agentVersion: "v2", model: "claude-sonnet-4-6",
      iterations: 1, usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(spans.find(s => s.id === "l1")?.attributes).toMatchObject({
      "gen_ai.request.model": "claude-sonnet-4-6", "gen_ai.usage.output_tokens": 2,
    });
    const toolSpan = spans.find(s => s.id === "to1");
    expect(toolSpan?.attributes).toMatchObject({ toolName: "search", ok: true });
    expect(typeof (toolSpan?.attributes as { latencyMs?: number }).latencyMs).toBe("number");
  });

  it("idempotency index records canonical tool.result, not provider placeholders", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "tool.called", toolCallId: "t1", name: "search", input: {} }, { spanId: "tool-1" });
    await emit(store, "r1", { type: "tool.result", toolCallId: "t1", name: "search", result: { content: "real" } }, { spanId: "tool-1" });
    // A provider transport placeholder rides inside a message.tool content block — never a tool.result event.
    await emit(store, "r1", {
      type: "message.tool",
      agentName: AGENT,
      content: [{ type: "tool_result", toolUseId: "t2", content: "placeholder" }],
    });

    expect(await store.getToolResult("r1", "t1")).toEqual({ content: "real" });
    expect(await store.getToolResult("r1", "t2")).toBeUndefined();
  });

  it("memoizes step results by (runId, name)", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "step.started", name: "prepare" }, { spanId: "step-1" });
    await emit(store, "r1", { type: "step.completed", name: "prepare", result: { diff: 3 } }, { spanId: "step-1" });
    expect(await store.getStepResult("r1", "prepare")).toEqual({ value: { diff: 3 } });
    expect(await store.getStepResult("r1", "missing")).toBeUndefined();
  });
});

describe("parent linkage (cross-run children)", () => {
  it("captures parentSpanId, hides children from roots, and lists them per parent", async () => {
    const store = createMemoryStore();
    // Parent workflow run with a tool span (subagent attaches here).
    await emit(store, "p", { type: "run.started", input: {}, spanKind: "workflow" }, { agentName: "wf", spanId: "p" });
    await emit(store, "p", { type: "tool.called", toolCallId: "t1", name: "spawn", input: {} }, { agentName: "wf", spanId: "tool-1", parentSpanId: "p" });

    // Workflow fan-out child: parentSpanId === parentRunId (root span id).
    await emit(store, "childWF", { type: "run.started", input: {} }, { agentName: "security", spanId: "childWF", parentSpanId: "p" });
    // Subagent child: parentSpanId is a tool span within the parent.
    await emit(store, "childSub", { type: "run.started", input: {} }, { agentName: "helper", spanId: "childSub", parentSpanId: "tool-1" });
    // An unrelated top-level root.
    await emit(store, "other", { type: "run.started", input: {} }, { agentName: "wf2", spanId: "other" });

    expect((await store.getRun("childWF"))?.parentSpanId).toBe("p");
    expect((await store.getRun("p"))?.parentSpanId).toBeUndefined();

    // roots filter drops both children.
    const roots = await store.listRuns({ roots: true });
    expect(roots.map((r) => r.id).sort()).toEqual(["other", "p"]);
    // Without the filter, everything is listed.
    expect((await store.listRuns()).map((r) => r.id).sort()).toEqual(["childSub", "childWF", "other", "p"]);

    // Children of p include both the fan-out and subagent children, oldest first.
    const kids = await store.listChildRuns("p");
    expect(kids.map((r) => r.id)).toEqual(["childWF", "childSub"]);
    // A run with no children returns nothing.
    expect(await store.listChildRuns("other")).toEqual([]);
  });
});

describe("replay", () => {
  it("rebuilds byte-identical projections purely from read()", async () => {
    const store = createMemoryStore();
    await emit(store, "r1", { type: "run.started", input: "x" }, { spanId: "agent-1" });
    await emit(store, "r1", { type: "message.user", content: [{ type: "text", text: "hi" }] });
    await emit(store, "r1", {
      type: "llm.call",
      model: "claude-opus-4-6",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0.5,
      stopReason: "tool_use",
      latencyMs: 5,
    }, { spanId: "llm-1", parentSpanId: "agent-1" });
    await emit(store, "r1", { type: "tool.called", toolCallId: "t1", name: "s", input: {} }, { spanId: "tool-1", parentSpanId: "agent-1" });
    await emit(store, "r1", { type: "tool.result", toolCallId: "t1", name: "s", result: { content: "r" } }, { spanId: "tool-1", parentSpanId: "agent-1" });
    await emit(store, "r1", { type: "run.completed", result: "done" }, { spanId: "agent-1" });

    const replayed = await replay(store.events, "r1");
    expect(replayed).toEqual(store.snapshot("r1"));
  });
});

describe("EventInterceptor seam", () => {
  it("rewrites events when the interceptor returns a replacement", async () => {
    const store = createMemoryStore();
    store.setInterceptor({
      async intercept(event) {
        if (event.type === "message.assistant") {
          return { action: "continue", event: { ...event, content: [{ type: "text", text: "[redacted]" }] } };
        }
        return { action: "continue" };
      },
    });
    await emit(store, "r1", { type: "message.assistant", agentName: AGENT, content: [{ type: "text", text: "secret" }] });
    const msgs = await store.getMessages("r1", AGENT);
    expect(msgs[0].content).toEqual([{ type: "text", text: "[redacted]" }]);
  });

  it("rejects (vetoes) an event without persisting or folding it", async () => {
    const store = createMemoryStore();
    store.setInterceptor({
      async intercept(event) {
        if (event.type === "tool.called") return { action: "reject", reason: "blocked by policy" };
        return { action: "continue" };
      },
    });
    await emit(store, "r1", { type: "run.started" }, { spanId: "agent-1" });
    await expect(
      emit(store, "r1", { type: "tool.called", toolCallId: "t1", name: "danger", input: {} }, { spanId: "tool-1" }),
    ).rejects.toBeInstanceOf(EventRejectedError);
    expect((await store.events.read("r1")).map(e => e.type)).toEqual(["run.started"]);
  });
});

describe("tail", () => {
  it("delivers appended events to a live subscriber", async () => {
    const store = createMemoryStore();
    const controller = new AbortController();
    const received: string[] = [];
    const iter = store.events.tail({ runId: "r1" }, controller.signal);

    const consumer = (async () => {
      for await (const rec of iter) {
        received.push(rec.type);
        if (received.length === 2) {
          controller.abort();
          break;
        }
      }
    })();

    await emit(store, "r1", { type: "run.started" });
    await emit(store, "other", { type: "run.started" }); // filtered out
    await emit(store, "r1", { type: "run.completed", result: "done" });
    await consumer;

    expect(received).toEqual(["run.started", "run.completed"]);
  });
});

describe("ScheduleStore (memory)", () => {
  const rec = (id: string, over: Partial<import("../src/schedule-store.js").ScheduleRecord> = {}) => ({
    id,
    workflow: "code-review",
    cronExpression: "*/5 * * * *",
    enabled: true,
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    ...over,
  });

  it("creates, reads, updates, lists, and deletes schedules", async () => {
    const store = createMemoryStore();
    await store.createSchedule(rec("s1"));
    await store.createSchedule(rec("s2", { enabled: false }));

    expect((await store.getSchedule("s1"))?.workflow).toBe("code-review");
    expect(await store.listSchedules()).toHaveLength(2);
    expect((await store.listEnabled()).map((s) => s.id)).toEqual(["s1"]);

    await store.updateSchedule("s1", { enabled: false, lastRunId: "run-1", lastRunAt: "2026-06-29T00:05:00.000Z" });
    const updated = await store.getSchedule("s1");
    expect(updated?.enabled).toBe(false);
    expect(updated?.lastRunId).toBe("run-1");
    expect(await store.listEnabled()).toHaveLength(0);

    await store.deleteSchedule("s1");
    expect(await store.getSchedule("s1")).toBeUndefined();
    expect(await store.listSchedules()).toHaveLength(1);
  });

  it("never mutates id/createdAt on update", async () => {
    const store = createMemoryStore();
    await store.createSchedule(rec("s1"));
    await store.updateSchedule("s1", { id: "hacked", createdAt: "1999-01-01T00:00:00.000Z", enabled: false } as never);
    const s = await store.getSchedule("s1");
    expect(s?.id).toBe("s1");
    expect(s?.createdAt).toBe("2026-06-29T00:00:00.000Z");
  });
});
