# render-factory

A reference for building a self-hosted software factory on Render. It turns
a labeled GitHub issue into a reviewed draft pull request using three
chained workflows — Triage, Spec-to-PR, and PR Reviewer — backed by
Workflows, Sandboxes, Postgres, and Web Services.

This repository is meant to be read, demonstrated, forked, and adapted.
It is not a general-purpose coding agent product. The useful parts are
the production boundaries: where state lives, which component holds
authority, how untrusted model actions are constrained, and where a
human remains in control.

## The three workflows

| Workflow | Triggered by | What it does | Ends with |
|---|---|---|---|
| **Triage** | `factory:triage` or `factory:full-run` on an issue, or a human reply while the conversation is open | Opens a sandbox, reads the repository, and decides: ask clarifying questions, draft/revise a specification, or decline. | Questions or a spec version posted on the issue |
| **Spec-to-PR** | `factory:spec-approved` on an issue | Implements the approved spec version, verifies with configured commands, self-reviews, publishes through the Git Data API, and opens a draft PR. | A draft PR whose tree SHA matches the sandbox |
| **PR Reviewer** | `factory:pr-review` on a PR, or automatically after a full run | Runs verification, parallel specialist reviewers (security, correctness, performance, tests), UX testing against local dev and the preview environment, and posts one COMMENT review. | A COMMENT review on the PR |

Phases chain through GitHub. A run never waits for a human — it finishes
its phase, posts the result, and ends. The human's response starts the
next run. A full run (`factory:full-run`) chains all three automatically.

```text
factory:triage ──► Triage ──► questions or spec
                                   │
                         human replies / approves
                                   │
factory:spec-approved ──► Spec-to-PR ──► draft PR
                                            │
              factory:pr-review or auto ──► PR Reviewer ──► COMMENT review
```

## Architecture

Five Render resources, plus sandboxes and preview environments:

| Resource | Render type | Entry point | Job |
|---|---|---|---|
| `factory-gateway` | Web Service | `app/src/server.ts` | Verifies webhooks, records deliveries, creates queued runs; serves the read API, trace UI, and artifact links |
| `factory-dispatcher` | Background Worker | `app/src/dispatcher.ts` | Polls queued runs and starts Workflow tasks |
| `factory-workflows` | Workflows | `app/src/workflows.ts` | Runs the three workflows and all agent tasks; owns GitHub writes and publishing |
| `factory-maintenance` | Cron Job | `app/src/maintenance.ts` | Re-queues stuck dispatches, fails lost executions, reaps sandboxes, refreshes the repository snapshot, expires artifacts |
| `factory-db` | Postgres | — | All state: runs, deliveries, events, specs, sandboxes, artifacts |

Sandboxes are Render Sandboxes created per run from a repository snapshot.
Each run creates its own sandbox from the current snapshot, uses it, and
terminates it when the run finishes. The maintenance cron keeps the snapshot
current by rebuilding when the base branch moves or the build key changes.
The builder always gets `allow-all` for egress; run sandboxes inherit the
configured `sandbox.network` policy.
Preview environments come from the target repository's own Blueprint.

### Credential placement

| Credential | Gateway | Dispatcher | Workflows | Maintenance | Sandboxes |
|---|---|---|---|---|---|
| `DATABASE_URL` | yes | yes | yes | yes | — |
| `GITHUB_WEBHOOK_SECRET` | yes | — | — | — | — |
| `FACTORY_ADMIN_TOKEN` | yes | — | — | — | — |
| `RENDER_API_KEY` | — | yes | yes | yes | — |
| GitHub App credentials | — | — | yes | yes | Read-only token, present only during clone/fetch |
| Model provider keys | — | — | yes | — | — |

The gateway holds no model key, no Render API key, and no repository
credential. Model keys never enter a sandbox.

## Safety boundaries

- The webhook signature is verified before the body is parsed.
- One deployment is bound to one validated target repository from `factory.config.ts`.
- Every run checks the triggering actor's live repository permission (configurable minimum, default `write`) before doing work.
- The gateway holds only the database URL, webhook secret, and admin token.
- Agents receive only the tool sets they compose. Claude's built-in `Bash`, `Read`, `Write`, and `Edit` tools are never granted. Each agent's tool list is pinned by a test.
- Model credentials never enter a sandbox. A GitHub token is present in a sandbox only during clone or fetch; it is read-only and scrubbed before any agent or PR code runs.
- Models never choose sandbox IDs, paths outside the checkout, branches, GitHub targets, or task names.
- Publishing uses the Git Data API from the Workflows service. A PR opens only after GitHub's tree SHA equals the verified local tree SHA. Symlinks (mode `120000`) and submodules (`160000`) are refused. Changes under `.github/workflows/` are refused unless `allowWorkflowChanges` is set.
- `checkToolCall` runs as a `PreToolUse` hook and vetoes destructive commands (`git push`, `git remote`, `git config --global`, `git credential`, recursive forced deletion, destructive SQL, and more) and secret exfiltration patterns.
- Reviews are COMMENT-only. The factory never approves, never requests changes, never marks a PR ready, and never merges.
- Secret-shaped strings are redacted from anything posted to GitHub.
- At most one non-terminal run exists per subject (enforced by a partial unique index).
- Sandboxes are terminated in `finally`. Maintenance only terminates sandboxes recorded in the `sandboxes` table.

## Get started

### Prerequisites

- Node.js 22+ and npm
- Docker for the local Postgres service
- The [Render CLI](https://render.com/docs/cli), installed and authenticated
- A Render workspace with access to Workflows and Sandboxes
- An Anthropic API key (OpenAI optional, for the alternative runner)
- A GitHub repository to use as the target (see the [sample repository](#sample-repository))

### Install

```bash
git clone https://github.com/<you>/render-factory.git
cd render-factory
npm ci
cp .env.example .env
```

Fill in `.env` using the [configuration reference](#configuration-reference).

### Configure `factory.config.ts`

Point `repos[0]` at your fork of the sample repository:

```ts
repos: [{
  owner: "your-org",
  name: "render-factory-sample",
  baseBranch: "main",
  repoDir: "/home/user/repo",
  setup: { install: "npm ci", browsers: true },
  verify: ["npm run build", "npm test"],
  dev: {
    start: "npm run dev -- --port 3000",
    port: 3000,
    healthPath: "/",
  },
  preview: { serviceName: "sample-web" },
}]
```

### Deploy

1. Fork this repository and the sample repository.
2. Update `repos[0]` in `factory.config.ts` and `repo` on the `factory-workflows` service in `render.yaml`.
3. Create a Blueprint from `render.yaml`. It provisions the gateway, dispatcher, maintenance cron, workflows service, and database.
4. Set the `sync: false` values in the Render Dashboard (see [configuration reference](#configuration-reference)).
5. Deploy the Blueprint once so the gateway's pre-deploy command migrates the database.
6. Run `npm run setup:app` to create the GitHub App through the manifest flow, then install it on the sample repository.
7. Run `npm run setup:github` to create the webhook and the four trigger labels.
8. Run `npm run doctor` to verify the setup.
9. Apply `factory:full-run` to a seeded issue on the sample repository.

### Setup commands

```bash
npm run setup:app       # create a GitHub App via GitHub's manifest flow
npm run setup:github    # create/update the webhook and four trigger labels
npm run doctor          # diagnose the deployment; read-only, safe in CI
```

## Configuration reference

### `factory.config.ts`

| Field | Type | Purpose |
|---|---|---|
| `repos[0].owner` | string | GitHub owner of the target repository |
| `repos[0].name` | string | Repository name |
| `repos[0].baseBranch` | string | Branch to clone and target PRs against (default `main`) |
| `repos[0].repoDir` | string | Checkout path inside sandboxes |
| `repos[0].setup.install` | string | Install command run in sandboxes |
| `repos[0].setup.browsers` | boolean | Install Playwright browsers in sandboxes |
| `repos[0].verify` | string[] | Commands run to verify implementations (build, test) |
| `repos[0].dev.start` | string | Command to start the dev server for local UX testing |
| `repos[0].dev.port` | number | Port the dev server listens on |
| `repos[0].dev.healthPath` | string | Path to poll for dev server readiness |
| `repos[0].dev.readyTimeoutSeconds` | number | How long to wait for the dev server (default 120) |
| `repos[0].dev.env` | Record | Extra env vars for the dev server |
| `repos[0].preview.serviceName` | string | Render service name for preview environments |
| `repos[0].allowWorkflowChanges` | boolean | Allow changes to `.github/workflows/` (default false) |
| `labels.triage` | string | Label to start triage (default `factory:triage`) |
| `labels.fullRun` | string | Label for a full run (default `factory:full-run`) |
| `labels.specApproved` | string | Label to approve a spec (default `factory:spec-approved`) |
| `labels.prReview` | string | Label to start PR review (default `factory:pr-review`) |
| `commandPrefix` | string | Prefix for commands like cancel (default `/factory`) |
| `minimumPermission` | string | Minimum GitHub permission to trigger runs (default `write`) |
| `agents.runner` | string | Default runner: `claude` or `openai` |
| `agents.models` | object | Model IDs per runner and tier (`small`, `medium`, `large`) |
| `review.specialists` | string[] | Specialist reviewers to run (default: security, correctness, performance, tests) |
| `sandbox.timeoutSeconds` | number | Sandbox lifetime limit (default 7200) |
| `sandbox.builderTimeoutSeconds` | number | Builder sandbox timeout (default 7200) |
| `sandbox.network` | object | Render native sandbox network policy, passed through unchanged |
| `limits.repairRounds` | number | Max verification repair rounds (default 2) |
| `limits.perRunUsd` | number | Per-run cost cap in USD (default 20) |
| `limits.toolOutputChars` | number | Max tool output before truncation (default 40000) |
| `limits.artifactBytes` | number | Max size per artifact (default 5 MB) |
| `limits.runArtifactBytes` | number | Max total artifacts per run (default 50 MB) |
| `pricing` | object | Model ID to per-token pricing for cost tracking |

### Environment variables

| Variable | Service | Purpose |
|---|---|---|
| `DATABASE_URL` | All four | Postgres connection string |
| `GITHUB_WEBHOOK_SECRET` | Gateway | HMAC secret for webhook verification |
| `FACTORY_ADMIN_TOKEN` | Gateway | Bearer token for the read API and trace UI |
| `PORT` | Gateway | HTTP port (default 3000) |
| `RENDER_API_KEY` | Dispatcher, Workflows, Maintenance | Render API key for task dispatch and sandbox operations |
| `RENDER_WORKFLOW_SLUG` | Dispatcher | Slug of the `factory-workflows` service |
| `RENDER_WORKSPACE_ID` | Workflows, Maintenance | Workspace for sandbox creation |
| `GITHUB_APP_ID` | Workflows, Maintenance | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Workflows, Maintenance | PEM private key (raw, escaped, or base64) |
| `GITHUB_APP_INSTALLATION_ID` | Workflows, Maintenance | Installation on the target repository |
| `ANTHROPIC_API_KEY` | Workflows | Claude API key |
| `OPENAI_API_KEY` | Workflows | OpenAI API key (when using the openai runner) |
| `GITHUB_API_URL` | Workflows, Maintenance | Optional GitHub API base URL override |
| `FACTORY_PUBLIC_URL` | Workflows | Public URL for linking to runs in error comments |

Development scripts load `.env`. Production commands (`npm run start:*`) do
not; supply their environment through Render.

## Observability

### Read API

JSON endpoints behind `Authorization: Bearer <FACTORY_ADMIN_TOKEN>`:

| Endpoint | Description |
|---|---|
| `GET /api/runs` | List runs with status, workflow, subject, stage, cost |
| `GET /api/runs/:id` | Single run detail |
| `GET /api/runs/:id/events` | Span timeline for a run |
| `GET /api/runs/:id/artifacts` | Artifacts (screenshots, transcripts, logs) |
| `GET /api/specs/:id` | Specification with versions |
| `GET /api/deliveries` | Recent webhook deliveries and their outcomes |

### Trace UI

Server-rendered pages at `/ui` behind the admin token. Shows runs,
the span timeline, conversation history, cost by agent, spec versions,
artifacts with inline screenshots, and links to GitHub.

### Artifact links

`GET /a/:token` serves one artifact publicly, so reviews can embed
screenshots. Tokens are 32 random bytes; only their SHA-256 hash is stored.
Only images are served inline; everything else is an attachment.

## Local development

```bash
npm run dev:postgres        # start local Postgres via docker compose
npm run db:migrate          # apply schema migrations
npm run dev:gateway         # gateway with auto-reload on localhost:3000
npm run dev:workflows       # Render Workflows host (requires the Render CLI)
npm run dev:dispatcher      # dispatcher with auto-reload
```

Local workflow runs create real Render Sandboxes; they do not execute
repository code on your machine. Running `doctor` against a Render
database from your laptop needs `?sslmode=require` appended to the
external connection string.

The gateway serves health at `GET /health` and readiness at `GET /ready`
(checks Postgres). Webhooks arrive at `POST /webhooks/github`.

## Sample repository

The [render-factory-sample](https://github.com/render-examples/render-factory-sample)
is a small Node todo-list app with:

- A `render.yaml` with preview environments enabled (`previews: generation: automatic`)
- `build` and `test` scripts that pass
- A dev server started with `npm run dev -- --port 3000`
- Five seeded issues in `seed-issues/`:
  1. A clear, well-specified request (add due dates)
  2. An underspecified request that triggers questions (search)
  3. A UX change that browser testing can verify (dark mode)
  4. A performance change the specialist should examine (count endpoint)
  5. A prompt injection attempt (secrets, git hooks, symlinks)

## Evals

```bash
npm run eval          # validate cases and print the run plan
npm run eval -- --live   # check env and explain what live mode would do
```

Eval cases live in `evals/cases/*.json`. Each case specifies a workflow,
a fixture (issue title, body, labels, optional comments or PR diff), and
a rubric of checks with severity levels. In 0.1.0, the eval runner
validates cases and prints the plan without calling live services.

## Current limitations

- Every accepted run creates a real sandbox and calls model APIs.
- One deployment is bound to one GitHub repository.
- Only one implementation attempt per spec; unresolved verification failures stop without a PR.
- A failed run is not resumed; retrying repeats model calls.
- Large diffs (over 200 KB) and binary diffs are bounded or fail closed.
- One database role serves all services.
- A lost execution posts no GitHub comment (maintenance marks it failed; it shows in the trace UI).
- Public artifact links expose that artifact to anyone with the link.
- Live eval execution is not implemented; the runner validates and prints a plan.

## Where to look

| Area | Start here |
|---|---|
| Control flow | `app/workflows/spec-to-pr/index.ts`, `app/workflows/triage/index.ts`, `app/workflows/pr-review/index.ts` |
| Configuration | `factory.config.ts` |
| Model trust boundary | `app/runners/`, `app/tools/`, `app/policy/` |
| Ingress and dispatch | `app/gateway/`, `app/dispatcher/` |
| Publishing | `app/publish/` |
| Workspaces | `app/workspaces/` |
| State and persistence | `app/store/`, `app/sql/` |
| Agent guide | [AGENTS.md](AGENTS.md) |

## Verification

```bash
npm run check           # Biome lint, TypeScript, Vitest
npm run doctor          # diagnose a live deployment (read-only)
npm run eval            # validate eval cases
```

## License

MIT
