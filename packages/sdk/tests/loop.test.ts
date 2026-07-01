import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadAgents } from "../src/index.js";
import { mockModel, createTestRuntime } from "../src/testing.js";

const VALID_PROJECT = join(import.meta.dirname, "__fixtures__/valid-project");

describe("Wave 0 walking skeleton (Authoring → Testing example)", () => {
  it("runs the real loop against a mock model and resolves with text, fully event-sourced", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: '{"decision":"approve"}' }],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    }));
    const runtime = await createTestRuntime({ model });
    const agents = await loadAgents(VALID_PROJECT, runtime);

    const out = await agents.get("judge").run<{ decision: string }>({ findings: [] });
    expect(out.text).toBe('{"decision":"approve"}');

    // The run is event-sourced: exactly one completed run exists in the store.
    const runs = await runtime.store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].workflow).toBe("judge");
    expect(runs[0].totalCostUsd).toBeGreaterThan(0);
  });

  it("agent.task() with no dispatcher produces identical output to agent.run()", async () => {
    const model = mockModel(() => ({
      content: [{ type: "text", text: "verdict" }],
      usage: { inputTokens: 3, outputTokens: 2 },
      stopReason: "end_turn",
    }));
    const runtime = await createTestRuntime({ model });
    const agents = await loadAgents(VALID_PROJECT, runtime);

    const viaRun = await agents.get("security").run("review");
    const viaTask = await agents.get("security").task("review");
    expect(viaTask.text).toBe(viaRun.text);
    expect(viaTask.usage).toEqual(viaRun.usage);
  });

  it("loadAgents binds agents to the default runtime when none is provided", async () => {
    const agents = await loadAgents(VALID_PROJECT);
    expect(agents.has("judge")).toBe(true);
    // Bound, but the default runtime has no configured model — running surfaces a clear error.
    await expect(agents.get("judge").run("x")).rejects.toThrow(/No model configured/);
  });
});
