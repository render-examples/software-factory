import { describe, it, expect } from "vitest";
import type { RunEvent, RunEventRecord } from "./events.js";
import {
  createMemoryStore,
  replay,
  buildEventRecord,
  EventRejectedError,
} from "./memory-store.js";

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
