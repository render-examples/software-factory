import { describe, it, expect } from "vitest";
import { idempotencyKey } from "../src/index.js";

describe("@render-agents/store", () => {
  it("idempotencyKey throws not implemented", () => {
    expect(() => idempotencyKey("run1", "suffix")).toThrow("not implemented");
  });
});
