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
  it("registers exactly the factory pipeline and its agents", async () => {
    await import("../tasks/index.js");
    await import("../workflows/slack-assistant.js");
    await import("../workflows/spec-to-pr.js");

    expect(TaskRegistry.getInstance().getAllTaskNames().sort()).toEqual(
      [
        "analyst",
        "correctness",
        "implementer",
        "judge",
        "security",
        "slack-assistant",
        "slack-assistant-agent",
        "spec-to-pr",
        "tests",
        "triage",
      ].sort(),
    );
  });
});
