import { describe, expect, it } from "vitest";
import {
  analyst,
  assistant,
  correctness,
  implementer,
  judge,
  security,
  tests,
  triage,
} from "../agents/index.js";

describe("factory agent tool boundaries", () => {
  it("keeps the Slack assistant bounded to read and issue drafting", () => {
    expect(assistant.spec.tools).toContain("draft_factory_issue");
    expect(assistant.spec.tools).not.toContain("render_trigger_deploy");
    expect(assistant.spec.tools).not.toContain("render_list_env_vars");
    expect(assistant.spec.tools).not.toContain("Bash");
  });

  it("gives host-side decision agents no tools", () => {
    for (const agent of [triage, security, correctness, tests, judge]) {
      expect(agent.spec.tools).toEqual([]);
    }
  });

  it("gives the analyst only read-only sandbox tools", () => {
    expect(analyst.spec.tools).toEqual([
      "sandbox__read_file",
      "sandbox__list_dir",
      "sandbox__search",
    ]);
  });

  it("keeps writes isolated to the implementer sandbox", () => {
    expect(implementer.spec.tools).toContain("sandbox__write_file");
    expect(implementer.spec.tools).toContain("sandbox__exec");
    expect(implementer.spec.tools).not.toContain("Bash");
  });
});
