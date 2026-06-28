import { describe, it, expect, afterEach } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { RunPaused, type AgentDefinition, type CompleteResult } from "@render-agents/sdk";
import { createTestRuntime, mockModel } from "@render-agents/sdk/testing";
import { defineTool } from "@render-agents/sdk";
import { createGatewayApp } from "../src/index.js";

const KEY = "RENDER_AGENTS_STRICT_APPROVAL";

afterEach(() => {
  delete process.env[KEY];
});

function deployerDef(): AgentDefinition {
  return {
    name: "deployer",
    model: { provider: "anthropic", model: "claude-haiku-4-5" },
    systemPrompt: "deploy",
    tools: ["deploy"],
    permissions: { requireApproval: ["deploy"] },
  };
}

function deployModel() {
  const responses: CompleteResult[] = [
    { content: [{ type: "tool_use", id: "tc1", name: "deploy", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
    { content: [{ type: "text", text: "shipped" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" },
  ];
  let i = 0;
  return mockModel(() => responses[Math.min(i++, responses.length - 1)]);
}

describe("gateway HITL — resolve resumes the paused run", () => {
  it("POST /approvals/:id/resolve drives the paused run to completion", async () => {
    process.env[KEY] = "1";
    let invoked = 0;
    const toolSources = new Map([
      ["deploy", defineTool({ name: "deploy", description: "ship", inputSchema: {}, async invoke() { invoked += 1; return "deployed"; } })],
    ]);
    const runtime = await createTestRuntime({ model: deployModel(), toolSources });
    runtime.agentDefinitions.set("deployer", deployerDef());

    const runId = "gw-run-1";
    await expect(
      runtime.dispatcher!.dispatch("deployer", "go", { runId, idempotencyKey: runId }),
    ).rejects.toBeInstanceOf(RunPaused);

    const app = createGatewayApp({ runtime, disableAuth: true });

    // List the pending approval through the gateway.
    const listRes = await app.request("/approvals");
    expect(listRes.status).toBe(200);
    const { approvals } = await listRes.json();
    expect(approvals).toHaveLength(1);
    const approvalId = approvals[0].id;
    expect(approvals[0].runId).toBe(runId);

    // Resolve → resume.
    const res = await app.request(`/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, resolvedBy: "alice" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ resolved: true, runId });

    // The run completed and the gated tool actually ran.
    expect(invoked).toBe(1);
    const run = await runtime.store.getRun(runId);
    expect(run?.status).toBe("completed");

    // Re-resolving is rejected (already resolved).
    const again = await app.request(`/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(again.status).toBe(409);
  });
});

describe("gateway HITL — events scaffolding sanity", () => {
  it("buildEventRecord is importable from store (smoke)", () => {
    const rec = buildEventRecord("r", { type: "run.started" });
    expect(rec.type).toBe("run.started");
  });
});
