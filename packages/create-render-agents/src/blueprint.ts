/**
 * Pure project blueprint: `buildFileMap(opts)` returns a map of
 * relativePath → file contents for a complete, runnable render-agents project
 * in the spec's convention layout (the code-review default example).
 *
 * No filesystem or prompt side effects — the writer + wizard layer on top.
 */

export type PackageManager = "pnpm" | "npm" | "yarn";
export type Provider = "anthropic" | "openai";

export interface ScaffoldOptions {
  /** Project (and package) name. */
  name: string;
  packageManager: PackageManager;
  provider: Provider;
  /** Env var holding the provider API key (e.g. ANTHROPIC_API_KEY). */
  apiKeyEnv: string;
  /** Include a local Postgres compose file + DATABASE_URL guidance. */
  withPostgres: boolean;
  /**
   * Version range for the generated project's `@render-agents/*` deps. Defaults
   * to a caret range; the smoke test passes `file:` paths to the local packages.
   */
  renderAgentsVersion?: string;
}

const DEFAULT_VERSION = "^0.1.0";

export function buildFileMap(opts: ScaffoldOptions): Map<string, string> {
  const v = opts.renderAgentsVersion ?? DEFAULT_VERSION;
  const files = new Map<string, string>();
  const set = (p: string, c: string) => files.set(p, c.endsWith("\n") ? c : c + "\n");

  set("package.json", packageJson(opts, v));
  set("tsconfig.json", tsconfig());
  set(".gitignore", gitignore());
  set(".env.example", envExample(opts));
  set("README.md", readme(opts));
  set("render.yaml", renderYaml(opts));
  if (opts.withPostgres) set("compose.yaml", composeYaml());

  // "Everything in Docker" path: a Dockerfile for the app + a full-stack compose
  // (Postgres + gateway, optional worker). Always emitted — it bundles its own
  // Postgres, independent of the host-dev `compose.yaml` above.
  set("Dockerfile", dockerfile());
  set(".dockerignore", dockerignore());
  set("docker-compose.yaml", dockerComposeYaml(opts));

  // agents/
  set("agents/_shared.md", sharedAgent(opts));
  set("agents/security.md", securityAgent());
  set("agents/performance.md", performanceAgent());
  set("agents/judge.md", judgeAgent());
  set("agents/assistant.md", assistantAgent());

  // tools/
  set("tools/github/index.ts", githubTool());
  set("tools/linear/index.ts", linearTool());

  // skills/
  set("skills/security-patterns/SKILL.md", securitySkill());

  // workflows/
  set("workflows/code-review/index.ts", codeReviewWorkflow());

  // webhooks/ + hooks/
  set("webhooks/github.ts", githubWebhook());
  set("hooks/audit.ts", auditHook());

  // entrypoints
  set("src/server.ts", serverEntry());
  set("src/worker.ts", workerEntry());

  return files;
}

// --- top-level files ---

function packageJson(opts: ScaffoldOptions, v: string): string {
  return JSON.stringify(
    {
      name: opts.name,
      version: "0.1.0",
      private: true,
      type: "module",
      engines: { node: ">=20" },
      scripts: {
        // `build` typechecks; agents/skills are markdown (not compiled), so the
        // app runs from source via tsx in both dev and production — the project
        // root then holds every convention dir (agents/, tools/, workflows/, …).
        build: "tsc --noEmit",
        dev: "tsx watch src/server.ts",
        start: "tsx src/server.ts",
        worker: "tsx src/worker.ts",
      },
      dependencies: {
        "@render-agents/sdk": v,
        "@render-agents/gateway": v,
        tsx: "^4.0.0",
      },
      devDependencies: {
        "@types/node": "^22.0.0",
        typescript: "^5.5.0",
      },
    },
    null,
    2,
  );
}

function tsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        resolveJsonModule: true,
      },
      include: ["src", "workflows", "tools", "webhooks", "hooks"],
      exclude: ["node_modules"],
    },
    null,
    2,
  );
}

function gitignore(): string {
  return ["node_modules", ".env", "*.tsbuildinfo"].join("\n");
}

function envExample(opts: ScaffoldOptions): string {
  return [
    "# --- Provider credentials ---",
    `${opts.apiKeyEnv}=`,
    "",
    "# --- Gateway ---",
    "PORT=3000",
    "# API key required by the gateway (Bearer auth). Generate a strong random value.",
    "RENDER_AGENTS_API_KEY=",
    "",
    "# --- Persistence (omit for in-memory local dev) ---",
    opts.withPostgres ? "DATABASE_URL=postgres://postgres:postgres@localhost:5432/agents" : "# DATABASE_URL=postgres://...",
    "",
    "# --- HITL / security ---",
    "# Set to 1 to require human approval for gated tools locally.",
    "RENDER_AGENTS_STRICT_APPROVAL=",
    "# 32+ char secret used to encrypt OAuth tokens at rest + sign state.",
    "RENDER_AGENTS_ENCRYPTION_KEY=",
    "",
    "# --- Retention (days) ---",
    "RENDER_AGENTS_EVENT_RETENTION_DAYS=30",
    "RENDER_AGENTS_RUN_RETENTION_DAYS=90",
  ].join("\n");
}

// --- agents ---

function sharedAgent(opts: ScaffoldOptions): string {
  return [
    "---",
    `model: ${opts.provider === "openai" ? "gpt-4o" : "medium"}`,
    "budget:",
    "  maxIterations: 20",
    "  maxCostUsd: 5",
    "---",
    "",
    "You are a meticulous senior engineer reviewing a code change.",
    "Be concise, specific, and cite concrete lines or patterns.",
  ].join("\n");
}

function securityAgent(): string {
  return [
    "---",
    "description: Reviews a diff for security vulnerabilities",
    "tools: [github]",
    "skills: [security-patterns]",
    "permissions:",
    "  requireApproval: [github]",
    "plan: standard",
    "---",
    "",
    "You are a security reviewer. Identify vulnerabilities in the provided diff:",
    "injection, auth/access-control, secrets, SSRF, unsafe deserialization.",
    "Summarize findings with severity.",
  ].join("\n");
}

function performanceAgent(): string {
  return [
    "---",
    "description: Reviews a diff for performance issues",
    "---",
    "",
    "You are a performance reviewer. Flag N+1 queries, unbounded loops,",
    "needless allocations, and blocking I/O. Summarize with impact.",
  ].join("\n");
}

function judgeAgent(): string {
  return [
    "---",
    "model: large",
    "description: Makes the final approve/reject decision",
    "output:",
    "  type: object",
    "  properties:",
    "    decision:",
    "      type: string",
    "      enum: [approve, request_changes]",
    "    summary:",
    "      type: string",
    "  required: [decision, summary]",
    "---",
    "",
    "You are the lead reviewer. Given the security and performance reviews,",
    "decide whether to approve or request changes. Respond as JSON.",
  ].join("\n");
}

function assistantAgent(): string {
  return [
    "---",
    "description: Conversational assistant for interactive threads",
    "interactive: true",
    "---",
    "",
    "You are a helpful conversational assistant. Hold a multi-turn conversation,",
    "remembering earlier turns in the thread, and answer the user's questions.",
  ].join("\n");
}

// --- tools ---

function githubTool(): string {
  return [
    `import { defineTool } from "@render-agents/sdk";`,
    "",
    "// A sample local tool. Real implementations call the GitHub API using the",
    "// caller's OAuth token via ctx.connection(\"github\").",
    "export default defineTool({",
    `  name: "github",`,
    `  description: "Post a review comment on the pull request",`,
    "  inputSchema: {",
    `    type: "object",`,
    "    properties: {",
    `      body: { type: "string", description: "The review comment body" },`,
    "    },",
    `    required: ["body"],`,
    "  },",
    "  async invoke(input, ctx) {",
    "    const { body } = input as { body: string };",
    `    const conn = await ctx.connection("github");`,
    "    ctx.logger.info(\"github.comment\", { hasToken: !!conn });",
    "    // Stub: echo the action. Wire to the GitHub API in production.",
    "    return `Posted comment: ${body}`;",
    "  },",
    "});",
  ].join("\n");
}

function linearTool(): string {
  return [
    `import { defineMcpSource } from "@render-agents/sdk";`,
    "",
    "// Example MCP-backed tool source. Resolved lazily — only connects when an",
    "// agent references it. Point it at your MCP server (stdio or http).",
    "export default defineMcpSource({",
    `  name: "linear",`,
    `  transport: "http",`,
    `  url: process.env.LINEAR_MCP_URL ?? "http://localhost:8080/mcp",`,
    "});",
  ].join("\n");
}

// --- skills ---

function securitySkill(): string {
  return [
    "---",
    "name: Security patterns",
    "description: Common vulnerability patterns to check during review",
    "whenToUse: When reviewing code for security issues",
    "---",
    "",
    "Check for: SQL/command injection, XSS, SSRF, broken access control,",
    "hardcoded secrets, unsafe deserialization, and missing input validation.",
  ].join("\n");
}

// --- workflows ---

function codeReviewWorkflow(): string {
  return [
    `import { workflow } from "@render-agents/sdk";`,
    "",
    "// The default example: fan out to security + performance reviewers as",
    "// isolated tasks, then a judge makes the final structured decision via a",
    "// memoized step. Inside a handler, always use ctx.agents (run-scoped).",
    "export default workflow({ name: \"code-review\" }, async (ctx) => {",
    "  const input = ctx.input as { diff?: string; message?: string } | string;",
    "  const diff = typeof input === \"string\" ? input : input.diff ?? input.message ?? \"\";",
    "",
    "  const [security, performance] = await Promise.all([",
    `    ctx.agents.get("security").task(diff),`,
    `    ctx.agents.get("performance").task(diff),`,
    "  ]);",
    "",
    "  return ctx.step(\"judge\", async () => {",
    `    const out = await ctx.agents.get("judge").run(`,
    "      `Security review:\\n${security.text}\\n\\nPerformance review:\\n${performance.text}`,",
    "    );",
    "    return out.data ?? out.text;",
    "  });",
    "});",
  ].join("\n");
}

// --- webhooks / hooks ---

function githubWebhook(): string {
  return [
    "// Auto-discovered at POST /webhooks/github. `match` routes (cheaply) and",
    "// `parse` extracts the workflow input. Verify signatures in `match` before",
    "// dispatching in production.",
    "export default {",
    `  name: "github",`,
    "  match(req: Request) {",
    `    const event = req.headers.get("x-github-event");`,
    `    return event === "pull_request" ? { workflow: "code-review", trigger: "github.pull_request" } : null;`,
    "  },",
    "  async parse(req: Request) {",
    "    const body = (await req.json()) as { pull_request?: { diff_url?: string } };",
    "    return { diff: body.pull_request?.diff_url ?? \"\" };",
    "  },",
    "};",
  ].join("\n");
}

function auditHook(): string {
  return [
    `import { defineHook } from "@render-agents/sdk";`,
    "",
    "// Hooks observe (and may transform/veto) matching events before commit.",
    "// `on` selects event types/categories; `handle` runs per matching event.",
    "export default defineHook({",
    `  name: "audit",`,
    `  on: ["tool.called"],`,
    "  async handle(event) {",
    `    console.log("[audit] tool.called", (event as { name?: string }).name);`,
    `    return { action: "continue" };`,
    "  },",
    "});",
  ].join("\n");
}

// --- entrypoints ---

function serverEntry(): string {
  return [
    `import { createRuntime, loadAgents, loadWorkflows, loadWebhooks, loadToolSources, loadHooks, loadRunners } from "@render-agents/sdk";`,
    `import { startGateway, loadConnectors } from "@render-agents/gateway";`,
    "",
    "// The project root holds the convention directories (agents/, tools/, …).",
    `const root = new URL("..", import.meta.url).pathname;`,
    "",
    "const toolSources = await loadToolSources(root);",
    "const extraRunners = await loadRunners(root);",
    "const hooks = await loadHooks(root);",
    "const runtime = await createRuntime({ toolSources, extraRunners, hooks });",
    "await loadAgents(root, runtime);",
    "const workflows = await loadWorkflows(root, runtime);",
    "const webhooks = await loadWebhooks(root);",
    "const connectors = await loadConnectors(root);",
    "",
    "const { port } = await startGateway({",
    "  runtime,",
    "  workflows,",
    "  webhooks,",
    "  connectors,",
    `  defaultWorkflow: "code-review",`,
    `  defaultAgent: "assistant", // conversational threads`,
    "});",
    "console.log(`gateway listening on :${port}`);",
  ].join("\n");
}

function workerEntry(): string {
  return [
    "// Workflow service entrypoint (Render Workflows). Registers the same",
    "// runtime + agents + workflows; task handlers run here in production.",
    `import { createRuntime, loadAgents, loadWorkflows, loadToolSources, loadHooks, loadRunners } from "@render-agents/sdk";`,
    "",
    `const root = new URL("..", import.meta.url).pathname;`,
    "const toolSources = await loadToolSources(root);",
    "const extraRunners = await loadRunners(root);",
    "const hooks = await loadHooks(root);",
    "const runtime = await createRuntime({ toolSources, extraRunners, hooks });",
    "await loadAgents(root, runtime);",
    "await loadWorkflows(root, runtime);",
    "console.log(`workflow service ready (${runtime.agentDefinitions.size} agents)`);",
  ].join("\n");
}

// --- deploy ---

function renderYaml(opts: ScaffoldOptions): string {
  return [
    "# Canonical render-agents deployment: gateway (web) + workflow service +",
    "# Postgres. See the @render-agents docs for details.",
    "databases:",
    `  - name: ${opts.name}-db`,
    "    plan: basic-256mb",
    "",
    "services:",
    "  - type: web",
    `    name: ${opts.name}-gateway`,
    "    runtime: node",
    "    plan: starter",
    "    buildCommand: npm install && npm run build",
    "    startCommand: npm run start",
    "    healthCheckPath: /health",
    "    envVars:",
    "      - key: DATABASE_URL",
    "        fromDatabase:",
    `          name: ${opts.name}-db`,
    "          property: connectionString",
    "      - key: RENDER_AGENTS_API_KEY",
    "        generateValue: true",
    "      - key: RENDER_AGENTS_ENCRYPTION_KEY",
    "        generateValue: true",
    `      - key: ${opts.apiKeyEnv}`,
    "        sync: false",
    "",
    "  - type: worker",
    `    name: ${opts.name}-workflows`,
    "    runtime: node",
    "    plan: starter",
    "    buildCommand: npm install && npm run build",
    "    startCommand: npm run worker",
    "    envVars:",
    "      - key: DATABASE_URL",
    "        fromDatabase:",
    `          name: ${opts.name}-db`,
    "          property: connectionString",
    `      - key: ${opts.apiKeyEnv}`,
    "        sync: false",
    "",
    "  # Daily retention cleanup (trims event-detail + old run summaries).",
    "  - type: cron",
    `    name: ${opts.name}-retention`,
    "    runtime: node",
    "    plan: starter",
    `    schedule: "0 4 * * *"`,
    "    buildCommand: npm install && npm run build",
    `    startCommand: 'curl -fsS -X POST "$GATEWAY_URL/admin/retention" -H "Authorization: Bearer $RENDER_AGENTS_API_KEY"'`,
    "    envVars:",
    "      - key: GATEWAY_URL",
    `        fromService: { type: web, name: ${opts.name}-gateway, property: hostport }`,
    "      - key: RENDER_AGENTS_API_KEY",
    `        fromService: { type: web, name: ${opts.name}-gateway, envVarKey: RENDER_AGENTS_API_KEY }`,
    "",
    "  # Per-minute tick that fires any due runtime-managed schedules",
    "  # (created via POST /schedules). Remove this if you only trigger via",
    "  # webhooks / the HTTP API and don't use the schedule store.",
    "  - type: cron",
    `    name: ${opts.name}-schedules`,
    "    runtime: node",
    "    plan: starter",
    `    schedule: "* * * * *"`,
    "    buildCommand: npm install && npm run build",
    `    startCommand: 'curl -fsS -X POST "$GATEWAY_URL/admin/schedules/tick" -H "Authorization: Bearer $RENDER_AGENTS_API_KEY"'`,
    "    envVars:",
    "      - key: GATEWAY_URL",
    `        fromService: { type: web, name: ${opts.name}-gateway, property: hostport }`,
    "      - key: RENDER_AGENTS_API_KEY",
    `        fromService: { type: web, name: ${opts.name}-gateway, envVarKey: RENDER_AGENTS_API_KEY }`,
  ].join("\n");
}

function composeYaml(): string {
  return [
    "# Local Postgres for the durable path while you run the app on the host",
    "# (`docker compose up -d` then `npm run dev`). For an all-in-Docker stack",
    "# (Postgres + gateway), use `docker compose -f docker-compose.yaml up --build`.",
    "services:",
    "  postgres:",
    "    image: postgres:16",
    "    environment:",
    "      POSTGRES_USER: postgres",
    "      POSTGRES_PASSWORD: postgres",
    `      POSTGRES_DB: agents`,
    "    ports:",
    '      - "5432:5432"',
    "    volumes:",
    "      - pgdata:/var/lib/postgresql/data",
    "volumes:",
    "  pgdata:",
  ].join("\n");
}

function dockerfile(): string {
  return [
    "# App image: runs the gateway from source via tsx (agents/skills are markdown,",
    "# so the project root stays the discovery root — same as production on Render).",
    "FROM node:20-slim",
    "WORKDIR /app",
    "",
    "# Install deps first for layer caching (supports npm/pnpm/yarn lockfiles).",
    "COPY package.json ./",
    "COPY package-lock.json* pnpm-lock.yaml* yarn.lock* ./",
    "RUN npm install",
    "",
    "COPY . .",
    "ENV PORT=3000",
    "EXPOSE 3000",
    'CMD ["npm", "run", "start"]',
  ].join("\n");
}

function dockerignore(): string {
  return ["node_modules", ".env", "*.tsbuildinfo", ".git", "dist", ".smoke"].join("\n");
}

function dockerComposeYaml(opts: ScaffoldOptions): string {
  const key = opts.apiKeyEnv;
  return [
    "# Full local stack, everything in Docker: Postgres + gateway (which runs the",
    "# agent loop in-process). Usage:",
    "#",
    `#   ${key}=... docker compose -f docker-compose.yaml up --build`,
    "#   open http://localhost:3000/ui   (API key: $RENDER_AGENTS_API_KEY, default dev-key)",
    "#",
    "# The bare `docker compose up` (compose.yaml) runs ONLY Postgres for host-side dev.",
    "services:",
    "  postgres:",
    "    image: postgres:16",
    "    environment:",
    "      POSTGRES_USER: postgres",
    "      POSTGRES_PASSWORD: postgres",
    "      POSTGRES_DB: agents",
    "    ports:",
    '      - "5432:5432"',
    "    volumes:",
    "      - pgdata:/var/lib/postgresql/data",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
    "      interval: 3s",
    "      timeout: 3s",
    "      retries: 10",
    "",
    "  gateway:",
    "    build: .",
    '    command: ["npm", "run", "start"]',
    "    ports:",
    '      - "3000:3000"',
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    environment:",
    '      PORT: "3000"',
    "      DATABASE_URL: postgres://postgres:postgres@postgres:5432/agents",
    "      RENDER_AGENTS_API_KEY: ${RENDER_AGENTS_API_KEY:-dev-key}",
    "      RENDER_AGENTS_ENCRYPTION_KEY: ${RENDER_AGENTS_ENCRYPTION_KEY:-dev-only-change-me-0000000000000000}",
    "      RENDER_AGENTS_STRICT_APPROVAL: ${RENDER_AGENTS_STRICT_APPROVAL:-}",
    `      ${key}: \${${key}:-}`,
    "",
    "  # Optional: the Render Workflows service. Locally, agent.task() falls back to",
    "  # in-process execution in the gateway, so this is only needed to mirror the",
    "  # production split. Enable with:",
    "  #   docker compose -f docker-compose.yaml --profile worker up --build",
    "  worker:",
    "    build: .",
    '    command: ["npm", "run", "worker"]',
    '    profiles: ["worker"]',
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    environment:",
    "      DATABASE_URL: postgres://postgres:postgres@postgres:5432/agents",
    `      ${key}: \${${key}:-}`,
    "",
    "volumes:",
    "  pgdata:",
  ].join("\n");
}

function readme(opts: ScaffoldOptions): string {
  const pm = opts.packageManager;
  const install = pm === "npm" ? "npm install" : `${pm} install`;
  const dev = pm === "npm" ? "npm run dev" : `${pm} dev`;
  return [
    `# ${opts.name}`,
    "",
    "A render-agents project scaffolded with `create-render-agents`. The default",
    "example is a **code-review** pipeline (security + performance reviewers → judge).",
    "",
    "## Run locally",
    "",
    "```sh",
    install,
    `cp .env.example .env   # add your ${opts.apiKeyEnv}`,
    dev,
    "```",
    "",
    "Then open the operator UI at `http://localhost:3000/ui` (enter your",
    "`RENDER_AGENTS_API_KEY`) and dispatch a run:",
    "",
    "```sh",
    `curl -X POST localhost:3000/workflows/code-review \\`,
    `  -H "Authorization: Bearer $RENDER_AGENTS_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"input":{"diff":"--- a/app.ts\\n+++ b/app.ts"}}'`,
    "```",
    "",
    "## Run everything in Docker",
    "",
    "An all-in-Docker stack (Postgres + gateway, which runs the agent loop",
    "in-process — no separate worker needed locally):",
    "",
    "```sh",
    `${opts.apiKeyEnv}=sk-... docker compose -f docker-compose.yaml up --build`,
    "# operator UI at http://localhost:3000/ui (API key: RENDER_AGENTS_API_KEY, default dev-key)",
    "```",
    "",
    ...(opts.withPostgres
      ? ["The lightweight `compose.yaml` (`docker compose up -d`) runs only Postgres if",
         "you'd rather run the app on the host with `" + dev + "`."]
      : ["Prefer host-side dev? Run a Postgres container and `" + dev + "` with `DATABASE_URL` set."]),
    "",
    "## Deploy to Render",
    "",
    "Commit and create a Blueprint from `render.yaml` (gateway + workflow service + Postgres).",
    "",
    "## Layout",
    "",
    "- `agents/` — markdown agents (`_shared.md` holds defaults)",
    "- `tools/` — local + MCP tool sources",
    "- `skills/` — progressive-disclosure skill docs",
    "- `workflows/` — orchestration (`code-review`)",
    "- `webhooks/`, `hooks/` — triggers + event middleware",
    "- `src/server.ts` — gateway entrypoint",
  ].join("\n");
}
