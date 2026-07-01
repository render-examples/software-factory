import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { RunPaused } from "@render-agents/engine";
import type { AgentDefinition } from "@render-agents/engine";
import { createTestRuntime, mockModel } from "../src/testing.js";
import { workflow, bindWorkflow } from "../src/workflow.js";
import { workflowTaskHandler } from "../src/dispatch.js";
import { defineTool } from "../src/authoring.js";
import type { RootDispatchJob, TaskDispatcher } from "../src/runtime.js";

describe("workflow lane (Lane A) — dispatchRoot", () => {
  it("inline drive: dispatch() runs the handler in-process to completion (dev/test)", async () => {
    const runtime = await createTestRuntime();
    let ran = 0;
    const wf = workflow(async (ctx) => {
      await ctx.step("work", async () => { ran += 1; return "ok"; });
      return "done";
    });
    bindWorkflow(wf, "wf", runtime);

    const run = await wf.dispatch({ x: 1 }, "api");

    expect(ran).toBe(1);
    expect(run.status).toBe("completed");
    expect((await runtime.store.getRun(run.id))?.result).toBe("done");
    // No run_jobs row for the workflow lane — Render is the durable queue.
    expect((await runtime.jobQueue.countByStatus()).queued).toBe(0);
  });

  it("fire-and-forget trigger: dispatch() records run.started + triggers dispatchRoot, no inline run", async () => {
    const runtime = await createTestRuntime();
    let ran = 0;
    const triggered: RootDispatchJob[] = [];
    // Stand in for RenderWorkflowsDispatcher (startTask): records the trigger and
    // returns immediately without running the handler.
    const fakeRender: TaskDispatcher = {
      dispatch: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 } }),
      dispatchRoot: async (job) => { triggered.push(job); },
    };
    (runtime as { dispatcher: TaskDispatcher }).dispatcher = fakeRender;

    const wf = workflow({ name: "wf", plan: "pro" }, async () => { ran += 1; return "done"; });
    bindWorkflow(wf, "wf", runtime);

    const run = await wf.dispatch({ x: 1 }, "api");

    expect(ran).toBe(0); // not run inline — Render owns execution
    expect(triggered).toEqual([{ workflow: "wf", runId: run.id, plan: "pro" }]);
    expect(run.status).toBe("running"); // run.started only
  });

  it("fail-fast (E6): a dispatchRoot that throws marks the root failed, not stranded running", async () => {
    const runtime = await createTestRuntime();
    // Stand in for a down workflows host: the trigger throws (connection refused).
    const downHost: TaskDispatcher = {
      dispatch: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 } }),
      dispatchRoot: async () => { throw new Error("ECONNREFUSED 127.0.0.1:8120"); },
    };
    (runtime as { dispatcher: TaskDispatcher }).dispatcher = downHost;

    const wf = workflow({ name: "wf", plan: "pro" }, async () => "done");
    bindWorkflow(wf, "wf", runtime);

    const run = await wf.dispatch({ x: 1 }, "api");

    expect(run.status).toBe("failed");
    const stored = await runtime.store.getRun(run.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toMatch(/failed to dispatch root to workflows host/);
    expect(stored?.error).toMatch(/ECONNREFUSED/);
  });

  it("workflowTaskHandler resolves the workflow by name and drives it (Workflows container)", async () => {
    const runtime = await createTestRuntime();
    let ran = 0;
    const wf = workflow(async (ctx) => {
      await ctx.step("s", async () => { ran += 1; return 1; });
      return "done";
    });
    bindWorkflow(wf, "wf", runtime);

    // The gateway recorded run.started before triggering startTask; the container
    // re-drives by name.
    const runId = "wf-task-1";
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "run.started", input: {}, trigger: "test", spanKind: "workflow" }, { agentName: "wf", spanId: runId }),
    );

    await workflowTaskHandler({ workflow: "wf", runId }, runtime.workflows);

    expect(ran).toBe(1);
    expect((await runtime.store.getRun(runId))?.status).toBe("completed");
  });

  it("workflowTaskHandler throws for a workflow not in the deployed image", async () => {
    const runtime = await createTestRuntime();
    await expect(
      workflowTaskHandler({ workflow: "missing", runId: "r1" }, runtime.workflows),
    ).rejects.toThrow(/no workflow "missing"/);
  });

  it("cancel cascade (E3): cancelling the root stops the handler and records run.cancelled", async () => {
    const runtime = await createTestRuntime();
    let secondStepRan = false;
    const wf = workflow(async (ctx) => {
      // Operator cancels mid-run (the first step stands in for "while running").
      await ctx.step("first", async () => { await runtime.cancelStore.requestCancel(ctx.runId); return 1; });
      // The next orchestration boundary must observe the cancel and unwind.
      await ctx.step("second", async () => { secondStepRan = true; return 2; });
      return "done";
    });
    bindWorkflow(wf, "wf", runtime);

    const run = await wf.dispatch({}, "api");

    expect(secondStepRan).toBe(false);
    expect(run.status).toBe("cancelled");
    expect((await runtime.store.getRun(run.id))?.status).toBe("cancelled");
  });

  it("cancel cascade (E3): a cancelled root never launches a pending child agent", async () => {
    const runtime = await createTestRuntime();
    runtime.agentDefinitions.set("worker", {
      name: "worker", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "x", tools: [],
    });
    let workerRan = false;
    const wf = workflow(async (ctx) => {
      await ctx.step("trip", async () => { await runtime.cancelStore.requestCancel(ctx.runId); return 1; });
      // The scoped agent must refuse to launch once the root is cancelled.
      const out = await ctx.agents.get("worker").run("hi");
      workerRan = true;
      return out.text;
    });
    bindWorkflow(wf, "wf", runtime);

    const run = await wf.dispatch({}, "api");

    expect(workerRan).toBe(false);
    expect(run.status).toBe("cancelled");
  });

  it("cancel cascade (E3): reaches a *nested* grandchild (workflow → agent → subagent)", async () => {
    // Interleaving deferreds: the grandchild's tool signals when it's running,
    // then blocks so the test can cancel the root mid-flight.
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => { signalStarted = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    let parentCalls = 0;
    const model = mockModel((args) => {
      const isParent = args.tools.some((t) => t.name.startsWith("subagents__"));
      if (isParent) {
        parentCalls += 1;
        if (parentCalls === 1) {
          return { content: [{ type: "tool_use", id: "p1", name: "subagents__child", input: { input: "go" } }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" } as never;
        }
        return { content: [{ type: "text", text: "parent done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } as never;
      }
      // Grandchild: ask for the gated tool (forces another loop turn → the next
      // top-of-loop cancel check observes the cancelled scope).
      return { content: [{ type: "tool_use", id: "c1", name: "gate", input: {} }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" } as never;
    });

    const gateTool = defineTool({
      name: "gate",
      description: "blocks until released",
      inputSchema: {},
      async invoke() { signalStarted(); await gate; return "done"; },
    });

    const runtime = await createTestRuntime({ model, toolSources: new Map([["gate", gateTool]]) });
    const base: Pick<AgentDefinition, "model" | "systemPrompt"> = {
      model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "x",
    };
    runtime.agentDefinitions.set("parent", { name: "parent", tools: [], subagents: ["child"], ...base });
    runtime.agentDefinitions.set("child", { name: "child", tools: ["gate"], ...base });

    const wf = workflow(async (ctx) => {
      const out = await ctx.agents.get("parent").run("go");
      return out.text;
    });
    bindWorkflow(wf, "wf", runtime);

    // Drive with a known root id so we can cancel it before drive() returns.
    const runId = "wf-root-nested";
    await runtime.store.events.append(
      buildEventRecord(runId, { type: "run.started", input: {}, trigger: "test", spanKind: "workflow" }, { agentName: "wf", spanId: runId }),
    );
    const drivePromise = wf.drive(runId);
    await started;                              // grandchild is mid-tool
    await runtime.cancelStore.requestCancel(runId); // cancel the *root*
    release();
    await drivePromise.catch(() => {});        // executeHandler rethrows RunCancelled

    expect((await runtime.store.getRun(runId))?.status).toBe("cancelled");
    // The nested grandchild observed the root's cancel scope and self-cancelled.
    const runs = await runtime.store.listRuns();
    const grandchild = runs.find((r) => r.workflow === "child");
    expect(grandchild?.status).toBe("cancelled");
  });

  it("a child parking the handler settles the root as paused (HITL re-trigger + replay)", async () => {
    const runtime = await createTestRuntime();
    let approved = false;
    const wf = workflow(async (ctx) => {
      // First drive parks (HITL); after the approval resolves, re-trigger completes.
      if (!approved) throw new RunPaused(ctx.runId, "approval", ["a1"]);
      return "done";
    });
    bindWorkflow(wf, "wf", runtime);

    const first = await wf.dispatch({}, "api");
    expect(first.status).toBe("paused");

    // Resume = re-trigger the same run (dispatchRoot → in-process drive in dev).
    approved = true;
    await runtime.dispatcher!.dispatchRoot!({ workflow: "wf", runId: first.id });
    expect((await runtime.store.getRun(first.id))?.status).toBe("completed");
  });

  it("replay idempotency: re-driving a workflow memoizes a completed child (no second model call)", async () => {
    // Re-driving a completed run (crash recovery, duplicate delivery, or the
    // HITL re-trigger) must NOT re-enter a completed child's model loop — that
    // would re-run side effects and, against a real provider, fail on a
    // transcript ending in an assistant turn. The child result is memoized.
    let modelCalls = 0;
    const model = mockModel(() => {
      modelCalls += 1;
      return { content: [{ type: "text", text: "child done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } as never;
    });
    const runtime = await createTestRuntime({ model });
    runtime.agentDefinitions.set("worker", {
      name: "worker", model: { provider: "anthropic", model: "claude-haiku-4-5" }, systemPrompt: "x", tools: [],
    });
    const wf = workflow(async (ctx) => {
      const out = await ctx.agents.get("worker").task("hi");
      return out.text;
    });
    bindWorkflow(wf, "wf", runtime);

    const run = await wf.dispatch({}, "api");
    expect(run.status).toBe("completed");
    expect(modelCalls).toBe(1);

    // Re-drive the same run: the completed child short-circuits to its memoized
    // result — no extra model call, result unchanged.
    await wf.drive(run.id);
    expect(modelCalls).toBe(1);
    expect((await runtime.store.getRun(run.id))?.result).toBe("child done");
  });
});
