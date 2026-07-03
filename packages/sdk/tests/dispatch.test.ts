import { describe, it, expect, afterEach } from "vitest";
import { isWorkflowsEnvironment, computeDispatchKey, computeRequiredPlans, workflowTaskHandler } from "../src/dispatch.js";
import type { AgentDefinition } from "@render-agents/engine";
import { RunPaused } from "@render-agents/engine";
import type { WorkflowDefinition } from "../src/workflow.js";

const SOCKET = "RENDER_SDK_SOCKET_PATH";
const LOCAL = "RENDER_USE_LOCAL_DEV";

/** Restore env after each case so the truth-table assertions don't leak. */
afterEach(() => {
  delete process.env[SOCKET];
  delete process.env[LOCAL];
});

describe("isWorkflowsEnvironment (spec truth table)", () => {
  it("is false when neither var is set → in-process fallback", () => {
    delete process.env[SOCKET];
    delete process.env[LOCAL];
    expect(isWorkflowsEnvironment()).toBe(false);
  });

  it("is true when the deployed socket path is present", () => {
    process.env[SOCKET] = "/tmp/render.sock";
    delete process.env[LOCAL];
    expect(isWorkflowsEnvironment()).toBe(true);
  });

  it("is true in Render CLI local-dev workflows mode", () => {
    delete process.env[SOCKET];
    process.env[LOCAL] = "1";
    expect(isWorkflowsEnvironment()).toBe(true);
  });

  it("is true when both are present", () => {
    process.env[SOCKET] = "/tmp/render.sock";
    process.env[LOCAL] = "true";
    expect(isWorkflowsEnvironment()).toBe(true);
  });
});

describe("computeDispatchKey", () => {
  it("is deterministic for the same (runId, agent, ordinal)", () => {
    const a = computeDispatchKey("run-1", "security", 0);
    const b = computeDispatchKey("run-1", "security", 0);
    expect(a).toBe(b);
  });

  it("differs by ordinal and by agent", () => {
    expect(computeDispatchKey("run-1", "security", 0)).not.toBe(computeDispatchKey("run-1", "security", 1));
    expect(computeDispatchKey("run-1", "security", 0)).not.toBe(computeDispatchKey("run-1", "performance", 0));
  });
});

describe("computeRequiredPlans", () => {
  it("always includes standard and the referenced plans (sorted, deduped)", () => {
    const defs = [
      { name: "a", plan: "pro" },
      { name: "b", plan: "starter" },
      { name: "c" },
      { name: "d", plan: "pro" },
    ] as AgentDefinition[];
    expect(computeRequiredPlans(defs)).toEqual(["pro", "standard", "starter"]);
  });
});

describe("workflowTaskHandler return contract", () => {
  // The Render task runner requires a result or a throw — a `void` return marks
  // an otherwise-successful run as a FAILED task. These guard that contract.
  const makeWorkflows = (drive: () => Promise<void>): Map<string, WorkflowDefinition> =>
    new Map([["wf", { drive } as unknown as WorkflowDefinition]]);

  it("returns a completed summary on success (not void)", async () => {
    const result = await workflowTaskHandler({ workflow: "wf", runId: "r1" }, makeWorkflows(async () => {}));
    expect(result).toEqual({ runId: "r1", status: "completed" });
  });

  it("returns a paused summary when the handler parks (HITL) instead of throwing", async () => {
    const drive = async () => { throw new RunPaused("r2", "input", ["req-1"]); };
    const result = await workflowTaskHandler({ workflow: "wf", runId: "r2" }, makeWorkflows(drive));
    expect(result).toEqual({ runId: "r2", status: "paused" });
  });

  it("rethrows a genuine handler failure so Render marks the task failed", async () => {
    const drive = async () => { throw new Error("boom"); };
    await expect(workflowTaskHandler({ workflow: "wf", runId: "r3" }, makeWorkflows(drive))).rejects.toThrow("boom");
  });

  it("throws when the workflow is not in the deployed image", async () => {
    await expect(workflowTaskHandler({ workflow: "missing", runId: "r4" }, makeWorkflows(async () => {}))).rejects.toThrow(/no workflow "missing"/);
  });
});
