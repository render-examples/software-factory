import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxProvider } from "#factory-sdk";
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
  it("contains only workflow-bound sandbox tools", async () => {
    const registry = createWorkflowRegistry(provider);

    expect(registry.sourceIds()).toEqual(["sandbox"]);
    await expect(registry.resolve(["Bash"])).rejects.toThrow(/not found/);
    expect(await registry.resolve(["sandbox__read_file"])).toHaveLength(1);
  });
});
