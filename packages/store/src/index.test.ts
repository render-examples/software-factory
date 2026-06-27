import { describe, it, expect } from "vitest";
import { idempotencyKey } from "../src/index.js";

describe("@render-agents/store", () => {
  it("idempotencyKey is a stable SHA-256 hex digest", () => {
    const key = idempotencyKey("run1", "suffix");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey("run1", "suffix")).toBe(key);
  });

  it("idempotencyKey varies by runId and suffix", () => {
    expect(idempotencyKey("run1", "a")).not.toBe(idempotencyKey("run1", "b"));
    expect(idempotencyKey("run1", "a")).not.toBe(idempotencyKey("run2", "a"));
  });
});
