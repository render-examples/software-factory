import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PgRunStore, PgCancelStore, buildEventRecord } from "@render-agents/store";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { defineTool } from "../src/authoring.js";
import type { AgentDefinition } from "@render-agents/engine";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPg = TEST_DATABASE_URL ? describe : describe.skip;

// E3 (cross-"process"): a child run executing in runtime A must observe a cancel
// that was requested by a *different* store instance (runtime B) over the shared
// Postgres DB. This proves cancellation travels through `runs.status` (the
// sanctioned control signal), not in-process memory — i.e. the gateway can
// cancel a root whose child is mid-flight inside a separate worker process.
describeWithPg("cross-process cancel cascade over Postgres (E3)", () => {
  it("a cancel from another store instance stops a mid-flight child sharing the DB", async () => {
    const root = `root-${randomUUID()}`;
    const child = `child-${randomUUID()}`;
    // `tool_calls.id` is globally unique in Postgres — use a fresh id so reruns
    // against the shared dev DB never collide with a prior run's tool call.
    const toolCallId = `tc-${randomUUID()}`;

    // Interleaving deferreds: the tool signals when running, then blocks so the
    // "other process" can request the cancel before the child's next turn.
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => { signalStarted = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let released = false;

    const gateTool = defineTool({
      name: "gate",
      description: "blocks until released",
      inputSchema: {},
      async invoke() {
        if (released) return "done"; // defensive: only block on the first turn
        released = true;
        signalStarted();
        await gate;
        return "done";
      },
    });

    // Runtime A: runs the child. Its cancel store is backed by Postgres.
    const storeA = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await storeA.init();
    // Runtime B: a *separate* store + cancel store over the same DB (the canceller).
    const storeB = new PgRunStore({ connectionString: TEST_DATABASE_URL! });
    await storeB.init();
    const cancelB = new PgCancelStore(storeB.pool);

    try {
      const runtimeA = await createTestRuntime({
        store: storeA,
        cancelStore: new PgCancelStore(storeA.pool),
        model: mockModel(() => ({ content: [{ type: "tool_use", id: toolCallId, name: "gate", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" })),
        toolSources: new Map([["gate", gateTool]]),
      });
      const def: AgentDefinition = {
        name: "worker", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "x", tools: ["gate"],
      };
      runtimeA.agentDefinitions.set("worker", def);

      // Seed the root run so requestCancel(root) has a row to flip to 'cancelled'
      // and the child's scope check (`isCancelled(root)`) can read it.
      await storeA.events.append(
        buildEventRecord(root, { type: "run.started", input: {}, spanKind: "workflow" }, { agentName: "wf", spanId: root }),
      );

      // Dispatch the child scoped to the root (as a workflow's agent.task would).
      const childPromise = runtimeA.dispatcher!.dispatch("worker", "go", {
        runId: child,
        parentSpanId: root,
        idempotencyKey: child,
        cancelScopeId: root,
      });

      await started;                  // child is mid-tool in runtime A
      await cancelB.requestCancel(root); // "other process" cancels the root
      release();
      await childPromise;

      // The child observed the cross-store cancel and self-cancelled.
      expect((await storeA.getRun(child))?.status).toBe("cancelled");
      const types = (await storeA.events.read(child)).map((e) => e.type);
      expect(types.filter((t) => t === "run.completed" || t === "run.failed" || t === "run.cancelled")).toEqual(["run.cancelled"]);
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });
});
