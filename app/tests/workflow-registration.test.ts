import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskRegistry } from "@renderinc/sdk/workflows";

beforeEach(() => {
  process.env.FACTORY_REPO = "acme/factory";
  TaskRegistry.getInstance().clear();
});

afterEach(() => {
  delete process.env.FACTORY_REPO;
  TaskRegistry.getInstance().clear();
});

describe("workflow registration", () => {
  it("registers exactly the factory pipeline and its stations", async () => {
    await import("../tasks/index.js");
    await import("../workflows/spec-to-pr.js");

    expect(TaskRegistry.getInstance().getAllTaskNames().sort()).toEqual(
      [
        "analyst",
        "correctness",
        "implementer",
        "judge",
        "security",
        "spec-to-pr",
        "tests",
        "triage",
      ].sort(),
    );
  });
});
