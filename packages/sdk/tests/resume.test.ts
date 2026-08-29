import { describe, it, expect, afterEach } from "vitest";
import { buildEventRecord, idempotencyKey } from "@render-factory/store";
import { RunPaused, type AgentDefinition, type CompleteResult } from "@render-factory/engine";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { resumeRun } from "../src/agents.js";
import { defineTool } from "@render-factory/engine";

const KEY = "RENDER_FACTORY_STRICT_APPROVAL";

afterEach(() => {
  delete process.env[KEY];
});

function deployerDef(): AgentDefinition {
  return {
    name: "deployer",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    systemPrompt: "deploy things",
    tools: ["deploy"],
    permissions: { requireApproval: ["deploy"] },
  };
}

/** Model: ask to call the gated tool, then (after the tool result) finish. */
function deployModel() {
  const responses: CompleteResult[] = [
    { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
    { content: [{ type: "text", text: "shipped" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
  ];
  let i = 0;
  return mockModel(() => responses[Math.min(i++, responses.length - 1)]);
}

describe("resumeRun — HITL resume driver (M1)", () => {
  it("re-drives a paused run to completion once the approval is resolved", async () => {
    process.env[KEY] = "1";
    let invoked = 0;
    const toolSources = new Map([
      ["deploy", defineTool({ name: "deploy", description: "ship it", inputSchema: {}, async invoke() { invoked += 1; return "deployed"; } })],
    ]);
    const runtime = await createTestRuntime({ model: deployModel(), toolSources });
    runtime.agentDefinitions.set("deployer", deployerDef());

    const runId = "run-resume-1";
    // First dispatch pauses awaiting approval (the runner throws RunPaused).
    await expect(
      runtime.dispatcher!.dispatch("deployer", "go", { runId, idempotencyKey: runId }),
    ).rejects.toBeInstanceOf(RunPaused);

    expect(invoked).toBe(0);
    let run = await runtime.store.getRun(runId);
    expect(run?.status).toBe("paused");
    const pending = await runtime.store.listInputs({ status: "pending", kind: "approval" });
    expect(pending).toHaveLength(1);
    expect(pending[0].runId).toBe(runId);

    // Operator resolves the approval out-of-band (as the gateway would).
    const approvalId = idempotencyKey(runId, "input:approval:tc1");
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "input.provided", inputRequestId: approvalId, kind: "approval", approved: true }, { agentName: "deployer" }),
    );

    // Resume drives the loop from the logged state.
    const result = await resumeRun(runId, runtime);
    expect(result.status).toBe("completed");
    expect((result as { text: string }).text).toBe("shipped");
    expect(invoked).toBe(1);

    run = await runtime.store.getRun(runId);
    expect(run?.status).toBe("completed");

    // No duplicated opening events on resume.
    const types = (await runtime.store.events.read(runId)).map((e) => e.type);
    expect(types.filter((t) => t === "run.started")).toHaveLength(1);
    expect(types.filter((t) => t === "message.user")).toHaveLength(1);
    expect(types).toContain("tool.result");
  });

  it("throws clearly for unknown or non-resumable runs", async () => {
    const runtime = await createTestRuntime({ model: deployModel() });
    runtime.agentDefinitions.set("deployer", deployerDef());
    // Unknown run → clear error.
    await expect(resumeRun("missing", runtime)).rejects.toThrow(/not found/);
    // A running (non-paused, non-terminal) run is not resumable.
    await runtime.store.events.append(
      buildEventRecord("running-run", { type: "run.started", input: "x" }, { agentName: "deployer" }),
    );
    await expect(resumeRun("running-run", runtime)).rejects.toThrow(/not resumable/);
  });
});
