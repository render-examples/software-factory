import { describe, it, expect } from "vitest";
import { buildEventRecord } from "@render-agents/store";
import { RunPaused } from "@render-agents/engine";
import { createTestRuntime } from "./testing.js";
import { workflow, bindWorkflow } from "./workflow.js";
import { workflowTaskHandler } from "./dispatch.js";
import type { RootDispatchJob, TaskDispatcher } from "./runtime.js";

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
});
