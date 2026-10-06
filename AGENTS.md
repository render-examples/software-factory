# Repository guide for agents

This file applies to the entire repository.

## What this is

`render-factory` turns a labeled GitHub issue into a reviewed draft pull
request through three chained workflows — Triage, Spec-to-PR, and PR
Reviewer. It is a reference architecture for Render Workflows, Sandboxes,
Postgres, and Web Services — optimized to be read, not to be a framework.

Three phases chain through GitHub:

1. A maintainer labels an issue. The gateway validates the webhook, records
   a delivery, and creates a queued run.
2. The dispatcher polls queued runs and starts Workflow tasks.
3. The workflow claims the run, checks the actor's live permission, runs
   its phase, and posts the result. Triage posts questions or a spec.
   Spec-to-PR opens a draft PR. PR Reviewer posts a COMMENT review.
4. The human's response (a reply, an approval label, a review label) starts
   the next workflow. A full run chains all three automatically.

Five processes deploy independently:

- `app/src/server.ts` — Hono gateway web service.
- `app/src/dispatcher.ts` — Background Worker polling queued runs.
- `app/src/workflows.ts` — Render Workflows host and task registration.
- `app/src/maintenance.ts` — Cron job for workspace snapshots, sandbox reaping, dispatch, and artifact maintenance.
- `app/sql/` — Schema, applied by the gateway's pre-deploy command.

The gateway runs no models, holds no Render API key, and holds no
repository token. Agents never write to GitHub. Repository execution
happens in Render Sandboxes.

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
npm run dev:dispatcher
```

The gateway listens on `0.0.0.0:${PORT:-3000}`. `GET /health` is liveness,
`GET /ready` checks Postgres and is the Render health-check target, and
webhooks arrive at `POST /webhooks/github`. Local workflow runs create real
Render Sandboxes.

Verify a change with `npm run check` (Biome, `tsc`, Vitest). For one file:
`npx vitest run tests/gateway.test.ts`. Validate the Blueprint with
`render blueprints validate` when `render.yaml` changes.

`npm run doctor` diagnoses a live deployment and is read-only. When you add a
required environment variable, a task name, or a schema object, add a check for
it there — that script is where setup mistakes get caught.

## Module map

Each directory under `app/` is one module with an `index.ts` barrel. Import
across modules through the barrel (`../git/index.js`), never by reaching into
a sibling file. There is no SDK layer and no path aliases — imports are
relative with `.js` extensions (NodeNext).

The dependency direction is one-way:

```text
sandbox → tools → runners → agents → tasks → workflows
```

`workspaces` and `publish` are used by `workflows`. `policy` is imported by
`runners` and `github`. `shell`, `config`, `contracts`, and `format` are
leaves — `shell` in particular is depended on by `sandbox`, `tools`, and
`git`, which is why it is not inside any of them. Adding an edge that points
backwards is a design smell.

A barrel exports what other modules actually use. If a symbol is only used
inside its own module, keep it out of `index.ts`.

```text
factory.config.ts       Repository targets, labels, models, sandbox settings, limits, pricing
app/
  config/               Environment parsing, per-process assertions, config validation
  gateway/              Signature, body cap, filters, webhook routing, health, read API, trace UI, artifacts
  dispatcher/           Poll loop: claim queued runs, start workflow tasks
  workflows/            One directory per workflow; lifecycle.ts handles claiming, heartbeat,
                        permission checks, terminal comments, label removal
    lifecycle.ts        runWorkflow() — the shared lifecycle every workflow uses
    labels.ts           Status label helpers shared by all workflows
    agent-json.ts       Structured output with fail-closed retry
    triage/             Triage workflow: assess, draft spec, ask questions, decline
    spec-to-pr/         Spec-to-PR: implement, verify, self-review, publish, open PR
    pr-review/          PR Reviewer: verify, specialists, local dev, preview, synthesize, submit
  contracts/            Zod schemas for workflow input, agent output, spec, UX results
  agents/               One file per agent; types.ts defines the Agent interface
    reviewers/          Specialist reviewers (security, correctness, performance, tests),
                        synthesizer, ux-tester, and the registry
  tasks/                agentTask() wraps agents as Workflow tasks; budget checks; cost events
  runners/              AgentRunner interface, Claude runner, OpenAI runner
  tools/                Sandbox tools: read, write, exec, search, patch, browser
    browser/            Browser tools for UX testing in sandboxes
  policy/               checkToolCall (PreToolUse), path rules, secret redaction, browser origin allowlist
  sandbox/              Render Sandbox adapter (create, exec, upload, download, terminate)
  workspaces/           Per-run sandboxes: create from snapshot, verify, close; maintenance
    snapshot.ts         ensureSnapshot() — advisory-locked builder→snapshot→record flow
    workspace.ts        openWorkspace(runId, ref), closeWorkspace(runId)
    reap.ts             Reap stale sandboxes (terminal runs, expired, stuck, stale builders)
  publish/              Git Data API publishing: collect changes, transfer, create objects, verify tree
  preview/              Preview environment locator (Render API)
  shell/                shellEscape — quoting for every command we build
  git/                  Clone, branch, commit, diff, verify — all workflow-owned
  github/               REST client, App auth, Git Data calls, pulls, reviews
  format/               Issue to work item; results to GitHub markdown; spec rendering
  store/                Postgres: runs, deliveries, events, specs, sandboxes, artifacts, costs
  sql/                  Schema migrations, applied by scripts/migrate.ts
  telemetry/            Event emission and span helpers over run_events
  src/                  Process entry points
scripts/                migrate, doctor, setup-github, create-github-app, eval
evals/cases/            Eval case definitions (JSON)
tests/                  Unit tests (no live services)
```

Keep `index.ts` thin: re-exports, plus the few lines that wire a module
together when that wiring is the module's whole point (`app/tasks/index.ts`
instantiates the agent tasks). Everything else belongs in a sibling file
so a reader can see the module's surface at a glance.

## Conventions

- Strict TypeScript, ESM, NodeNext. Include `.js` in relative imports.
- Validate external and workflow input with Zod before use.
- Use `md` for dedented multi-line prompts.
- Escape shell arguments with `shellEscape`; use credential helpers in
  `workspaces/credentials.ts` for authenticated Git.
- Keep dispatch payloads small and JSON-serializable.
- Comments explain intent and constraints, not what the next line does.
- Add or update tests with behavior changes. Never call live Render, GitHub,
  Postgres, or model APIs from tests.

## Invariants

Do not weaken these without an explicit security-model change:

1. The gateway verifies the webhook signature before it parses the body. It
   holds only the database URL, the webhook secret, and the admin token.
2. Only the dispatcher starts workflow tasks. Workflow inputs are `{ runId }`.
3. Every run checks the triggering actor's live repository permission before
   doing any work.
4. Only workflow code writes to GitHub, and every write looks up its marker
   before creating anything.
5. Model credentials never enter a sandbox. A GitHub token is present in a
   sandbox only during clone or fetch; it is read-only and scrubbed before
   any agent or PR code runs.
6. Agents receive only the tool sets they compose. Built-in runner tools are
   disabled, and each agent's tool list is pinned by a test.
7. Models never choose sandbox IDs, paths outside the checkout, branches,
   GitHub targets, or task names.
8. A PR opens only after GitHub's tree SHA equals the verified local tree.
9. Automation ends at a draft PR and a COMMENT review. It never approves,
   never requests changes, never marks a PR ready, and never merges.
10. Spec-to-PR implements exactly the spec version that was current when the
    approval label was applied.
11. At most one non-terminal run exists per subject.
12. Sandboxes are terminated in `finally`. Maintenance only terminates sandboxes
    recorded in `sandboxes`.
13. Cross-process state lives in Postgres. Render filesystems are ephemeral.

## Recipes

### Add a specialist reviewer

1. Create `app/agents/reviewers/<name>-reviewer.ts`. Export a function that
   returns an `Agent` with `id: "<name>"`, `model: "medium"`, and
   `tools: [...readTools]`. Its prompt should describe what to look for and
   return findings with file, line, severity, confidence, and evidence.
2. Export the agent from `app/agents/reviewers/index.ts`.
3. Register it in `app/agents/reviewers/registry.ts` so `resolveSpecialists`
   can find it by name.
4. Add the name to `review.specialists` in `factory.config.ts`.
5. Add the agent to the tool-access test in `tests/agents.test.ts`.

### Add an agent

1. Create `app/agents/<name>.ts` and export it from `app/agents/index.ts`.
   `id`, `model`, and `prompt` are required; `id` is also the registered task
   name, so keep it unique and stable. Give it `tools` only if it needs the
   sandbox.
2. Wrap it in `app/tasks/index.ts` with `agentTask()`.
3. Call it from the relevant stage in the workflow. Pass
   `sandboxId: sandbox.id` only when it declares tools.
4. If it emits JSON, add a schema under `app/contracts/` and call it through
   `agentJson()`, which retries once and then fails closed.
5. Update `tests/agents.test.ts` for tool access.

### Add a workflow

1. Create `app/workflows/<name>/index.ts` using `runWorkflow(name, options, handler)`.
   The lifecycle handles claiming, heartbeating, permission checks, deferred
   cleanup, terminal comments, and label removal. Your handler receives a
   `LifecycleContext` with `stage()`, `throwIfCancelled()`, `defer()`, and
   the GitHub client.
2. Put stages in sibling files. Keep the narrative in `index.ts` readable.
3. Export the workflow from `app/workflows/index.ts`. That registers it —
   `app/src/workflows.ts` imports the manifest, nothing else is needed.
4. To trigger it from GitHub, route the label or event in `app/gateway/webhook.ts`.
   The delivery creates a queued run with the workflow name matching the
   `runWorkflow` registration. The dispatcher starts it as
   `${RENDER_WORKFLOW_SLUG}/${name}`.
5. Return a `LifecycleResult` with status, outcome, optional comment, optional
   follow-up run, and labels to remove.
6. A new route needs the same HMAC, body limit, repository, and bot filters.

### Add a runner

1. Implement the `AgentRunner` interface in `app/runners/<name>.ts`.
   - Disable every built-in tool.
   - Expose only the tools bound to the agent.
   - Run `checkToolCall` before every tool call.
   - Return token usage (including cache tokens) from the provider's response.
2. Export from `app/runners/index.ts`.
3. Add the runner name to `RunnerName` in `factory.config.ts` and configure
   model IDs under `agents.models.<name>`.
4. Update `tests/runners.test.ts`.

### Add a tool or tool set

1. Create the tool in `app/tools/<name>.ts` implementing the `Tool` interface.
2. Export from `app/tools/index.ts`.
3. Add it to the appropriate set in `app/tools/sets.ts` (`readTools`,
   `writeTools`, `execTools`), or compose it into an agent's `tools` array
   directly.
4. If the tool needs policy enforcement, add patterns to `app/policy/rules.ts`
   or path checks to `app/policy/paths.ts`.
5. Update `tests/tools.test.ts` and `tests/agents.test.ts`.

### Change verification commands

Edit `repos[0].verify` in `factory.config.ts`. These run in the sandbox during
Spec-to-PR (with repair rounds) and PR Reviewer (as evidence). An empty list
removes verification — a warning is printed during config validation.

## Checklist

1. Trust boundaries between gateway, dispatcher, workflows, maintenance, and
   agents are preserved.
2. New agents and workflows are registered through the existing imports.
3. Task names match between definition, dispatch, and tests.
4. New external input is validated and task values stay JSON-serializable.
5. Sandbox cleanup and repeated side effects are safe.
6. `.env.example`, `render.yaml`, and `README.md` updated if config changed.
7. `npm run check` passes.
