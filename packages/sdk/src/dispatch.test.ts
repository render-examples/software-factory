import { describe, it, expect, afterEach } from "vitest";
import { isWorkflowsEnvironment, computeDispatchKey, computeRequiredPlans } from "./dispatch.js";
import type { AgentDefinition } from "@render-agents/engine";

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
