import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildFileMap, parseArgs, optionsFromArgs, validateProjectName, SCAFFOLDER_VERSION } from "../src/index.js";

describe("create-render-agents", () => {
  it("exports SCAFFOLDER_VERSION", () => {
    expect(SCAFFOLDER_VERSION).toBe("0.0.1");
  });

  it("has no @render-agents/* runtime dependencies (ships as `npm create`)", () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.some((d) => d.startsWith("@render-agents/"))).toBe(false);
  });
});

describe("CLI validation (CR-27 / CR-30)", () => {
  it("rejects project names that would escape the target directory", () => {
    for (const bad of ["../evil", "/abs/path", "a/b", "a\\b", "..", "", "  "]) {
      expect(validateProjectName(bad), `should reject "${bad}"`).toBeTruthy();
    }
  });

  it("accepts plain folder names", () => {
    expect(validateProjectName("my-agents")).toBeUndefined();
    expect(validateProjectName("my_agents.2")).toBeUndefined();
  });

  it("rejects unknown or missing --pm / --provider values", () => {
    expect(() => parseArgs(["--pm", "bun"])).toThrow(/--pm/);
    expect(() => parseArgs(["--provider", "grok"])).toThrow(/--provider/);
    expect(() => parseArgs(["myapp", "--pm"])).toThrow(/--pm/);
    expect(parseArgs(["--pm", "pnpm"]).packageManager).toBe("pnpm");
    expect(parseArgs(["--provider", "openai"]).provider).toBe("openai");
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
      "Dockerfile", ".dockerignore", "docker-compose.yaml",
      "agents/_shared.md", "agents/security.md", "agents/performance.md", "agents/judge.md", "agents/assistant.md",
      "tools/github/index.ts", "tools/linear/index.ts",
      "skills/security-patterns/SKILL.md",
      "workflows/code-review/index.ts",
      "channels/github.ts", "hooks/audit.ts",
      "src/server.ts", "src/worker.ts",
    ]) {
      expect(files.has(expected), `missing ${expected}`).toBe(true);
    }
  });

  it("ships an all-in-Docker stack (Dockerfile + full-stack compose with optional worker)", () => {
    // Dockerfile install/run commands honor the chosen package manager (CR-29):
    // this project is pnpm, so the CMD uses pnpm (not a hardcoded npm).
    expect(files.get("Dockerfile")).toContain('CMD ["pnpm", "start"]');
    expect(files.get("Dockerfile")).toContain("RUN pnpm install");
    const compose = files.get("docker-compose.yaml")!;
    expect(compose).toContain("postgres:");
    expect(compose).toContain("gateway:");
    expect(compose).toContain("DATABASE_URL: postgres://postgres:postgres@postgres:5432/agents");
    expect(compose).toContain("ANTHROPIC_API_KEY"); // the project's provider key var
    expect(compose).toContain('profiles: ["worker"]'); // worker is opt-in
    // The Docker stack ships regardless of the host-dev Postgres choice.
    const noPg = buildFileMap({ name: "x", packageManager: "npm", provider: "openai", apiKeyEnv: "OPENAI_API_KEY", withPostgres: false });
    expect(noPg.has("docker-compose.yaml")).toBe(true);
    expect(noPg.has("Dockerfile")).toBe(true);
    expect(noPg.get("docker-compose.yaml")).toContain("OPENAI_API_KEY");
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
    // `files` is built with pnpm, so render.yaml uses the pnpm command form.
    expect(files.get("render.yaml")).toContain("pnpm start");
  });

  it("templates render.yaml build/run commands from the chosen package manager (BUG-06)", () => {
    const y = files.get("render.yaml")!; // pnpm project
    expect(y).toContain("buildCommand: pnpm install && pnpm build");
    expect(y).toContain("startCommand: pnpm start");
    expect(y).toContain("startCommand: pnpm worker");
    expect(y).toContain("startCommand: pnpm workflows");
    expect(y).not.toContain("npm install && npm run build");

    const npm = buildFileMap({ name: "x", packageManager: "npm", provider: "openai", apiKeyEnv: "OPENAI_API_KEY", withPostgres: false }).get("render.yaml")!;
    expect(npm).toContain("buildCommand: npm install && npm run build");
    expect(npm).toContain("startCommand: npm run start");
    expect(npm).toContain("startCommand: npm run worker");
  });

  it("configures the gateway for the two-lane deploy (queue mode + Render Workflows trigger) (BUG-03/04)", () => {
    const y = files.get("render.yaml")!;
    // Chat lane drains via the warm worker rather than driving inline on the gateway.
    expect(y).toContain("key: RENDER_AGENTS_EXECUTION_MODE");
    expect(y).toContain("value: queue");
    // Workflow lane trigger config: slug points at the workflows service; the API
    // key is operator-provided (sync: false) so the gateway falls back to
    // in-process until it's set.
    expect(y).toContain("key: RENDER_API_KEY");
    expect(y).toContain("key: RENDER_WORKFLOW_SLUG");
    expect(y).toContain("value: demo-workflows");
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
