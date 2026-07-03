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
  /** Version range for generated `@render-agents/*` deps; smoke test uses `file:` paths. */
  renderAgentsVersion?: string;
}

const DEFAULT_VERSION = "^0.1.0";

/** `<pm> install` for the chosen package manager. */
function pmInstall(pm: PackageManager): string {
  return pm === "npm" ? "npm install" : `${pm} install`;
}

/** Invoke a package.json script with the chosen package manager (npm needs `run`). */
function pmRun(pm: PackageManager, script: string): string {
  return pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;
}

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

  // Full-stack Docker path (Postgres + gateway); bundles its own Postgres,
  // independent of the host-dev `compose.yaml` above.
  set("Dockerfile", dockerfile(opts));
  set(".dockerignore", dockerignore());
  set("docker-compose.yaml", dockerComposeYaml(opts));

  set("agents/_shared.md", sharedAgent(opts));
  set("agents/security.md", securityAgent());
  set("agents/performance.md", performanceAgent());
  set("agents/judge.md", judgeAgent());
  set("agents/assistant.md", assistantAgent());

  set("tools/github/index.ts", githubTool());
  set("tools/linear/index.ts", linearTool());

  set("skills/security-patterns/SKILL.md", securitySkill());

  set("workflows/code-review/index.ts", codeReviewWorkflow());

  set("channels/github.ts", githubChannel());
  set("hooks/audit.ts", auditHook());

  // Two-lane topology: server (gateway/SSE), worker (chat, drains run_jobs), workflows (durable lane)
  set("src/server.ts", serverEntry());
  set("src/worker.ts", chatWorkerEntry());
  set("src/workflows.ts", workflowsHostEntry());

  return files;
}

function packageJson(opts: ScaffoldOptions, v: string): string {
  return JSON.stringify(
    {
      name: opts.name,
      version: "0.1.0",
      private: true,
      type: "module",
      engines: { node: ">=20" },
      scripts: {
        // agents/skills are markdown, not compiled; app runs from source via tsx.
        build: "tsc --noEmit",
        dev: "tsx watch src/server.ts",
        start: "tsx src/server.ts",
        worker: "tsx src/worker.ts", // Lane B: drains run_jobs
        workflows: "tsx src/workflows.ts", // Lane A: Render Workflows tasks
      },
      dependencies: {
        "@render-agents/sdk": v,
        "@render-agents/gateway": v,
        // Workflows host registers tasks against this; gateway triggers Lane A roots (D5).
        "@renderinc/sdk": "^0.6.0",
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
      include: ["src", "workflows", "tools", "channels", "hooks"],
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
    // `large` models can reject the structured-output retry's assistant-message
    // prefill; `medium` (sonnet) handles it, so keep structured agents on it.
    "model: medium",
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

function githubTool(): string {
  return [
    `import { defineTool } from "@render-agents/sdk";`,
    "",
    "// Sample tool; real implementations call the GitHub API via ctx.connection(\"github\").",
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
    "    // Stub — wire to the GitHub API in production.",
    "    return `Posted comment: ${body}`;",
    "  },",
    "});",
  ].join("\n");
}

function linearTool(): string {
  return [
    `import { defineMcpSource } from "@render-agents/sdk";`,
    "",
    "// Resolved lazily — only connects when an agent references it.",
    "export default defineMcpSource({",
    `  name: "linear",`,
    `  transport: "http",`,
    `  url: process.env.LINEAR_MCP_URL ?? "http://localhost:8080/mcp",`,
    "});",
  ].join("\n");
}

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

function codeReviewWorkflow(): string {
  return [
    `import { workflow } from "@render-agents/sdk";`,
    "",
    "// Fans out to security + performance reviewers, then a judge decides via a",
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

function githubChannel(): string {
  return [
    `import { githubVerify } from "@render-agents/sdk";`,
    `import type { Channel } from "@render-agents/sdk";`,
    "",
    "// Auto-discovered at POST /channels/github. Inbound channels bypass the operator",
    "// API key — the `verify` HMAC check (GITHUB_WEBHOOK_SECRET) IS the auth, run",
    "// before this channel so `match`/`parse` can trust it. Inbound-only; add",
    "// `deliver` to reply back to GitHub.",
    "const channel: Channel = {",
    `  target: { workflow: "code-review" },`,
    "  verify: githubVerify(), // reads GITHUB_WEBHOOK_SECRET",
    "  match(req: Request) {",
    `    const event = req.headers.get("x-github-event");`,
    `    return event === "pull_request" ? { event } : null;`,
    "  },",
    "  async parse(req: Request) {",
    "    const raw = await req.text();",
    "    const body = JSON.parse(raw) as { pull_request?: { diff_url?: string; number?: number } };",
    "    // NOTE: diff_url is a URL, not the patch — fetch it (with a token) in production.",
    "    return {",
    "      conversationId: `pull-${body.pull_request?.number ?? 0}`,",
    `      input: { diff: body.pull_request?.diff_url ?? "" },`,
    `      target: { workflow: "code-review", trigger: "github.pull_request" },`,
    "    };",
    "  },",
    "};",
    "",
    "export default channel;",
  ].join("\n");
}

function auditHook(): string {
  return [
    `import { defineHook } from "@render-agents/sdk";`,
    "",
    "// Observes (and may transform/veto) matching events before commit.",
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

function serverEntry(): string {
  return [
    `import { loadProject } from "@render-agents/sdk";`,
    `import { startGateway } from "@render-agents/gateway";`,
    "",
    "// loadProject discovers + wires runtime/agents/workflows/channels from the project root.",
    `const root = new URL("..", import.meta.url).pathname;`,
    "",
    "const { runtime, workflows, channels } = await loadProject(root);",
    "",
    "const { port } = await startGateway({",
    "  runtime,",
    "  workflows,",
    "  channels,",
    `  defaultWorkflow: "code-review",`,
    `  defaultAgent: "assistant", // conversational threads`,
    "});",
    "console.log(`gateway listening on :${port}`);",
  ].join("\n");
}

function chatWorkerEntry(): string {
  return [
    "// Chat worker (Lane B): warm process draining run_jobs, driving turns + HITL",
    "// resumes in-process for low latency. Shares the DB; scale horizontally.",
    `import { loadProject, runWorker } from "@render-agents/sdk";`,
    "",
    `const root = new URL("..", import.meta.url).pathname;`,
    "const { runtime } = await loadProject(root);",
    "",
    "const worker = runWorker(runtime);",
    "console.log(`chat worker started (draining run_jobs, ${runtime.agentDefinitions.size} agents)`);",
    "",
    "// Graceful shutdown: finish in-flight turns before exiting.",
    "const shutdown = async () => { await worker.stop(); process.exit(0); };",
    `process.on("SIGTERM", shutdown);`,
    `process.on("SIGINT", shutdown);`,
  ].join("\n");
}

function workflowsHostEntry(): string {
  return [
    "// Workflows host (Lane A): registers plan-tiered Render Workflows tasks for",
    "// the durable lane (workflow@<plan>, agent@<plan>), one pair per plan used.",
    "// Handlers resolve definitions by name; only JSON crosses the task boundary.",
    "// SDK auto-starts the task server when RENDER_SDK_SOCKET_PATH is set; for",
    "// local dev use the Render CLI's local task server + RENDER_USE_LOCAL_DEV=true.",
    `import { task } from "@renderinc/sdk/workflows";`,
    "import {",
    "  loadProject,",
    "  workflowTaskHandler,",
    "  agentTaskHandler,",
    "  computeRequiredPlans,",
    "  RenderWorkflowsDispatcher,",
    `} from "@render-agents/sdk";`,
    `import type { AgentInput, AgentOutput, AgentTaskInput, DispatchOptions } from "@render-agents/sdk";`,
    "",
    `const root = new URL("..", import.meta.url).pathname;`,
    "",
    "// Inside a task container, agent.task() must dispatch over the container's",
    "// local task socket (native subtask), not top-level HTTP — else the parent",
    "// suspends mid-fan-out and the root strands at run.started. Registered",
    "// `agent@<plan>` wrappers route over the socket; captured below. HTTP stays",
    "// as fallback (local dev / outside a task container).",
    "const nativeAgentTasks = new Map<string, (input: AgentTaskInput) => Promise<AgentOutput>>();",
    "",
    "class NativeChainingDispatcher extends RenderWorkflowsDispatcher {",
    "  override async dispatch(agentName: string, input: AgentInput, opts: DispatchOptions): Promise<AgentOutput> {",
    '    const plan = opts.plan ?? "standard";',
    "    const native = nativeAgentTasks.get(plan);",
    "    if (process.env.RENDER_SDK_SOCKET_PATH && native) {",
    "      return native({",
    "        agentName,",
    "        input,",
    "        runId: opts.runId,",
    "        parentSpanId: opts.parentSpanId,",
    "        userId: opts.userId,",
    "        threadId: opts.threadId,",
    "        depth: opts.depth ?? 0,",
    "        idempotencyKey: opts.idempotencyKey,",
    "        cancelScopeId: opts.cancelScopeId,",
    "      });",
    "    }",
    "    return super.dispatch(agentName, input, opts);",
    "  }",
    "}",
    "",
    "// Slug for HTTP fallback only; provisioned as RENDER_WORKFLOW_SLUG in render.yaml.",
    'const dispatcher = new NativeChainingDispatcher({ workflowSlug: process.env.RENDER_WORKFLOW_SLUG ?? "default" });',
    "const { runtime, workflows } = await loadProject(root, { runtime: { dispatcher } });",
    "",
    "const getDefinition = (name: string) => runtime.agentDefinitions.get(name);",
    "",
    "// One task per referenced plan tier (Render binds compute at task-definition",
    "// time); keep each agent@<plan> wrapper for native subtask invocation.",
    "const plans = computeRequiredPlans([...runtime.agentDefinitions.values()]);",
    "for (const plan of plans) {",
    "  const agentTask = task(",
    "    { name: `agent@${plan}`, plan },",
    "    (input: Parameters<typeof agentTaskHandler>[0]) => agentTaskHandler(input, runtime, getDefinition),",
    "  );",
    "  nativeAgentTasks.set(plan, agentTask as (input: AgentTaskInput) => Promise<AgentOutput>);",
    "  task(",
    "    { name: `workflow@${plan}`, plan },",
    "    (args: Parameters<typeof workflowTaskHandler>[0]) => workflowTaskHandler(args, workflows),",
    "  );",
    "}",
    "",
    "const taskNames = plans.flatMap((p) => [`agent@${p}`, `workflow@${p}`]).join(\", \");",
    "",
    "// In a Render Workflows environment, the SDK auto-starts the task server and",
    "// keeps the process alive serving runs — nothing else to do here.",
    "const underRenderRuntime = !!(process.env.RENDER_SDK_SOCKET_PATH || process.env.RENDER_USE_LOCAL_DEV);",
    "if (underRenderRuntime) {",
    "  console.log(`workflows host serving Render Workflows tasks: ${taskNames}`);",
    "} else {",
    "  // No Render runtime: stay up idle for the demo. Interval keeps the event",
    "  // loop alive (avoids Node exiting on an unsettled top-level await).",
    "  console.log(",
    "    `workflows host ready (idle; no Render Workflows runtime — set RENDER_USE_LOCAL_DEV or run under \\`render workflows dev\\`). ` +",
    "      `${runtime.agentDefinitions.size} agents, ${workflows.size} workflows, tasks: ${taskNames}`,",
    "  );",
    "  const keepAlive = setInterval(() => {}, 1 << 30);",
    "  const shutdown = (): void => {",
    "    clearInterval(keepAlive);",
    "    process.exit(0);",
    "  };",
    `  process.on("SIGTERM", shutdown);`,
    `  process.on("SIGINT", shutdown);`,
    "}",
  ].join("\n");
}

function renderYaml(opts: ScaffoldOptions): string {
  const build = `${pmInstall(opts.packageManager)} && ${pmRun(opts.packageManager, "build")}`;
  const run = (script: string) => pmRun(opts.packageManager, script);
  return [
    "# Two-lane deployment: gateway (web, triggers both lanes), chat-worker (warm,",
    "# drains run_jobs), workflows (Render Workflows host, Lane A), plus Postgres",
    "# + retention/schedule crons. See the @render-agents docs.",
    "databases:",
    `  - name: ${opts.name}-db`,
    "    plan: basic-256mb",
    "",
    "services:",
    "  - type: web",
    `    name: ${opts.name}-gateway`,
    "    runtime: node",
    "    plan: starter",
    `    buildCommand: ${build}`,
    `    startCommand: ${run("start")}`,
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
    // Routes runs through the durable queue so the warm chat worker drives them, not the gateway inline.
    "      - key: RENDER_AGENTS_EXECUTION_MODE",
    "        value: queue",
    // Dispatcher auto-selects the workflow lane only when both vars are set;
    // RENDER_API_KEY left sync:false so it falls back in-process until pasted.
    "      - key: RENDER_API_KEY",
    "        sync: false",
    "      - key: RENDER_WORKFLOW_SLUG",
    `        value: ${opts.name}-workflows`,
    `      - key: ${opts.apiKeyEnv}`,
    "        sync: false",
    "",
    "  # Chat lane (Lane B): warm worker draining run_jobs. Scale via numInstances.",
    "  - type: worker",
    `    name: ${opts.name}-chat-worker`,
    "    runtime: node",
    "    plan: starter",
    `    buildCommand: ${build}`,
    `    startCommand: ${run("worker")}`,
    "    envVars:",
    "      - key: DATABASE_URL",
    "        fromDatabase:",
    `          name: ${opts.name}-db`,
    "          property: connectionString",
    "      # Must match the gateway's key: all lanes share one Postgres/OAuth-token encryption.",
    "      - key: RENDER_AGENTS_ENCRYPTION_KEY",
    `        fromService: { type: web, name: ${opts.name}-gateway, envVarKey: RENDER_AGENTS_ENCRYPTION_KEY }`,
    `      - key: ${opts.apiKeyEnv}`,
    "        sync: false",
    "",
    "  # Workflow lane (Lane A): Render Workflows host; registers workflow@<plan> +",
    "  # agent@<plan> tasks; Render provisions isolated, scale-to-zero containers.",
    "  - type: worker",
    `    name: ${opts.name}-workflows`,
    "    runtime: node",
    "    plan: starter",
    `    buildCommand: ${build}`,
    `    startCommand: ${run("workflows")}`,
    "    envVars:",
    "      - key: DATABASE_URL",
    "        fromDatabase:",
    `          name: ${opts.name}-db`,
    "          property: connectionString",
    "      # Must match the gateway's key: all lanes share one Postgres/OAuth-token encryption.",
    "      - key: RENDER_AGENTS_ENCRYPTION_KEY",
    `        fromService: { type: web, name: ${opts.name}-gateway, envVarKey: RENDER_AGENTS_ENCRYPTION_KEY }`,
    `      - key: ${opts.apiKeyEnv}`,
    "        sync: false",
    "",
    "  # Daily retention cleanup (trims event-detail + old run summaries).",
    "  - type: cron",
    `    name: ${opts.name}-retention`,
    "    runtime: node",
    "    plan: starter",
    `    schedule: "0 4 * * *"`,
    `    buildCommand: ${build}`,
    `    startCommand: 'curl -fsS -X POST "$GATEWAY_URL/admin/retention" -H "Authorization: Bearer $RENDER_AGENTS_API_KEY"'`,
    "    envVars:",
    "      - key: GATEWAY_URL",
    `        fromService: { type: web, name: ${opts.name}-gateway, property: hostport }`,
    "      - key: RENDER_AGENTS_API_KEY",
    `        fromService: { type: web, name: ${opts.name}-gateway, envVarKey: RENDER_AGENTS_API_KEY }`,
    "",
    "  # Per-minute tick firing due runtime-managed schedules (POST /schedules).",
    "  # Remove if you only trigger via webhooks/HTTP API.",
    "  - type: cron",
    `    name: ${opts.name}-schedules`,
    "    runtime: node",
    "    plan: starter",
    `    schedule: "* * * * *"`,
    `    buildCommand: ${build}`,
    `    startCommand: 'curl -fsS -X POST "$GATEWAY_URL/admin/schedules/tick" -H "Authorization: Bearer $RENDER_AGENTS_API_KEY"'`,
    "    envVars:",
    "      - key: GATEWAY_URL",
    `        fromService: { type: web, name: ${opts.name}-gateway, property: hostport }`,
    "      - key: RENDER_AGENTS_API_KEY",
    `        fromService: { type: web, name: ${opts.name}-gateway, envVarKey: RENDER_AGENTS_API_KEY }`,
    "",
    "  # Stranded-run reaper: fails Lane A roots whose workflows hand-off never",
    "  # progressed, so they don't sit `running` forever (RENDER_AGENTS_RUN_STALE_MS).",
    "  - type: cron",
    `    name: ${opts.name}-reaper`,
    "    runtime: node",
    "    plan: starter",
    `    schedule: "*/5 * * * *"`,
    `    buildCommand: ${build}`,
    `    startCommand: 'curl -fsS -X POST "$GATEWAY_URL/admin/runs/reap" -H "Authorization: Bearer $RENDER_AGENTS_API_KEY"'`,
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

function dockerfile(opts: ScaffoldOptions): string {
  const pm = opts.packageManager;
  // JSON-array CMD honoring the chosen package manager (npm needs `run`) (CR-29).
  const startCmd = pm === "npm" ? '["npm", "run", "start"]' : `["${pm}", "start"]`;
  const corepack = pm === "npm" ? "" : "RUN corepack enable\n";
  return [
    "# App image: runs the gateway from source via tsx (agents/skills are markdown,",
    "# so the project root stays the discovery root — same as production on Render).",
    "FROM node:20-slim",
    "WORKDIR /app",
    "",
    corepack + "# Install deps first for layer caching (supports npm/pnpm/yarn lockfiles).",
    "COPY package.json ./",
    "COPY package-lock.json* pnpm-lock.yaml* yarn.lock* ./",
    `RUN ${pmInstall(pm)}`,
    "",
    "COPY . .",
    "ENV PORT=3000",
    "EXPOSE 3000",
    `CMD ${startCmd}`,
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
    "  # Optional: the warm chat worker (Lane B). Locally the gateway drives chat",
    "  # turns in-process, so this only mirrors the production queue split. Enable:",
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
    "Commit and create a Blueprint from `render.yaml`. It provisions the two-lane",
    "topology: a **gateway** (web front door + SSE), a warm **chat-worker** (drains",
    "the Postgres queue, drives interactive turns), a **workflows** host (Render",
    "Workflows for durable pipelines), and Postgres + retention/schedule crons.",
    "",
    "## Layout",
    "",
    "- `agents/` — markdown agents (`_shared.md` holds defaults)",
    "- `tools/` — local + MCP tool sources",
    "- `skills/` — progressive-disclosure skill docs",
    "- `workflows/` — orchestration (`code-review`)",
    "- `channels/`, `hooks/` — message surfaces + event middleware",
    "- `src/server.ts` — gateway (web) entrypoint",
    "- `src/worker.ts` — chat worker (drains the run queue, drives interactive turns)",
    "- `src/workflows.ts` — Render Workflows host (durable pipelines)",
  ].join("\n");
}
