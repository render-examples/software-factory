import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflows, loadWebhooks, loadToolSources, loadHooks, loadRunners } from "./load-project.js";
import { createTestRuntime, mockModel } from "../testing.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ra-project-"));

  // workflows/echo/index.ts
  await mkdir(join(dir, "workflows", "echo"), { recursive: true });
  await writeFile(
    join(dir, "workflows", "echo", "index.ts"),
    `import { workflow } from "${sdkEntry()}";\nexport default workflow(async (ctx) => ctx.input);\n`,
  );

  // webhooks/github.ts
  await mkdir(join(dir, "webhooks"), { recursive: true });
  await writeFile(
    join(dir, "webhooks", "github.ts"),
    `export default { name: "github", match: () => ({ workflow: "echo", trigger: "push" }), parse: async () => ({ ok: true }) };\n`,
  );

  // tools/greeter/index.ts (DefineToolSpec default export)
  await mkdir(join(dir, "tools", "greeter"), { recursive: true });
  await writeFile(
    join(dir, "tools", "greeter", "index.ts"),
    `export default { name: "greeter", description: "greets", inputSchema: {}, invoke: async () => "hi" };\n`,
  );

  // hooks/audit.ts
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(
    join(dir, "hooks", "audit.ts"),
    `export default { name: "audit", on: ["tool.called"], handle: async () => ({ action: "continue" }) };\n`,
  );

  // runners/echo.ts
  await mkdir(join(dir, "runners"), { recursive: true });
  await writeFile(
    join(dir, "runners", "echo.ts"),
    `export default { run: async (_agent, input, ctx) => { await ctx.emit({ type: "run.completed", result: input }); return { text: String(input), usage: { inputTokens: 0, outputTokens: 0 } }; } };\n`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Resolve the built SDK entry so the temp workflow module can import it. */
function sdkEntry(): string {
  return new URL("../index.js", import.meta.url).href;
}

describe("project discovery loaders", () => {
  it("loadWorkflows discovers + binds workflows by directory name", async () => {
    const runtime = await createTestRuntime({ model: mockModel(() => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" })) });
    const workflows = await loadWorkflows(dir, runtime);
    expect([...workflows.keys()]).toEqual(["echo"]);
    expect(workflows.get("echo")!.name).toBe("echo");
    // Bound → dispatch is callable and returns a RunRecord.
    const run = await workflows.get("echo")!.dispatch("hello");
    expect(run.id).toBeTruthy();
  });

  it("loadWebhooks discovers adapters by filename", async () => {
    const webhooks = await loadWebhooks(dir);
    expect([...webhooks.keys()]).toEqual(["github"]);
    expect(webhooks.get("github")!.match(new Request("http://x"))).toEqual({ workflow: "echo", trigger: "push" });
  });

  it("loadToolSources coerces a DefineToolSpec default export into a ToolSource", async () => {
    const sources = await loadToolSources(dir);
    expect([...sources.keys()]).toEqual(["greeter"]);
    const resolved = await sources.get("greeter")!.resolve({} as never);
    expect(resolved.tools[0].name).toBe("greeter");
  });

  it("loadHooks discovers hooks with the { name, on, handle } shape", async () => {
    const hooks = await loadHooks(dir);
    expect(hooks.map((h) => h.name)).toEqual(["audit"]);
    expect(hooks[0].on).toContain("tool.called");
  });

  it("loadRunners discovers + registers custom runners by name", async () => {
    const runners = await loadRunners(dir);
    expect([...runners.keys()]).toEqual(["echo"]);
    // The custom runner is invocable via the runtime registry.
    const runtime = await createTestRuntime({ model: mockModel(() => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" })), extraRunners: runners });
    expect(runtime.runners.has("echo")).toBe(true);
    expect(runtime.runners.get("echo")).toBe(runners.get("echo"));
  });
});
