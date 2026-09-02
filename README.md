# render-factory

A self-hosted fork-and-deploy software factory built on Render. Turn a labeled
GitHub issue into a reviewed draft pull request using Render Workflows,
Sandboxes, Postgres, and Web Services.

[Get started](#get-started) · [How it works](#how-it-works) ·
[Architecture](#architecture) · [Deploy](#deploy-to-render) ·
[Customize](#customize) · [Safety](#safety-boundaries)

## Who it is for

render-factory is for engineering and platform teams that want to build and
customize cloud agent workflows, with a focus on coding agents.

It is also a **reference architecture**. The whole system is about 3,000 lines
across fifteen modules with no framework layer between the code and the
platform, so you can follow a run from webhook to pull request without leaving
`app/`. Read it, fork it, and extend it.

### What you get

- **Own the infrastructure.** Execution, credentials, and durable state stay in
  your Render workspace.
- **Answer the security review.** Agents reach the machine only through
  workflow-owned sandbox tools, and GitHub access can be a scoped App with
  hourly tokens rather than someone's personal access token.
- **Run agents safely.** Isolated sandboxes and least-privilege tool access
  constrain every agent.
- **See the pipeline.** Each of the eight agents is its own Render Workflows
  task, so a run is a timeline of named task runs rather than one opaque block.
- **Gate quality.** Three specialist reviewers inspect the complete diff in
  parallel and a judge rules before any branch is pushed.
- **Extend directly.** Add an agent, a tool, a stage, or a whole workflow by
  editing plain TypeScrip.

## How it works

1. Configure one `FACTORY_REPO=owner/repo`.
2. A maintainer listed in `factory.config.ts` applies `FACTORY_LABEL` to an issue.
3. The gateway verifies the GitHub HMAC signature, then the repository, actor,
   action, and label. It claims the run in Postgres and dispatches only the
   issue number and a run ID.
4. The workflow fetches authoritative issue and comment state from GitHub.
5. Triage decides whether the issue has enough detail. The workflow swaps the
   intake label for a status label as acknowledgment. If clarification is
   needed, it comments and stops.
6. Accepted work gets an isolated sandbox and a deterministic `factory/` branch.
7. The analyst explores the checkout read-only and produces a grounded plan.
8. The implementer edits the checkout. It never commits, pushes, or verifies.
9. When `factory.config.ts` defines `verify` commands, the workflow runs them
   in the sandbox. On failure the output is fed back to the implementer for up
   to three fix rounds.
10. A cheap self-review catches debug artifacts, broken imports, and obvious
    mistakes; fixes are applied automatically if found.
11. Security, correctness, and test reviewers inspect the complete diff in
    parallel, and a judge synthesizes one verdict.
12. One requested revision may run through implementation and review again.
13. Only an approved change is pushed. Workflow code verifies the remote SHA
    matches the reviewed commit, then opens a draft pull request.

Automation stops at a draft PR. It never marks ready and never merges. If
clarification or a retry is needed, a maintainer reapplies the label.

### Status labels

The issue carries a `factory:` label showing where the run is, so an in-flight
run is visible without opening the dashboard. In-flight labels are
`factory:analyzing`, `factory:implementing`, and `factory:reviewing`; a run
ends on `factory:pr-open`, `factory:needs-detail`, `factory:no-changes`,
`factory:changes-requested`, or `factory:failed`.

The `factory` trigger label stays on the issue for the whole run and comes off
only when the run reaches a terminal result. That is deliberate: Render retries
a failed task, and the retry re-reads the issue from GitHub. If the label were
removed up front, every retry would fail at intake with "issue no longer has
the label" and hide whatever actually went wrong.

Reapplying `factory` starts a fresh run and clears the previous status label.
Labels are cosmetic — if the GitHub labels API fails, the run continues.

## Architecture

```text
GitHub issues.labeled
  │
  ▼
Gateway web service
  ├─ verifies HMAC before parsing the body
  ├─ matches FACTORY_REPO + FACTORY_LABEL
  ├─ checks the actor allowlist, rejects bots and PRs
  ├─ claims the run (delivery + issue uniqueness in Postgres)
  └─ dispatches { issueNumber, runId }
  │
  ▼
Render Workflows
  ├─ triage
  ├─ analyst ───────────────┐
  ├─ implementer            │
  ├─ verify (deterministic) │ one Render Sandbox
  ├─ self-review + fix      │
  ├─ security ┐             │
  ├─ correctness ├ parallel │
  ├─ tests ────┘            │
  ├─ judge                  │
  └─ draft pull request ◀───┘

Render Postgres
  └─ one runs table: status, branch, pull request, timestamps
```

Two processes deploy independently: the Hono gateway at `app/src/server.ts` and
the task-registration host at `app/src/workflows.ts`. The gateway runs no
models and holds no repository credential. Workflow code owns GitHub writes,
Git pushes, and sandbox lifecycle; agents receive only the sandbox operations
their role requires.

`GET /health` reports liveness. `GET /ready` checks Postgres and is the
deployed gateway health check.

## Project structure

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
  github/           REST client for issues and pull requests
  format/           Issue to work item; results to GitHub markdown
  store/            Postgres: one runs table
  sql/              Schema, applied by scripts/migrate.ts
  src/              Gateway and Workflows entrypoints
tests/              Focused suite; every external boundary is mocked
render.yaml         Gateway and Postgres Blueprint
Dockerfile          Gateway image
docker-compose.yml  Local Postgres
```

### Reading order

| Start here | For |
| --- | --- |
| `factory.config.ts` | Every knob: repo dir, verify commands, model tiers |
| `app/workflows/spec-to-pr/index.ts` | The whole pipeline, top to bottom |
| `app/agents/` | The eight agents and their prompts, one per file |
| `app/tasks/agent-task.ts` | How an agent becomes a Render task |
| `app/claude/run.ts` | How a task calls a model and bridges tools |
| `app/gateway/webhook.ts` | How a webhook becomes a dispatched run |
| `app/policy/check.ts` | The one gate between a model and the machine |

## Get started

### Prerequisites

For a full end-to-end run you need:

- Node.js 22 or newer and npm
- Docker for the local Postgres service
- The Render CLI, installed and authenticated
- A Render workspace with access to Workflows and Sandboxes
- An Anthropic API key
- A GitHub repository and a fine-grained token

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
still create real Render Sandboxes; they do not execute repository code on your
development machine.

### Setup commands

Three scripts remove most of the hand-wiring. They are ordinary TypeScript in
`scripts/` — nothing is hidden.

```bash
npm run setup:app     # create a GitHub App via GitHub's manifest flow
npm run setup:github  # create the webhook and trigger label
npm run doctor        # diagnose the result; changes nothing
```

**`setup:app`** runs GitHub's App manifest flow. It serves a one-click form,
and GitHub creates the app, its private key, and its webhook secret together,
so none of that has to be assembled by hand. It prints the variables to set.

**`setup:github`** creates or repoints the webhook and creates the trigger
label, idempotently. Use it when you are on a PAT rather than an App. It
generates a webhook secret if you do not supply one.

**`doctor`** is what to reach for when something does not work. It checks every
required variable on both processes, that the GitHub credential can reach and
push to `FACTORY_REPO`, that the webhook exists at the right path with the
right events, that the trigger label exists, that Postgres has the expected
schema and indexes, and that all nine task names registered. Every failure
prints its fix. It is read-only and exits non-zero, so CI can gate on it.

Running `doctor` against a Render database from your laptop needs the external
connection string with `?sslmode=require` appended. The deployed services use
the internal string, which does not.

### Connect GitHub and run the factory

The webhook takes `issues` events at:

```text
https://<gateway-host>/webhooks/github
```

Use the same secret as `GITHUB_WEBHOOK_SECRET`. A gateway running only on
localhost needs a publicly reachable HTTPS tunnel before GitHub can deliver to
it.

Apply the configured label — `factory` by default — to an issue, as a login on
the actor allowlist. Applying that label is the only way to start work;
comments and other issue events never trigger the factory.

Scope the GitHub credential to `FACTORY_REPO` only, grant the minimum Contents,
Issues, and Pull Requests permissions needed to clone, push, comment, and open
a draft PR, and protect the default branch.

### Who the factory appears as

With a **GitHub App**, comments and pull requests are attributed to the app
(`your-app[bot]`) and it authenticates with installation tokens that expire
after an hour. Create an App with Contents, Issues, and Pull Requests write
permissions, install it on the repository, then set `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_INSTALLATION_ID`.

With a **fine-grained PAT**, everything the factory does on the API is
attributed to the token's owner — the issue reads as though a maintainer wrote
the comments and opened the PR. Commits are still authored as
`render-factory[bot]`, because Git identity is set inside the sandbox.

The App path is worth the extra setup for a demo or anything customer-facing.
The PAT path is faster for a first run.

## Configuration

| Variable | Service | Purpose |
|---|---|---|
| `FACTORY_REPO` | Both | The only repository the factory can operate on |
| `FACTORY_LABEL` | Both | Intake label; defaults to `factory` |
| `FACTORY_GITHUB_ACTORS` | Gateway | Comma-separated GitHub logins allowed to apply the label; overrides `factory.config.ts` |
| `GITHUB_WEBHOOK_SECRET` | Gateway | HMAC secret; use at least 32 random characters |
| `RENDER_WORKFLOW_SLUG` | Gateway | Deployed Workflows service slug, without a task name |
| `DATABASE_URL` | Both | Postgres connection string for the runs table |
| `ANTHROPIC_API_KEY` | Workflows | Claude Agent SDK credential |
| `GITHUB_APP_ID` | Workflows | GitHub App ID (preferred over a PAT) |
| `GITHUB_APP_PRIVATE_KEY` | Workflows | App private key: PEM, escaped PEM, or base64 |
| `GITHUB_APP_INSTALLATION_ID` | Workflows | Installation on `FACTORY_REPO` |
| `GITHUB_TOKEN` | Workflows | Fine-grained PAT; fallback when no App is set |
| `RENDER_API_KEY` | Both | Task dispatch on the gateway; Sandboxes on Workflows |
| `RENDER_WORKSPACE_ID` | Workflows | Workspace in which sandboxes are created |
| `GITHUB_API_URL` | Workflows | Optional GitHub API base URL override |
| `PORT` | Gateway | Optional HTTP port; defaults to `3000` |

Both processes must use the same `FACTORY_REPO`, `FACTORY_LABEL`, and Postgres
database. `DATABASE_URL` points to local Docker in `.env.example`; the gateway
Blueprint wires its production value automatically.

Development scripts load `.env`. The production commands `npm run start:gateway`
and `npm run start:workflows` do not; supply their environment through Render.

## Deploy to Render

1. Fork this repository.
2. Create a Blueprint from `render.yaml`. It provisions
   `render-factory-gateway` and `render-factory-db`.
3. Set the unsynced gateway variables listed in
   [Configuration](#configuration).
4. Deploy the Blueprint gateway once so its pre-deploy command migrates the
   database.
5. Create a Render Workflows service from the same repository, using:

   ```bash
   npm run start:workflows
   ```

6. Set the Workflows variables before it starts, using the Postgres **internal**
   connection string for `DATABASE_URL`.
7. Set the gateway's `RENDER_WORKFLOW_SLUG` to the Workflows service slug.
8. Point the GitHub `issues` webhook at `/webhooks/github`.

Render Workflows cannot currently be provisioned by Blueprints, and the
`Dockerfile` starts only the gateway — keep the Workflows host as a separate
service. The gateway runs `npm run db:migrate` as its pre-deploy command, so
the schema is applied before any new instance serves traffic.

## Customize

### Verification commands

`factory.config.ts` is the first file to edit. It holds every knob:

```ts
export const factoryConfig: FactoryConfig = {
  actors: ["your-github-login"],
  repoDir: "/home/user/repo",
  verify: ["npm run build", "npx vitest run"],
  models: {
    small: "claude-haiku-4-5",
    medium: "claude-sonnet-5",
    large: "claude-opus-5",
  },
};
```

When `verify` is non-empty the workflow runs each command in the sandbox after
the implementer finishes, and feeds failures back for up to three fix rounds.
When it is empty, verification is skipped. The workflow runs these commands,
not the model, so a passing build cannot be asserted by an agent that never ran
one.

### Agents

An agent is a plain object: a model tier, a tool allowlist, a turn budget, and
a prompt.

```ts
import { type Agent, md } from "../claude/index.js";
import { readTools } from "../tools/index.js";

export const dependencyAnalyst: Agent = {
  id: "dependency-analyst",
  description: "Inspects dependencies and proposes a safe upgrade plan",
  model: "medium",
  tools: readTools,
  maxTurns: 20,
  plan: "standard",
  prompt: md`
    Inspect the repository's manifests, lockfiles, and dependency usage.
    Produce an ordered upgrade plan with compatibility risks and verification
    commands. Work read-only; do not modify the checkout.
  `,
};
```

Define it under `app/agents/`, re-export it from that index, wrap it with
`agentTask()` in `app/tasks/index.ts`, and call it from a workflow stage. An
agent's `id` is also its registered Render task name, so keep it unique and
stable.

Tool lists are runtime allowlists composed from two disjoint sets: `readTools`
(read, list, search) and `writeTools` (exec, write, apply-patch), with
`allTools` being both. Analysis agents get `readTools`; only the implementer
gets `allTools`. Agents that only reason about their input
declare no tools at all, and Claude's own `Bash`, `Read`, `Write`, and `Edit`
are never granted.

Agent tasks take `{ message, sandboxId? }`. Only `message` reaches the model;
`sandboxId` is supplied by workflow code and resolved into a live sandbox for
the tools.

### Workflows

`app/workflows/spec-to-pr/index.ts` is the pipeline narrative; its sibling
modules hold each stage. To add a workflow, create
`app/workflows/<name>/index.ts` with a `task(...)` definition and export it
from `app/workflows/index.ts` — that export is what registers it.

Workflow handlers accept `unknown` and parse it immediately with a Zod schema
from `app/contracts/`, return JSON-serializable values, keep dispatch payloads
small, and wrap sandbox lifecycle in `try/finally`.

See [AGENTS.md](AGENTS.md) for extension conventions, registration steps,
security invariants, and test ownership.

## Safety boundaries

- The webhook signature is checked before the body is parsed or dispatched.
- One deployment is bound to one validated `FACTORY_REPO`.
- Only `issues.labeled`, from a human on the actor allowlist, starts a run.
  Bots, pull requests, other repositories, and other events are skipped.
- The gateway never receives the repository token.
- Claude's built-in filesystem and shell tools are not exposed to app agents,
  so every action an agent takes goes through a workflow-owned sandbox.
- `checkToolCall` runs as a Claude `PreToolUse` hook and vetoes destructive
  commands, secret exfiltration, and paths outside the checkout.
- Malformed structured model output fails closed after one repair attempt.
- The GitHub token never enters a prompt, a Git remote URL, or a command line;
  it reaches Git through a temporary askpass script.
- Configured as a GitHub App, the factory holds no long-lived credential — it
  signs a short JWT with the app's private key and exchanges it for an
  installation token that expires within the hour.
- The reviewed local commit must match the remote SHA before a PR is created.
- Secret-shaped strings are redacted from anything posted to GitHub.
- Automation ends at a draft PR; readiness and merge remain human decisions.

## Current limitations

- One deployment is bound to one GitHub repository.
- Intake is limited to a maintainer applying one issue label.
- There is no public chat API, PR review trigger, or automatic PR follow-up.
- Only one implementation/review revision is attempted; unresolved findings
  stop without a PR.
- A failed task run is not resumed, and retrying repeats task model calls.
- Diffs over 200,000 characters and binary diffs fail closed.
- Render Workflows must be created separately from the Blueprint, and Workflows
  and Sandboxes product access is required.
- Render service filesystems are ephemeral; anything that must outlive a
  process belongs in Postgres.

## Development and verification

```bash
npm run check                        # Biome lint, TypeScript, and Vitest
npx vitest run tests/gateway.test.ts # one focused suite
npm run doctor                       # diagnose a live deployment
render blueprints validate           # when render.yaml changes
```

## License

MIT
