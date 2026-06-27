import { describe, it, expect } from "vitest";
import { estimateCost, RunPaused, MODEL_PRICING } from "../src/index.js";

describe("@render-agents/engine", () => {
  it("estimateCost throws not implemented", () => {
    expect(() => estimateCost("claude-sonnet-4-6", { inputTokens: 100, outputTokens: 50 })).toThrow("not implemented");
  });

  it("RunPaused is a proper Error subclass", () => {
    const err = new RunPaused("run-1", "approval", ["req-1"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.runId).toBe("run-1");
    expect(err.reason).toBe("approval");
    expect(err.pendingApprovalIds).toEqual(["req-1"]);
  });

  it("MODEL_PRICING contains known models", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4-6"].inputPer1M).toBe(3.00);
  });
});
