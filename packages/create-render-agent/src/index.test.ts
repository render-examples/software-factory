import { describe, it, expect } from "vitest";
import { SCAFFOLDER_VERSION } from "../src/index.js";

describe("create-render-agent", () => {
  it("exports SCAFFOLDER_VERSION", () => {
    expect(SCAFFOLDER_VERSION).toBe("0.0.1");
  });
});
