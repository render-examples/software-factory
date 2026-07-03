import { describe, it, expect } from "vitest";
import { createMemoryStore, buildEventRecord } from "../src/index.js";

describe("channel conversation mapping (P2)", () => {
  it("folds the run.started channel binding onto the run + resolveConversation", async () => {
    const store = createMemoryStore();
    await store.init();
    await store.events.append(
      buildEventRecord(
        "r1",
        { type: "run.started", input: "hi", threadId: "t1", channel: "slack", externalConversationId: "C:123" },
        { agentName: "assistant", spanId: "r1" },
      ),
    );

    const run = await store.getRun("r1");
    expect(run?.channel).toBe("slack");
    expect(run?.externalConversationId).toBe("C:123");

    const conv = await store.resolveConversation("slack", "C:123");
    expect(conv?.threadId).toBe("t1");
    expect(conv?.lastRunId).toBe("r1");

    // Unbound conversation → undefined.
    expect(await store.resolveConversation("slack", "nope")).toBeUndefined();
    // A run with no channel binding does not create a mapping.
    await store.events.append(buildEventRecord("r0", { type: "run.started", input: "x" }, { agentName: "a", spanId: "r0" }));
    expect((await store.getRun("r0"))?.channel).toBeUndefined();
  });

  it("keeps the thread stable across turns and advances lastRunId", async () => {
    const store = createMemoryStore();
    await store.init();
    // First turn on the conversation establishes the thread.
    await store.events.append(buildEventRecord("r1", { type: "run.started", threadId: "t1", channel: "slack", externalConversationId: "C:1" }, { agentName: "a", spanId: "r1" }));
    await store.events.append(buildEventRecord("r1", { type: "run.completed", result: "ok" }, { agentName: "a", spanId: "r1" }));
    // Second turn on the same conversation reuses the thread; last run advances.
    await store.events.append(buildEventRecord("r2", { type: "run.started", threadId: "t1", channel: "slack", externalConversationId: "C:1" }, { agentName: "a", spanId: "r2" }));

    const conv = await store.resolveConversation("slack", "C:1");
    expect(conv?.threadId).toBe("t1");
    expect(conv?.lastRunId).toBe("r2");
  });
});
