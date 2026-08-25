import { describe, it, expect } from "vitest";
import { join } from "node:path";
import type { CompleteArgs, CompleteResult } from "@render-factory/engine";
import { loadAgents } from "../src/index.js";
import { mockModel, createTestRuntime } from "../src/testing.js";

const VALID_PROJECT = join(import.meta.dirname, "__fixtures__/valid-project");

describe("subagent delegation (M2)", () => {
  it("runs a child agent via subagents__<name> and records subagent.spawned", async () => {
    let judgeCalls = 0;
    const model = mockModel((args: CompleteArgs): CompleteResult => {
      const isJudge = args.tools.some((t) => t.name.startsWith("subagents__"));
      if (isJudge) {
        judgeCalls += 1;
        if (judgeCalls === 1) {
          return {
            content: [{ type: "tool_use", id: "tc1", name: "subagents__security", input: { input: "review" } }],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
          };
        }
        // judge declares an output schema, so the final turn must be conforming JSON.
        return { content: [{ type: "text", text: '{"decision":"approve"}' }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
      return { content: [{ type: "text", text: "security says ok" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    });

    const runtime = await createTestRuntime({ model });
    const agents = await loadAgents(VALID_PROJECT, runtime);

    const out = await agents.get("judge").run<{ decision: string }>("check this");
    expect(out.data).toEqual({ decision: "approve" });

    const runs = await runtime.store.listRuns();
    const judgeRun = runs.find((r) => r.workflow === "judge");
    const securityRun = runs.find((r) => r.workflow === "security");
    expect(judgeRun).toBeDefined();
    expect(securityRun?.status).toBe("completed");

    const judgeEvents = (await runtime.store.events.read(judgeRun!.id)).map((e) => e.type);
    expect(judgeEvents).toContain("subagent.spawned");
  });
});

describe("task dispatch idempotency (M4)", () => {
  it("memoizes a completed task and does not re-run on identical re-dispatch", async () => {
    let securityCalls = 0;
    const model = mockModel((): CompleteResult => {
      securityCalls += 1;
      return { content: [{ type: "text", text: "reviewed" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    });
    const runtime = await createTestRuntime({ model });
    const agents = await loadAgents(VALID_PROJECT, runtime);
    const security = agents.get("security");

    const first = await security.task("x", { runId: "fixed-run-1" });
    const second = await security.task("x", { runId: "fixed-run-1" });

    expect(securityCalls).toBe(1);
    expect(second).toEqual(first);
  });
});
