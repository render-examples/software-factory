import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { RunPaused, type AgentDefinition } from "@render-agents/engine";
import { createTestRuntime, mockModel } from "./testing.js";
import { resumeRun } from "./agents.js";

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

describe("interactive agents — multi-turn conversational memory (D-threads)", () => {
  it("parks on awaitInput after each turn and remembers prior turns on resume", async () => {
    const runtime = await createTestRuntime({ model: countingModel() });
    runtime.agentDefinitions.set("assistant", assistantDef());
    const runId = "chat-1";

    // Turn 1: the agent replies, then parks awaiting input (RunPaused).
    await expect(
      runtime.dispatcher!.dispatch("assistant", "hello", { runId, idempotencyKey: runId, threadId: "t1" }),
    ).rejects.toBeInstanceOf(RunPaused);

    let run = await runtime.store.getRun(runId);
    expect(run?.status).toBe("paused");
    let replies = (await runtime.store.getMessages(runId, "assistant")).filter((m) => m.role === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0].content[0]).toMatchObject({ type: "text", text: "users=1" });

    // The reply folded into the thread transcript.
    let transcript = await runtime.threadStore.getThreadMessages("t1");
    expect(transcript.map((m) => [m.role, m.content])).toEqual([["user", "hello"], ["assistant", "users=1"]]);

    // Turn 2: deliver the next user message and resume — the agent now sees BOTH
    // user turns (memory), replies, and parks again.
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "message.user", content: [{ type: "text", text: "again" }] }, { agentName: "assistant" }),
    );
    const res = await resumeRun(runId, runtime);
    expect(res.status).toBe("paused");

    replies = (await runtime.store.getMessages(runId, "assistant")).filter((m) => m.role === "assistant");
    expect(replies).toHaveLength(2);
    expect(replies[1].content[0]).toMatchObject({ type: "text", text: "users=2" }); // saw 2 user turns → memory

    // Run never completes (it's a conversation) — still paused awaiting input.
    run = await runtime.store.getRun(runId);
    expect(run?.status).toBe("paused");

    transcript = await runtime.threadStore.getThreadMessages("t1");
    expect(transcript.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["users=1", "users=2"]);
  });
});
