import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { deliverForRun } from "../src/channel-delivery.js";
import { runWorker } from "../src/worker.js";
import type { Channel } from "../src/channel.js";

/** A channel whose `deliver` records each outbound call (reply or input prompt). */
function recordingChannel() {
  const calls: Array<{ conversationId: string; text: string; data: unknown; input?: { kind: "approval" | "message"; inputRequestId: string } }> = [];
  const channel: Channel = {
    target: { agent: "a" },
    match: () => ({ event: "m" }),
    parse: async () => ({ conversationId: "x", input: "x" }),
    deliver: async (ctx) => {
      calls.push({
        conversationId: ctx.conversationId,
        text: ctx.message.text,
        data: ctx.message.data,
        input: ctx.input ? { kind: ctx.input.kind, inputRequestId: ctx.input.inputRequestId } : undefined,
      });
    },
  };
  return { channel, calls };
}

const idleModel = mockModel(() => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" }));

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("deliverForRun", () => {
  it("delivers a completed channel-bound run's reply and is idempotent", async () => {
    const { channel, calls } = recordingChannel();
    const runtime = await createTestRuntime({ model: idleModel, channels: new Map([["slack", channel]]) });
    const runId = "r1";
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "slack", externalConversationId: "C:1", threadId: "t1" }, { agentName: "a", spanId: runId }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "message.assistant", agentName: "a", content: [{ type: "text", text: "hi there" }] }, { agentName: "a" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.completed", result: "hi there" }, { agentName: "a", spanId: runId }));

    await deliverForRun(runtime, runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ conversationId: "C:1", text: "hi there" });

    // A `channel.delivered` marker was written…
    const events = await runtime.store.events.read(runId);
    expect(events.some((e) => e.type === "channel.delivered")).toBe(true);

    // …and it makes redelivery a no-op (effectively-once).
    await deliverForRun(runtime, runId);
    expect(calls).toHaveLength(1);
  });

  it("skips runs that are not channel-bound or not completed", async () => {
    const { channel, calls } = recordingChannel();
    const runtime = await createTestRuntime({ model: idleModel, channels: new Map([["slack", channel]]) });

    // Not channel-bound.
    await runtime.store.events.append(buildEventRecord("plain", { type: "run.started" }, { agentName: "a", spanId: "plain" }));
    await runtime.store.events.append(buildEventRecord("plain", { type: "run.completed" }, { agentName: "a", spanId: "plain" }));
    await deliverForRun(runtime, "plain");

    // Channel-bound but still running (not completed).
    await runtime.store.events.append(buildEventRecord("running", { type: "run.started", channel: "slack", externalConversationId: "C:2" }, { agentName: "a", spanId: "running" }));
    await deliverForRun(runtime, "running");

    expect(calls).toHaveLength(0);
  });

  it("skips an inbound-only channel (no deliver)", async () => {
    const runtime = await createTestRuntime({
      model: idleModel,
      channels: new Map<string, Channel>([["gh", { target: { workflow: "w" }, match: () => ({ event: "e" }), parse: async () => ({ conversationId: "c", input: {} }) }]]),
    });
    await runtime.store.events.append(buildEventRecord("inb", { type: "run.started", channel: "gh", externalConversationId: "pr-1" }, { agentName: "w", spanId: "inb" }));
    await runtime.store.events.append(buildEventRecord("inb", { type: "run.completed", result: "ok" }, { agentName: "w", spanId: "inb" }));
    // No throw; nothing to deliver.
    await deliverForRun(runtime, "inb");
    const events = await runtime.store.events.read("inb");
    expect(events.some((e) => e.type === "channel.delivered")).toBe(false);
  });

  it("delivers the pending input prompt when a run pauses (HITL), idempotent per input", async () => {
    const { channel, calls } = recordingChannel();
    const runtime = await createTestRuntime({ model: idleModel, channels: new Map([["slack", channel]]) });
    const runId = "hitl1";
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "slack", externalConversationId: "C:7", threadId: "t7" }, { agentName: "a", spanId: runId }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "input.requested", inputRequestId: "ir1", kind: "message", prompt: "What's your name?" }, { agentName: "a" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: ["ir1"] }, { agentName: "a", spanId: runId }));

    await deliverForRun(runtime, runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ conversationId: "C:7", text: "What's your name?", input: { kind: "message", inputRequestId: "ir1" } });

    // The marker records the delivered input; redelivering the same prompt is a no-op.
    const events = await runtime.store.events.read(runId);
    expect(events.some((e) => e.type === "channel.delivered")).toBe(true);
    await deliverForRun(runtime, runId);
    expect(calls).toHaveLength(1);
  });

  it("delivers the prompt on pause AND the reply on completion (distinct markers)", async () => {
    const { channel, calls } = recordingChannel();
    const runtime = await createTestRuntime({ model: idleModel, channels: new Map([["slack", channel]]) });
    const runId = "hitl2";
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "slack", externalConversationId: "C:8", threadId: "t8" }, { agentName: "a", spanId: runId }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "input.requested", inputRequestId: "ir2", kind: "message", prompt: "Your name?" }, { agentName: "a" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: ["ir2"] }, { agentName: "a", spanId: runId }));

    await deliverForRun(runtime, runId); // delivers the prompt

    // Human replies → input resolved → the run completes.
    await runtime.store.events.append(buildEventRecord(runId, { type: "input.provided", inputRequestId: "ir2", kind: "message", value: "Alice" }, { agentName: "a" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "message.assistant", agentName: "a", content: [{ type: "text", text: "Hi Alice" }] }, { agentName: "a" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.completed", result: "Hi Alice" }, { agentName: "a", spanId: runId }));

    await deliverForRun(runtime, runId); // delivers the reply

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ text: "Your name?", input: { kind: "message" } }); // prompt
    expect(calls[1]).toMatchObject({ text: "Hi Alice", input: undefined }); // reply
    // Both a prompt marker (with inputRequestId) and a reply marker (without) exist.
    const delivered = (await runtime.store.events.read(runId)).filter((e) => e.type === "channel.delivered");
    expect(delivered).toHaveLength(2);
  });

  it("formats an approval prompt with the tool name", async () => {
    const { channel, calls } = recordingChannel();
    const runtime = await createTestRuntime({ model: idleModel, channels: new Map([["slack", channel]]) });
    const runId = "hitl3";
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "slack", externalConversationId: "C:9", threadId: "t9" }, { agentName: "a", spanId: runId }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "input.requested", inputRequestId: "ir3", kind: "approval", toolName: "deploy", input: { env: "prod" } }, { agentName: "a" }));
    await runtime.store.events.append(buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: ["ir3"] }, { agentName: "a", spanId: runId }));

    await deliverForRun(runtime, runId);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("deploy");
    expect(calls[0].input).toMatchObject({ kind: "approval", inputRequestId: "ir3" });
    expect(calls[0].data).toMatchObject({ env: "prod" });
  });
});

describe("runWorker outbound delivery producer (queue mode)", () => {
  it("enqueues + drains a deliver job for a terminal channel-bound run", async () => {
    const { channel, calls } = recordingChannel();
    const runtime = await createTestRuntime({ executionMode: "queue", model: idleModel, channels: new Map([["slack", channel]]) });
    const worker = runWorker(runtime);
    try {
      // Let the producer's event tail subscribe before we append.
      await new Promise((r) => setTimeout(r, 50));
      const runId = "wr1";
      await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "slack", externalConversationId: "C:9" }, { agentName: "a", spanId: runId }));
      await runtime.store.events.append(buildEventRecord(runId, { type: "run.completed", result: "done" }, { agentName: "a", spanId: runId }));

      await waitFor(() => calls.length > 0, 2000);
      expect(calls[0]).toMatchObject({ conversationId: "C:9", text: "done" });
    } finally {
      await worker.stop();
    }
  });

  it("enqueues + drains a deliver job for a PAUSED channel-bound run (HITL prompt)", async () => {
    const { channel, calls } = recordingChannel();
    const runtime = await createTestRuntime({ executionMode: "queue", model: idleModel, channels: new Map([["slack", channel]]) });
    const worker = runWorker(runtime);
    try {
      await new Promise((r) => setTimeout(r, 50));
      const runId = "wr-paused";
      await runtime.store.events.append(buildEventRecord(runId, { type: "run.started", channel: "slack", externalConversationId: "C:P" }, { agentName: "a", spanId: runId }));
      await runtime.store.events.append(buildEventRecord(runId, { type: "input.requested", inputRequestId: "irq", kind: "message", prompt: "Need your input" }, { agentName: "a" }));
      await runtime.store.events.append(buildEventRecord(runId, { type: "run.paused", reason: "input", pendingInputIds: ["irq"] }, { agentName: "a", spanId: runId }));

      // The producer fires on run.paused too → the input prompt is delivered out.
      await waitFor(() => calls.length > 0, 2000);
      expect(calls[0]).toMatchObject({ conversationId: "C:P", text: "Need your input", input: { kind: "message", inputRequestId: "irq" } });
    } finally {
      await worker.stop();
    }
  });
});
