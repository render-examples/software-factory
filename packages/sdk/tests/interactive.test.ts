import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-factory/store";
import type { AgentDefinition } from "@render-factory/engine";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { driveAgentTurn } from "../src/agents.js";

function assistantDef(): AgentDefinition {
  return {
    name: "assistant",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    systemPrompt: "chat",
    tools: [],
    interactive: true,
  };
}

/** Reply with the count of user turns the model can see — proves memory grows. */
function countingModel() {
  return mockModel((args) => {
    const users = args.messages.filter((m) => m.role === "user").length;
    return { content: [{ type: "text", text: `users=${users}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  });
}

/** Record an opening chat turn (run.started + message.user) as the gateway would. */
async function seedTurn(runtime: Awaited<ReturnType<typeof createTestRuntime>>, runId: string, threadId: string, text: string) {
  await runtime.store.events.append(
    buildEventRecord(runId, { type: "run.started", input: text, trigger: "thread_message", threadId }, { agentName: "assistant", spanId: runId }),
  );
  await runtime.store.events.append(
    buildEventRecord(runId, { type: "message.user", content: [{ type: "text", text }] }, { agentName: "assistant" }),
  );
}

describe("interactive agents — new run per turn, thread-scoped memory (D12)", () => {
  it("a turn completes (not paused) and later turns remember prior turns via the thread", async () => {
    const runtime = await createTestRuntime({ model: countingModel() });
    runtime.agentDefinitions.set("assistant", assistantDef());

    // Turn 1: its own run; completes (turn-end is NOT a pause under the two-lane model).
    await seedTurn(runtime, "chat-1", "t1", "hello");
    await driveAgentTurn(runtime, "chat-1");
    let run = await runtime.store.getRun("chat-1");
    expect(run?.status).toBe("completed");
    expect(run?.result).toBe("users=1");

    // Turn 2: a NEW run in the same thread; the model sees BOTH user turns (memory
    // comes from the thread transcript, not a parked run).
    await seedTurn(runtime, "chat-2", "t1", "again");
    await driveAgentTurn(runtime, "chat-2");
    run = await runtime.store.getRun("chat-2");
    expect(run?.status).toBe("completed");
    expect(run?.result).toBe("users=2");

    // The thread transcript folds both turns' assistant replies.
    const transcript = await runtime.threadStore.getThreadMessages("t1");
    expect(transcript.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["users=1", "users=2"]);
  });
});
