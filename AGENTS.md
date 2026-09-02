# Repository guide for agents

This file applies to the entire repository.

## What this is

`render-factory` turns a labeled GitHub issue into a reviewed draft pull
request. It is a reference architecture for Render Workflows, Sandboxes,
Postgres, and Web Services — optimized to be read, not to be a framework.

The path is: a maintainer labels an issue, the gateway validates the webhook
and dispatches an issue number, and a workflow triages, analyzes, implements,
verifies, reviews, and opens a draft PR from an isolated sandbox.

Two processes deploy independently:

- `app/src/server.ts` — Hono gateway web service.
- `app/src/workflows.ts` — Render Workflows host and task registration.

The gateway runs no models and holds no repository token. Agents never write
to GitHub. Repository execution happens in a Render Sandbox.

## Quick start

Requires Node 22+, Docker for local Postgres, the Render CLI for
`dev:workflows`, and Render, GitHub, and Anthropic credentials.

```bash
npm ci
cp .env.example .env   # then fill it in
```

Run each in its own terminal:

```bash
npm run dev:postgres
npm run db:migrate
npm run dev:gateway
npm run dev:workflows
```

The gateway listens on `0.0.0.0:${PORT:-3000}`. `GET /health` is liveness,
`GET /ready` checks Postgres and is the Render health-check target, and
webhooks arrive at `POST /webhooks/github`. Local workflow runs create real
Render Sandboxes.

Verify a change with `npm run check` (Biome, `tsc`, Vitest). For one file:
`npx vitest run tests/gateway.test.ts`. Validate the Blueprint with
`render blueprints validate` when `render.yaml` changes.

## Repository map

Each directory under `app/` is one module with an `index.ts` barrel. Import
across modules through the barrel (`../git/index.js`), never by reaching into
a sibling file. There is no SDK layer and no path aliases — imports are
relative with `.js` extensions (NodeNext).

The dependency direction is one-way:

```text
sandbox → tools → claude → agents → tasks → workflows
```

`policy` is imported by `claude` and `github`. `shell`, `config`, `contracts`,
and `format` are leaves — `shell` in particular is depended on by `sandbox`,
`tools`, and `git`, which is why it is not inside any of them. Adding an edge
that points backwards is a design smell.

A barrel exports what other modules actually use. If a symbol is only used
inside its own module, keep it out of `index.ts`.

```text
factory.config.ts   Repo dir, verify commands, model tiers, actors
app/
  config/           Environment parsing and per-process validation
  gateway/          Signature, body cap, filters, dispatch, health
  workflows/        One directory per workflow; manifest in index.ts
  contracts/        Zod schemas for workflow input and agent output
  agents/           One file per agent, plus the shared reviewer contract
  tasks/            agentTask() and the eight registrations
  claude/           The Agent type and runClaude() over the Claude Agent SDK
  tools/            The six sandbox tools and the Tool contract
  policy/           checkToolCall, path rules, secret redaction
  sandbox/          Render Sandboxes
  shell/            shellEscape — quoting for every command we build
  git/              Clone, commit, diff, verify, push — all workflow-owned
  github/           REST client, plus App/PAT credential resolution
  format/           Issue to work item; results to GitHub markdown
  store/            Postgres: one runs table
  sql/              Schema, applied by scripts/migrate.ts
  src/              Process entrypoints
tests/              agents, contracts, gateway, github-auth, policy,
                    shell, tools, workflow
```

Keep `index.ts` thin: re-exports, plus the few lines that wire a module
together when that wiring is the module's whole point (`app/tasks/index.ts`
instantiates the eight agent tasks). Everything else belongs in a sibling file
so a reader can see the module's surface at a glance.

## Conventions

- Strict TypeScript, ESM, NodeNext. Include `.js` in relative imports.
- Validate external and workflow input with Zod before use.
- Use `md` for dedented multi-line prompts.
- Escape shell arguments with `shellEscape`; use `execGitWithToken` for
  authenticated Git.
- Keep dispatch payloads small and JSON-serializable.
- Comments explain intent and constraints, not what the next line does.
- Add or update tests with behavior changes. Never call live Render, GitHub,
  Postgres, or model APIs from tests.

## Invariants

Do not weaken these without an explicit security-model change:

- One deployment is bound to one validated `FACTORY_REPO`.
- Only `issues.labeled` from an allowed human actor starts a run.
- The webhook signature is verified before the body is parsed.
- Agents receive only the tools listed in their definition. Claude's built-in
  `Bash`, `Read`, `Write`, and `Edit` are never granted — `claude.ts` always
  passes `tools: []` for built-ins.
- Analysis gets read-only tools; only the implementer gets write and exec.
- `sandboxId` comes from workflow code, never from the model.
- Git pushes, labels, sandbox lifecycle, and PR creation stay in workflow code.
- The trigger label is removed only on a terminal result, never on a thrown
  error — a retry re-reads the issue and needs the label still there.
- `factory:` status labels are cosmetic and never fail a run.
- Resolve GitHub credentials through `githubToken()`, which returns a GitHub
  App installation token when the `GITHUB_APP_*` trio is set and falls back to
  `GITHUB_TOKEN`. Never read `GITHUB_TOKEN` directly.
- The sandbox is terminated in a `finally` block.
- `verifyPush` confirms the remote matches the reviewed commit before a PR opens.
- Automation stops at a draft PR. It never marks ready or merges.
- Render filesystems are ephemeral. Cross-process state goes in Postgres.

## Durability

There is no step memoization. A failed run is not resumed; the maintainer
retries by reapplying the label. Postgres enforces two things through unique
constraints rather than application code: `runs.delivery_id` is unique, so a
redelivered webhook cannot start a second run, and a partial unique index
allows only one run per issue while its status is `running`.

If you add resumability, `ctx.step()` from Render Workflows' Durability 2.0
API is the seam. Do not rebuild a checkpoint store here.

## Add an agent

1. Create `app/agents/<name>.ts` and export it from `app/agents/index.ts`.
   `id`, `model`, and `prompt` are required; `id` is also the registered task
   name, so keep it unique and stable. Give it `tools` only if it needs the
   sandbox.
2. Wrap it in `app/tasks/index.ts` with `agentTask()`.
3. Call it from the relevant stage in `app/workflows/spec-to-pr/`. Pass
   `sandboxId: sandbox.id` only when it declares tools.
4. If it emits JSON, add a schema under `app/contracts/` and call it through
   `agentJson()`, which retries once and then fails closed.
5. Update `tests/agents.test.ts` for tool access.

## Change the pipeline

`app/workflows/spec-to-pr/index.ts` holds the linear narrative; the modules
beside it hold individual stages (`intake`, `implement`, `review`, `outcome`).
Keep the narrative readable — a new stage should read as one call, with its
detail in a sibling file.

Fetch large state inside the workflow rather than passing it through dispatch,
resolve GitHub side effects through `app/github`, and keep repeated execution
safe — issue comments carry stable operation IDs so a retry does not duplicate
them.

## Add a workflow

1. Create `app/workflows/<name>/index.ts` with the `task(...)` definition and
   the pipeline narrative. Put stages in sibling files.
2. Export it from `app/workflows/index.ts`. That is what registers it —
   `app/src/workflows.ts` imports the manifest, nothing else is needed.
3. Handlers accept `unknown` and parse it immediately with a Zod schema from
   `app/contracts/`, return JSON-serializable values, and wrap sandbox
   lifecycle in `try/finally`.
4. To trigger it from GitHub, dispatch by task name from `app/gateway/`. The
   string must match `task({ name })` exactly; Render addresses it as
   `${RENDER_WORKFLOW_SLUG}/${name}`.
5. A new public route needs the same HMAC, body limit, repository, label,
   actor, and bot filters the existing one has.

Helpers shared by more than one workflow go at the `app/workflows/` top level
(`agent-json.ts` is the current example), not inside a workflow directory.

## Checklist

1. Trust boundaries between gateway, workflow, and agents are preserved.
2. New agents and workflows are registered through the existing imports.
3. Task names match between definition, dispatch, and tests.
4. New external input is validated and task values stay JSON-serializable.
5. Sandbox cleanup and repeated side effects are safe.
6. `.env.example`, `render.yaml`, and `README.md` updated if config changed.
7. `npm run check` passes.
