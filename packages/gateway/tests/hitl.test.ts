import { describe, it, expect, afterEach } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { RunPaused, type AgentDefinition, type CompleteResult } from "@render-agents/sdk";
import { createTestRuntime, mockModel } from "@render-agents/sdk/testing";
import { defineTool, workflow, bindWorkflow } from "@render-agents/sdk";
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

    const app = createGatewayApp({ runtime, disableAuth: true, awaitResume: true });

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

describe("gateway HITL — workflow root resumes when a child approval resolves", () => {
  it("a single /approvals/:id/resolve drives both the gated child and the paused workflow root to completion", async () => {
    process.env[KEY] = "1";
    let invoked = 0;
    const toolSources = new Map([
      ["deploy", defineTool({ name: "deploy", description: "ship", inputSchema: {}, async invoke() { invoked += 1; return "deployed"; } })],
    ]);
    const runtime = await createTestRuntime({ model: deployModel(), toolSources });
    runtime.agentDefinitions.set("deployer", deployerDef());

    // A workflow that gates on a child agent's tool: the child parks on approval,
    // which propagates so the workflow root itself settles as paused.
    const wf = workflow({ name: "deploy-review" }, async (ctx) => {
      const out = await ctx.agents.get("deployer").task("deploy");
      return ctx.step("summary", async () => out.text);
    });
    bindWorkflow(wf, "deploy-review", runtime);
    const workflows = new Map([["deploy-review", wf]]);

    // Dispatch drives the root in-process (dev); the gated child parks it.
    const root = await wf.dispatch({ environment: "production" }, "api");
    expect(root.status).toBe("paused");

    const app = createGatewayApp({ runtime, workflows, disableAuth: true, awaitResume: true });

    // The approval lives on the *child* run, not the paused root.
    const { approvals } = await (await app.request("/approvals")).json();
    expect(approvals).toHaveLength(1);
    const approvalId = approvals[0].id;
    const childRunId = approvals[0].runId;
    expect(childRunId).not.toBe(root.id);

    // Resolving the child approval bubbles up to re-drive the paused root.
    const res = await app.request(`/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, resolvedBy: "alice" }),
    });
    expect(res.status).toBe(200);

    // One deploy; child completed; and the root reached completion in a single
    // operator action (no stranded pause, no replay re-run).
    expect(invoked).toBe(1);
    expect((await runtime.store.getRun(childRunId))?.status).toBe("completed");
    const finishedRoot = await runtime.store.getRun(root.id);
    expect(finishedRoot?.status).toBe("completed");
    expect(finishedRoot?.result).toBe("shipped");
  });
});

describe("gateway HITL — thread-scoped approvals (chat N+1 avoidance)", () => {
  it("GET /approvals?threadId= returns only that thread's approvals", async () => {
    const runtime = await createTestRuntime();
    const { store } = runtime;

    const seed = async (runId: string, threadId: string) => {
      await store.events.append(
        buildEventRecord(runId, { type: "run.started", input: {}, threadId }, { agentName: "deployer", spanId: runId }),
      );
      await store.events.append(
        buildEventRecord(
          runId,
          { type: "approval.requested", approvalRequestId: `ap-${runId}`, toolName: "deploy", input: {} },
          { agentName: "deployer", spanId: runId },
        ),
      );
    };
    await seed("run-a", "thread-a");
    await seed("run-b", "thread-b");

    const app = createGatewayApp({ runtime, disableAuth: true });

    const scoped = await app.request("/approvals?threadId=thread-a");
    expect(scoped.status).toBe(200);
    const { approvals } = await scoped.json();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].runId).toBe("run-a");

    // Unfiltered still returns both pending approvals.
    const all = await (await app.request("/approvals")).json();
    expect(all.approvals).toHaveLength(2);
  });
});

describe("gateway HITL — events scaffolding sanity", () => {
  it("buildEventRecord is importable from store (smoke)", () => {
    const rec = buildEventRecord("r", { type: "run.started" });
    expect(rec.type).toBe("run.started");
  });
});
