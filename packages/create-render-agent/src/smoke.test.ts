import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeProject } from "./write.js";
// The generated project imports "@render-agents/sdk"; resolved via the workspace
// because the scaffold target lives inside the monorepo. (devDependency only.)
import { createRuntime, loadAgents, loadWorkflows, loadToolSources } from "@render-agents/sdk";
import { mockModel } from "@render-agents/sdk/testing";

// Scaffold inside the package dir so generated modules resolve @render-agents/sdk
// via the workspace node_modules (an OS-temp dir would not).
const baseDir = new URL("../.smoke/", import.meta.url).pathname;
let projectDir: string;

afterAll(async () => {
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

describe("scaffolded project — end-to-end", () => {
  it("discovers agents/tools/workflows and runs the code-review example", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(baseDir, { recursive: true });
    projectDir = await mkdtemp(join(baseDir, "proj-"));

    await writeProject(projectDir, {
      name: "smoke-app",
      packageManager: "pnpm",
      provider: "anthropic",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      withPostgres: false,
    });

    // A mock model that returns schema-valid JSON (satisfies the judge's output
    // schema; harmless plain text for the security/performance reviewers).
    const model = mockModel(() => ({
      content: [{ type: "text", text: '{"decision":"approve","summary":"looks good"}' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    }));

    const toolSources = await loadToolSources(projectDir);
    expect([...toolSources.keys()].sort()).toEqual(["github", "linear"]);

    const runtime = await createRuntime({ model, toolSources });
    const agents = await loadAgents(projectDir, runtime);
    expect(agents.has("security")).toBe(true);
    expect(agents.has("judge")).toBe(true);

    const workflows = await loadWorkflows(projectDir, runtime);
    expect(workflows.has("code-review")).toBe(true);

    const run = await workflows.get("code-review")!.dispatch({ diff: "--- a/x\n+++ b/x" });
    expect(run.status).toBe("completed");

    // The judge's structured decision is the workflow result.
    expect(run.result).toMatchObject({ decision: "approve" });
  });
});
