import { describe, it, expect } from "vitest";
import { estimateCost, RunPaused, MODEL_PRICING } from "../src/index.js";

describe("@render-factory/engine", () => {
  it("estimateCost computes USD cost from per-1M pricing", () => {
    // 1M input @ $3.00 + 1M output @ $15.00
    expect(estimateCost("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 10);
  });

  it("estimateCost returns 0 for unpriced (but routable) models", () => {
    expect(estimateCost("some-unlisted-model", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  it("RunPaused is a proper Error subclass", () => {
    const err = new RunPaused("run-1", "input", ["req-1"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.runId).toBe("run-1");
    expect(err.reason).toBe("input");
    expect(err.pendingInputIds).toEqual(["req-1"]);
  });

  it("MODEL_PRICING contains known models", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_PRICING["claude-sonnet-4-6"].inputPer1M).toBe(3.00);
  });
});
