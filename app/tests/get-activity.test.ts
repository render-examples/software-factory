import { describe, expect, it } from "vitest";
import type { ToolContext } from "@render-factory/sdk";
import { createTestRuntime } from "@render-factory/sdk/testing";
import { buildEventRecord } from "@render-factory/store";
import getActivityToolSource, { setRuntime as bindActivityRuntime } from "../tools/get_activity/index.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function toolContext(runId: string): ToolContext {
  return {
    runId,
    env: () => undefined,
    signal: new AbortController().signal,
    logger,
    connection: async () => undefined,
    fetch,
  };
}

async function activityTool() {
  const resolved = await getActivityToolSource.resolve(undefined as never);
  return resolved.tools[0]!;
}

describe("get_activity", () => {
  it("returns the latest bounded run window and supports older-page cursors", async () => {
    const runtime = await createTestRuntime();
    bindActivityRuntime(runtime);
    const now = "2026-01-01T00:00:00.000Z";
    await runtime.threadStore.createThread({
      id: "thread-1",
      userId: "user-1",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await runtime.store.events.append(
      buildEventRecord(
        "caller",
        { type: "run.started", threadId: "thread-1", userId: "user-1" },
        { agentName: "assistant", spanId: "caller", ts: now },
      ),
    );
    await runtime.store.events.append(
      buildEventRecord(
        "target",
        { type: "run.started", threadId: "thread-1", userId: "user-1", spanKind: "workflow" },
        { agentName: "spec-to-pr", spanId: "target", ts: "2026-01-01T00:00:01.000Z" },
      ),
    );
    await runtime.store.events.append(
      buildEventRecord(
        "target",
        { type: "step.started", name: "research" },
        { agentName: "spec-to-pr", ts: "2026-01-01T00:00:02.000Z" },
      ),
    );
    await runtime.store.events.append(
      buildEventRecord(
        "target",
        {
          type: "message.assistant",
          agentName: "researcher",
          content: [{ type: "text", text: "Research complete" }],
        },
        { agentName: "researcher", ts: "2026-01-01T00:00:03.000Z" },
      ),
    );
    await runtime.store.events.append(
      buildEventRecord(
        "target",
        { type: "run.completed", result: { status: "done" } },
        { agentName: "spec-to-pr", ts: "2026-01-01T00:00:04.000Z" },
      ),
    );

    const tool = await activityTool();
    const latest = await tool.invoke(
      { scope: "run", id: "target", limit: 2 },
      toolContext("caller"),
    );
    const latestBody = JSON.parse(latest.content);
    expect(latestBody.run).toMatchObject({ id: "target", status: "completed" });
    expect(latestBody.entries.map((entry: { seq: number }) => entry.seq)).toEqual([3, 4]);
    expect(latestBody.page).toMatchObject({
      has_more: true,
      next_before_seq: 3,
    });

    const older = await tool.invoke(
      { scope: "run", id: "target", limit: 2, before_seq: 3 },
      toolContext("caller"),
    );
    const olderBody = JSON.parse(older.content);
    expect(olderBody.entries.map((entry: { seq: number }) => entry.seq)).toEqual([1, 2]);
  });

  it("reads recent thread items and hides foreign targets", async () => {
    const runtime = await createTestRuntime();
    bindActivityRuntime(runtime);
    const now = "2026-01-01T00:00:00.000Z";
    for (const [id, userId] of [["own-thread", "user-1"], ["foreign-thread", "user-2"]] as const) {
      await runtime.threadStore.createThread({
        id,
        userId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    await runtime.store.events.append(
      buildEventRecord(
        "caller",
        { type: "run.started", threadId: "own-thread", userId: "user-1" },
        { agentName: "assistant", spanId: "caller", ts: now },
      ),
    );
    await runtime.store.events.append(
      buildEventRecord(
        "foreign-run",
        { type: "run.started", threadId: "foreign-thread", userId: "user-2" },
        { agentName: "assistant", spanId: "foreign-run", ts: now },
      ),
    );
    await runtime.itemStore.appendItem({
      threadId: "own-thread",
      kind: "message",
      role: "user",
      content: "first",
    });
    await runtime.itemStore.appendItem({
      threadId: "own-thread",
      kind: "status",
      role: "system",
      content: "working",
    });
    await runtime.itemStore.appendItem({
      threadId: "own-thread",
      kind: "result",
      role: "system",
      content: "done",
    });

    const tool = await activityTool();
    const own = await tool.invoke(
      { scope: "thread", id: "own-thread", limit: 2 },
      toolContext("caller"),
    );
    const ownBody = JSON.parse(own.content);
    expect(ownBody.entries.map((entry: { seq: number }) => entry.seq)).toEqual([2, 3]);

    const foreign = await tool.invoke(
      { scope: "run", id: "foreign-run" },
      toolContext("caller"),
    );
    expect(foreign).toMatchObject({
      isError: true,
      content: "get_activity: target not found or inaccessible",
    });
  });
});
