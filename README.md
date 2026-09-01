# render-factory

A self-hosted fork-and-deploy software factory built on Render. Turn a labeled GitHub issue into a reviewed draft pull request using durable workflows and isolated coding agents.

[Get started](#get-started) · [How it works](#how-it-works) ·
[Architecture](#architecture) · [Deploy](#deploy-to-render) ·
[Customize](#customize) · [Safety](#safety-boundaries)

## Who it is for

render-factory is for engineering and platform teams that want to create and
customize cloud agent workflows, with a focus on coding agents.

Use this repo as a foundation for your own software factory: extend with
more agents, workflow stages, authenticated intake channels, review and follow-up
loops, provider integrations, and organization-specific approval policies.

### Bring your own agents

Bring your own agents, tools, and policies. AgentRunner and ToolSource provide extension points for custom runtimes and integrations.

The factory supplies the operational foundation around those agents:

- **Own the infrastructure.** Execution, credentials, and durable state remain
  in your Render workspace.
- **Run agents safely.** Isolated sandboxes and least-privilege tool access
  constrain each agent.
- **Recover cleanly.** Checkpoints, retries, deduplication, and idempotent side
  effects support unattended execution.
- **Gate quality.** Parallel specialist reviews inspect changes before any
  branch is pushed.
- **Extend the workflow.** Add intake channels, specialized agents, providers,
  review policies, and follow-up automation without rebuilding the
  orchestration layer.

## How it works

1. Configure one `FACTORY_REPO=owner/repo`.
2. A maintainer listed in `FACTORY_GITHUB_ACTORS` applies `FACTORY_LABEL`.
3. The gateway verifies the GitHub signature, repository, actor, action, and
   label. It atomically claims the delivery and issue, then dispatches only
   the issue number and a logical run ID.
4. The workflow fetches authoritative issue and comment state from GitHub.
5. Triage decides whether the issue has enough detail, and the workflow
   removes the intake label as acknowledgment. If clarification is needed, it
   comments and stops.
6. Accepted work gets an isolated sandbox and deterministic `factory/` branch.
7. The analyst researches the checkout and prepares a grounded plan.
8. The implementer edits the checkout. It does not run verification itself.
9. When `factory.config.ts` defines `verify` commands, the workflow runs them
   deterministically in the sandbox. On failure, the output is fed back to the
   implementer for up to three fix rounds.
10. A lightweight self-review catches debug artifacts, broken imports, and
    obvious mistakes; fixes are applied automatically if found.
11. Security, correctness, and test reviewers inspect the complete staged diff
    in parallel; a judge synthesizes their findings.
12. One requested revision may run through implementation and review again.
13. Only an approved revision is pushed. Workflow code verifies the remote
    SHA and opens a draft pull request.

Every run and stage transition is recorded through a backend-neutral RunStore.
The production adapter uses Postgres for ordered events, replay checkpoints,
leases, artifacts, and current-state projections. Automatic task retries
reconnect to the same sandbox and branch instead of starting duplicate work.
The sandbox is terminated only after the workflow reaches a terminal result.

If clarification or a retry is needed, a maintainer reapplies the label.

## Architecture

```text
GitHub issues.labeled
  │
  ▼
Gateway web service
  ├─ verifies HMAC
  ├─ matches FACTORY_REPO + FACTORY_LABEL
  ├─ checks FACTORY_GITHUB_ACTORS
  ├─ deduplicates delivery + leases issue
  └─ creates a run + dispatches { issueNumber, runId }
  │
  ▼
Render Workflows
  ├─ triage
  ├─ analyst ───────────────┐
  ├─ implementer            │ one Render Sandbox
  ├─ verify (deterministic) │
  ├─ self-review + fix      │
  ├─ security ┐             │
  ├─ correctness ├ parallel │
  ├─ tests ────┘            │
  ├─ judge                  │
  └─ draft pull request ◀───┘

Render Postgres
  ├─ generic workflow, task, and agent runs
  ├─ ordered run events and replay checkpoints
  ├─ delivery deduplication and fenced leases
  └─ oversized workflow handoff artifacts
```

## Project structure

```text
app/
  agents/          Agent definitions and prompts
  tasks/           Agent definitions wrapped as workflow tasks
  workflows/       Durable orchestration (spec-to-pr pipeline)
  gateway/         HTTP intake, validation, and dispatch
  hooks/           Audit, cost tracking, destructive-action block, secret redaction
  lib/             GitHub, config, convention memory, sandbox Git helpers
  src/             Gateway and Workflows entrypoints
  tests/           Application and integration tests
sdk/
  runners/         Model runner implementations
  sandbox/         Sandbox provider interfaces and implementations
  tests/           SDK tests
store/
  contracts.ts     Backend-neutral store interfaces
  memory.ts        In-memory adapter (test reference)
  postgres/        Production Postgres adapter, pool, and migrations
  sql/             Immutable schema migrations
  tests/           Backend conformance suites
scripts/           Doctor, migration, retention, and run-status CLI tools
factory.config.ts  Verification commands for the target repository
render.yaml        Gateway, Postgres, and retention-cron Blueprint
Dockerfile         Gateway image
docker-compose.yml Local Postgres
```

The repository deploys as two independent processes: the public Hono gateway
at `app/src/server.ts` and the task-registration host at
`app/src/workflows.ts`. The gateway runs no models and holds no repository
credential. Workflow code owns GitHub writes and sandbox lifecycle; agents
receive only the sandbox operations required for their role.

`GET /health` reports process liveness. `GET /ready` checks Postgres and schema
readiness and is the deployed gateway health check.

## Get started

### Prerequisites

For a full end-to-end run you need:

- Node.js 22 or newer and npm
- Docker for the local Postgres service
- The Render CLI, installed and authenticated
- A Render workspace with access to Workflows and Sandboxes
- An Anthropic API key
- A GitHub repository and fine-grained token

### Install and configure

```bash
git clone https://github.com/<you>/render-factory.git
cd render-factory
npm ci
cp .env.example .env
```

Fill in `.env` using the [configuration reference](#configuration). Start and
migrate Postgres first:

```bash
npm run dev:postgres
npm run db:migrate
```

Then run each process in a separate terminal:

- Gateway on `http://localhost:3000`: `npm run dev:gateway`
- Render Workflows host: `npm run dev:workflows`

`dev:workflows` requires the authenticated Render CLI. Local workflow runs
still create real Render Sandboxes; they do not execute repository code on
your development machine.

With Postgres running and `.env` filled in, verify configuration, GitHub
access, and local task registration:

```bash
npm run doctor
```

### Connect GitHub and run the factory

Configure a GitHub webhook for `issues` events at:

```text
https://<gateway-host>/channels/github
```

Use the same secret as `GITHUB_WEBHOOK_SECRET`. A gateway running only on
localhost needs a publicly reachable HTTPS tunnel before GitHub can deliver
webhooks to it.

Create the configured label—`factory` by default—and apply it to an issue as a
login listed in `FACTORY_GITHUB_ACTORS`. Applying that label is the only way
to start work; comments and other issue events do not trigger the factory.

Scope the GitHub token only to `FACTORY_REPO`, grant the minimum Contents,
Issues, and Pull Requests permissions needed to create a feature branch,
comment, and open a draft PR, and protect the default branch.

## Configuration

| Variable | Service | Purpose |
|---|---|---|
| `FACTORY_REPO` | Both | The only repository the factory can operate on |
| `FACTORY_LABEL` | Both | Intake label; defaults to `factory` |
| `FACTORY_GITHUB_ACTORS` | Gateway | Comma-separated GitHub logins allowed to apply the label |
| `GITHUB_WEBHOOK_SECRET` | Gateway | HMAC secret; use at least 32 random characters |
| `RENDER_WORKFLOW_SLUG` | Gateway | Deployed Workflows service slug, without a task name |
| `DATABASE_URL` | Both | Postgres connection string for runs, events, checkpoints, leases, and artifacts |
| `FACTORY_DB_POOL_MAX` | Both | Optional per-process Postgres pool maximum; defaults to `2` |
| `FACTORY_EVENT_RETENTION_DAYS` | Retention cron | Optional event-detail retention; defaults to `30` |
| `FACTORY_RUN_RETENTION_DAYS` | Retention cron | Optional run-summary retention; defaults to `90` |
| `ANTHROPIC_API_KEY` | Workflows | Claude Agent SDK credential |
| `GITHUB_TOKEN` | Workflows | Fine-grained token scoped to `FACTORY_REPO` |
| `RENDER_API_KEY` | Workflows | Render SDK and Sandbox credential |
| `RENDER_WORKSPACE_ID` | Workflows | Workspace in which sandboxes are created |
| `PORT` | Gateway | Optional HTTP port; defaults to `3000` |

Both processes must use the same `FACTORY_REPO`, `FACTORY_LABEL`, and Postgres
database. `DATABASE_URL` points to local Docker in `.env.example`; the gateway
Blueprint wires its production value automatically.

Development scripts load `.env`. The production commands
`npm run start:gateway` and `npm run start:workflows` do not; supply their
environment through Render or the process environment.


## Deploy to Render

1. Fork this repository.
2. Create a Blueprint from `render.yaml`. It provisions:
   - `render-factory-gateway`
   - `render-factory-db`
   - `render-factory-retention`
3. Set the unsynced gateway variables listed in
   [Configuration](#configuration).
4. Deploy the Blueprint gateway once so its pre-deploy command migrates the
   shared database.
5. Create a Render Workflows service from the same repository. Use:

   ```bash
   npm run start:workflows
   ```

6. Set the Workflows variables before it starts, using the Postgres internal URL for
   `DATABASE_URL`.
7. Set the gateway's `RENDER_WORKFLOW_SLUG` to the Workflows service slug.
8. Point the GitHub `issues` webhook at `/channels/github`.
9. Run `npm run doctor` from a configured local checkout.

Render Workflows cannot currently be provisioned by Blueprints. The
repository's `Dockerfile` starts only the gateway; keep the Workflows host as
a separate service.

The gateway runs `npm run db:migrate` as its pre-deploy command. The doctor
command validates configuration, repository access, Postgres schema, and task
registration. The remaining manual check is that the Dashboard Workflow slug
matches `RENDER_WORKFLOW_SLUG`.

## Customize

### Verification commands

`factory.config.ts` at the factory repo root defines the commands the workflow
runs deterministically after each implementation round:

```ts
export const factoryConfig = {
  verify: ["npm run build", "npx vitest run"],
};
```

When `verify` is non-empty, the workflow runs each command in the sandbox after
the implementer finishes. If any command fails, the output is fed back to the
implementer and it gets up to three fix rounds. When `verify` is empty, the
workflow skips verification and proceeds directly to review.

This keeps verification deterministic and workflow-controlled rather than
relying on the model to discover and run the right commands.

### Agents

Agents are TypeScript configuration with an explicit model tier, tool
allowlist, budget, and prompt:

```ts
import { Agent, md } from "#factory/sdk";

export const dependencyAnalyst = Agent({
  id: "dependency-analyst",
  description: "Inspects dependencies and proposes a safe upgrade plan",
  model: "medium",
  tools: [
    "sandbox__read_file",
    "sandbox__list_dir",
    "sandbox__search",
  ],
  budget: { maxIterations: 20 },
  plan: "standard",
  prompt: md`
    Inspect the repository's manifests, lockfiles, and dependency usage.
    Produce an ordered upgrade plan with compatibility risks and verification
    commands. Work read-only; do not modify the checkout.
  `,
});
```

Define agents in `app/agents/index.ts`, wrap them with `agentTask()` in
`app/tasks/index.ts`, and call them from orchestration code. An agent's `id`
is also its registered task name, so keep it unique and stable.

Tool lists are runtime allowlists. Read-only analysis agents receive
read-only sandbox tools; only implementation receives write and execution
tools.

`app/workflows/spec-to-pr/index.ts` contains the issue-to-PR orchestration;
its sibling modules isolate checkpoint, model-stage, sandbox, Git, and
terminal logic. Workflow code owns trusted input fetching, sandbox creation
and cleanup, GitHub writes, Git pushes, checkpoints, and retries.

New workflows should validate `unknown` input immediately, keep dispatch
payloads small, live under `app/workflows/<workflow-name>/`, and be exported
from `app/workflows/index.ts` so their tasks register.

`store/` defines backend-neutral run, event, inbox, lease, artifact,
conversation, and knowledge contracts. Postgres is the production adapter and
the in-memory adapter is the executable test reference. Additional primary
backends must pass the same conformance suite; read-only analytics or viewing
systems should consume committed events by global position instead of becoming
a second source of truth.

Application code imports public APIs through `#factory/sdk`; provider
integrations stay behind SDK interfaces.

See [AGENTS.md](AGENTS.md) for detailed extension conventions, registration
steps, security invariants, and test ownership.

## Safety boundaries

- The webhook signature is checked before parsing or dispatch.
- GitHub delivery deduplication, one active lease per issue, and replay-safe
  stage checkpoints prevent overlapping work.
- The gateway never receives the repository token.
- Built-in Claude filesystem and shell tools are not exposed to app agents.
- Unattended permissions and malformed model output fail closed.
- Repository execution stays in a Render Sandbox.
- Git credentials are supplied only around clone and push and are not stored
  in the Git remote.
- The reviewed local commit must match the remote SHA before PR creation.
- Automation ends at an approved draft PR; readiness and merge remain human
  decisions.

## Current limitations

- One deployment is bound to one GitHub repository.
- Intake is limited to a maintainer applying one issue label.
- There is no public chat API, PR review trigger, or automatic PR follow-up.
- Only one internal implementation/review revision is attempted; unresolved
  findings stop without a PR.
- Render Workflows must be created separately from the Blueprint.
- Render Workflows and Sandboxes product access is required.
- Render service filesystems are ephemeral; durable workflow state belongs in
  Postgres or another `FactoryStore` implementation.

## Development and verification

`npm run check` runs Biome lint, TypeScript, and the unit suite. Additional
focused checks:

```bash
npx vitest run app/tests/github.test.ts  # focused gateway test
npm run test:integration                 # live store suite; requires Postgres
npm run run:status -- --issue 42         # inspect a persisted run safely
render blueprints validate               # when render.yaml changes
```

## License

MIT
