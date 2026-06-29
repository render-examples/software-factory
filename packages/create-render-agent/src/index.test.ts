import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFileMap, parseArgs, optionsFromArgs, SCAFFOLDER_VERSION } from "./index.js";

describe("create-render-agent", () => {
  it("exports SCAFFOLDER_VERSION", () => {
    expect(SCAFFOLDER_VERSION).toBe("0.0.1");
  });

  it("has no @render-agents/* runtime dependencies (ships as `npm create`)", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.some((d) => d.startsWith("@render-agents/"))).toBe(false);
  });
});

describe("buildFileMap", () => {
  const files = buildFileMap({
    name: "demo",
    packageManager: "pnpm",
    provider: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    withPostgres: true,
  });

  it("emits the full spec-layout project", () => {
    for (const expected of [
      "package.json", "tsconfig.json", ".env.example", "render.yaml", "compose.yaml", "README.md",
      "agents/_shared.md", "agents/security.md", "agents/performance.md", "agents/judge.md",
      "tools/github/index.ts", "tools/linear/index.ts",
      "skills/security-patterns/SKILL.md",
      "workflows/code-review/index.ts",
      "webhooks/github.ts", "hooks/audit.ts",
      "src/server.ts", "src/worker.ts",
    ]) {
      expect(files.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it("emits a coherent, valid package.json with the @render-agents deps", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.name).toBe("demo");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@render-agents/sdk"]).toBeTruthy();
    expect(pkg.dependencies["@render-agents/gateway"]).toBeTruthy();
    expect(pkg.scripts.start).toBeTruthy();
  });

  it("runs from source (tsx) so markdown convention dirs resolve in production", () => {
    const pkg = JSON.parse(files.get("package.json")!);
    // Production runs via tsx — not `node dist/...` — because agents/skills are
    // markdown (uncompiled); running from source keeps the project root as the
    // discovery root. (Regression guard for the dist/runtime mismatch.)
    expect(pkg.scripts.start).toBe("tsx src/server.ts");
    expect(pkg.scripts.worker).toBe("tsx src/worker.ts");
    expect(pkg.scripts.build).toBe("tsc --noEmit");
    expect(pkg.dependencies.tsx).toBeTruthy(); // tsx is a runtime dep, not just dev
    expect(files.get("src/server.ts")).toContain('new URL("..", import.meta.url)');
    expect(files.get(".gitignore")).not.toContain("dist");
    expect(files.get("render.yaml")).toContain("npm run start");
  });

  it("emits valid agent frontmatter and a json-schema judge output", () => {
    expect(files.get("agents/security.md")).toContain("requireApproval: [github]");
    expect(files.get("agents/judge.md")).toContain("enum: [approve, request_changes]");
  });

  it("omits compose.yaml when Postgres is disabled", () => {
    const noPg = buildFileMap({ name: "x", packageManager: "npm", provider: "openai", apiKeyEnv: "OPENAI_API_KEY", withPostgres: false });
    expect(noPg.has("compose.yaml")).toBe(false);
    expect(noPg.has("render.yaml")).toBe(true);
  });

  it("supports file: deps for local smoke tests", () => {
    const local = buildFileMap({
      name: "x", packageManager: "pnpm", provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY",
      withPostgres: false, renderAgentsVersion: "file:/tmp/sdk",
    });
    expect(JSON.parse(local.get("package.json")!).dependencies["@render-agents/sdk"]).toBe("file:/tmp/sdk");
  });
});

describe("CLI arg parsing", () => {
  it("parses name + flags", () => {
    const args = parseArgs(["my-app", "--yes", "--pm", "npm", "--provider", "openai", "--no-postgres"]);
    expect(args).toMatchObject({ name: "my-app", yes: true, packageManager: "npm", provider: "openai", postgres: false });
    const opts = optionsFromArgs(args);
    expect(opts.apiKeyEnv).toBe("OPENAI_API_KEY");
  });

  it("defaults sensibly under --yes with no flags", () => {
    const opts = optionsFromArgs(parseArgs(["--yes"]));
    expect(opts).toMatchObject({ name: "my-agents", packageManager: "pnpm", provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" });
  });
});
