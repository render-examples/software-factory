import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxProvider } from "#factory/sdk";
import { createWorkflowRegistry } from "../lib/workflow-registry.js";

const provider: SandboxProvider = {
  name: "test",
  async create() {
    return {} as Sandbox;
  },
  async connect() {
    return {} as Sandbox;
  },
};

describe("production workflow registry", () => {
  it("contains sandbox and bounded Slack-assistant tools", async () => {
    const registry = createWorkflowRegistry(provider);

    expect(registry.sourceIds()).toEqual([
      "sandbox",
      "slack-assistant-github",
      "slack-assistant-render",
    ]);
    await expect(registry.resolve(["Bash"])).rejects.toThrow(/not found/);
    await expect(registry.resolve(["render_trigger_deploy"])).rejects.toThrow(
      /not found/,
    );
    await expect(registry.resolve(["render_list_env_vars"])).rejects.toThrow(
      /not found/,
    );
    expect(await registry.resolve(["sandbox__read_file"])).toHaveLength(1);
    expect(await registry.resolve(["draft_factory_issue"])).toHaveLength(1);
  });
});
