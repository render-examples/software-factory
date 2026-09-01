import { describe, expect, it } from "vitest";
import { isCustomTool } from "#factory/sdk";
import {
  analyst,
  correctness,
  implementer,
  judge,
  security,
  selfReview,
  tests,
  triage,
} from "../agents/index.js";

function toolNames(agent: { spec: { tools?: readonly { name: string }[] } }): string[] {
  return (agent.spec.tools ?? []).map((t) => t.name);
}

describe("factory agent tool boundaries", () => {
  it("gives host-side decision agents no tools", () => {
    for (const agent of [triage, selfReview, security, correctness, tests, judge]) {
      expect(agent.spec.tools).toEqual([]);
    }
  });

  it("gives the analyst only read-only sandbox tools", () => {
    expect(toolNames(analyst)).toEqual([
      "sandbox__read_file",
      "sandbox__list_dir",
      "sandbox__search",
    ]);
    for (const tool of analyst.spec.tools ?? []) {
      expect(isCustomTool(tool)).toBe(true);
    }
  });

  it("keeps writes isolated to the implementer sandbox", () => {
    const names = toolNames(implementer);
    expect(names).toContain("sandbox__write_file");
    expect(names).toContain("sandbox__exec");
    expect(names).not.toContain("Bash");
  });
});
