# Extend the factory

This guide covers supported extension points: repositories, labels,
permissions, models, agents, stages, and webhook routes. Read
[2_ARCHITECTURE.md](2_ARCHITECTURE.md) before changing run coordination,
Sandbox boundaries, credentials, or publishing.

## Configure repositories

[`factory.config.ts`](../factory.config.ts) is committed application
configuration imported by both services:

```typescript
export default defineFactoryConfig({
  repos: {
    "acme/web": {
      baseBranch: "main",
      install: "npm ci",
      verify: ["npm run build", "npm test"],
    },
    "acme/api": {
      baseBranch: "main",
      install: "go mod download",
      verify: ["go test ./..."],
    },
  },
  labels: {
    triage: "factory:triage",
    specApproved: "factory:spec-approved",
    prReview: "factory:pr-review",
  },
  commandPrefix: "/factory",
  minimumPermission: "write",
  models: {
    medium: "anthropic/claude-sonnet-5",
    large: "anthropic/claude-opus-5",
  },
  limits: {
    repairRounds: 2,
    maxChangedFiles: 200,
    maxFileBytes: 1_000_000,
  },
  sandbox: {
    timeoutSeconds: 4 * 60 * 60,
  },
});
```

`repos` is keyed by exact `owner/name`. A webhook for any other repository is
ignored, even if the App is installed there.

| Repository key | Required | Meaning |
|---|---|---|
| `baseBranch` | Yes | Branch used for Triage, Spec-to-PR, snapshots, and base-push refreshes |
| `install` | No | Dependency command run as the unprivileged Sandbox user after credentials are scrubbed |
| `verify` | Yes | Commands required before a draft PR opens and reported by PR Reviewer; an empty list skips verification |

Use deterministic install commands such as `npm ci`, not commands that update
lockfiles. The snapshot builder fails when `install` changes a tracked file,
because that dirty state would otherwise leak into every generated PR.

One deployment can serve multiple repositories and GitHub App installations.
After adding a repository:

1. commit and deploy `factory.config.ts`;
2. install the App on the repository;
3. run `npm run setup:github` to create its labels; and
4. apply a label or push to the base branch to build its first snapshot.

Each repository has its own named snapshot,
`factory-<owner>-<name>`. A base-branch push refreshes it. Changing `install`
does not immediately rebuild it: the next restored Sandbox detects the
difference and reinstalls, and the next base-branch push bakes the change into
a new snapshot.

## Configure behavior and limits

| Key | Default | Meaning |
|---|---|---|
| `labels.triage` | `factory:triage` | Starts Triage; a new human issue comment also retriggers while this label remains |
| `labels.specApproved` | `factory:spec-approved` | Starts Spec-to-PR |
| `labels.prReview` | `factory:pr-review` | Starts PR Reviewer |
| `commandPrefix` | `/factory` | Prefix for comment commands; `<prefix> cancel` must be the first line |
| `minimumPermission` | `write` | Live GitHub permission required to start or cancel: `triage`, `write`, `maintain`, or `admin` |
| `models.medium` | `anthropic/claude-sonnet-5` | Triage and PR reviewer |
| `models.large` | `anthropic/claude-opus-5` | Spec writer and implementer |
| `limits.repairRounds` | `2` | Implementer runs allowed after failed verification |
| `limits.maxChangedFiles` | `200` | Publishing file-count limit |
| `limits.maxFileBytes` | `1000000` | Publishing per-file size limit |
| `sandbox.timeoutSeconds` | `14400` | Provider-side Sandbox lifetime backstop |

Keep `sandbox.timeoutSeconds` at least as long as the longest stage task.
Spec-to-PR's task timeout is four hours by default.

After renaming a label, deploy both services and rerun
`npm run setup:github`. Existing labels are not removed automatically.

The factory has no dollar budget. Each agent's `maxTurns` and timeout bound
its run, and `agent.finished` events record reported usage and cost. Pair the
model key with a provider-enforced spend limit.

## Choose models

Agents select a tier; `factory.config.ts` maps each tier to a
`provider/model` entry in Pi's model registry. This keeps model changes out of
individual agent definitions.

To change models within Anthropic, update the two mappings and redeploy the
Workflows service. To use another provider:

1. choose registered `provider/model` values;
2. find the provider's preferred key variable in
   [`app/runner/keys.ts`](../app/runner/keys.ts);
3. add that variable to `factory-workflows` in
   [`render.yaml`](../render.yaml) with `sync: false`;
4. add it to `.env.example` and the setup/doctor requirements when it should
   be required for this deployment;
5. set the key in Render; and
6. run `npm run doctor -- --service workflows`.

The runner maps keys for Anthropic, OpenAI, and Google, and its self-test
checks that Pi registers models for each. To add another Pi provider, add its
key variables to `PROVIDER_KEY_ENV` in `app/runner/keys.ts`.

Use a key dedicated to this factory. Agents call the model from inside an
allow-all Sandbox, so the key enters the runner for the duration of
the call. The runner removes it from files and environment before tools run
and uses a non-dumpable process, but provider-side spend limits remain
important.

## Customize an agent

An agent is a Markdown prompt plus a typed definition in
[`app/agents/`](../app/agents):

```text
app/agents/
  implementer/
    index.ts
    prompt.md
```

```typescript
export const implementer = defineAgent({
  id: "implementer",
  prompt: "implementer/prompt.md",
  model: "large",
  tools: ["read", "ls", "bash", "edit", "write"],
  output: Implementation,
  maxTurns: 150,
});
```

| Field | Meaning |
|---|---|
| `id` | Unique agent name, recorded on its events |
| `prompt` | File relative to `app/agents/`, normally `<id>/prompt.md`, read verbatim |
| `model` | `medium` or `large` |
| `tools` | Any of `read`, `ls`, `bash`, `edit`, `write` |
| `output` | Zod object schema used for the `submit` tool and host validation |
| `maxTurns` | Maximum model calls |
| `thinking` | Optional `off`, `minimal`, `low`, `medium`, or `high` |

The prompt file is the system prompt, sent verbatim. Put everything
run-specific (the repository, issue, spec, refs, verify commands) in the
message passed to `runAgent`, built by a typed function in the stage.

Prompts should tell the model to call `submit` exactly once. Do not ask for a
JSON-only response; the submit tool supplies the JSON Schema. Keep output
schemas strict and bound strings and arrays because their values may reach
GitHub comments.

Prompt and agent-definition changes require a Workflows deploy, not a
snapshot rebuild. The rendered prompt and schema travel to the runner in each
call.

### Choose tools deliberately

| Tool | Capability |
|---|---|
| `read` | Read a checkout file |
| `ls` | List a checkout directory |
| `bash` | Run a command from the checkout as the unprivileged user |
| `edit` | Replace text in a file |
| `write` | Write a file |

Every agent runs in a Sandbox: `runAgent` requires one, so model-directed
tools never run beside service credentials in the Workflows process.

An agent without `edit` or `write` gets an additional shell policy,
[`app/runner/shell-policy.ts`](../app/runner/shell-policy.ts), that
rejects obvious mutation and network commands. This is a behavioral guard,
not the security boundary; Sandbox isolation and credential placement are the
boundaries. Only the built-in implementer has write tools.

### Run an agent

```typescript
// Tools run against this Sandbox checkout.
const result = await runAgent(
  implementer,
  message,
  {
    sandbox,
    traceId: run.traceId,
    runId: run.runId,
    repo: repo.fullName,
    subject,
  },
);
```

`runAgent` returns output, usage, reported cost, and turns. It emits
`agent.started` and `agent.finished`, which records usage and cost whether the
call succeeded or not. Failures throw `AgentError` with the agent's ID and a
code. The default call timeout is 30 minutes.

A stage doesn't catch agent errors. `withRun` reports an agent that stopped on
its own (`max_turns`, `timeout`, `no_submission`, or an invalid submission) as
an `agent_stopped` failure on GitHub, without the error's message, which can
quote repository output. Any other code, such as `runner_lost`, is a platform
failure and fails the Workflows task.

### Add an agent

1. Add `app/agents/<id>/prompt.md` and `app/agents/<id>/index.ts` with
   `defineAgent`.
2. Export the definition from `app/agents/index.ts`.
3. Add or reuse a bounded Zod schema in `app/schemas/`.
4. Call it from a stage with that stage's Sandbox.
5. Add it to the `agents` list in `tests/agents-catalog.test.ts`, which pins
   unique IDs and which agents get write tools.
6. Run `npm run check`.

The catalog deliberately pins the security-relevant shape of every agent.
Widening tools should require an explicit test change.

Changes to `app/runner/` or `sandbox/` are different from prompt
changes: those files are bundled into each repository snapshot. Rebuild by
pushing to each base branch or starting `refresh-snapshot` manually.

## Add a stage

A stage is a named Workflows task whose body runs inside `withRun`. That
shared lifecycle provides events, a live permission check, a durable run
claim, takeover of an older run, ownership checkpoints, a status comment,
and the working label.

1. Add the task name to `TASKS` in `app/config/index.ts` and the `Stage` type
   and title in `app/runs/status.ts`.
2. Add a bounded Zod input schema to `app/schemas/tasks.ts`. Extend
   `RepoInput` so the repository and installation still come from the
   authenticated webhook.
3. Implement the task under `app/workflows/<name>/`. Parse input, call
   `requireRepo`, identify the issue or PR, and wrap the body in `withRun`.
4. Open a Sandbox only when needed, with `withSandbox`, which closes it
   whatever happens.
5. Call `run.progress()` before major steps and `run.checkpoint()`
   immediately before any durable write not already adjacent to progress.
6. Throw `RunError` only for expected messages safe to show on GitHub, with
   a snake_case outcome. Unexpected errors produce a generic public message
   and fail the task.
7. Export the task from `app/workflows/index.ts`.
8. Route an authenticated webhook to it in `app/gateway/routes.ts`, passing
   the input schema to `start()`, and test the pure route.
9. Add labels, webhook events, or App permissions to
   `scripts/lib/requirements.ts` so setup and doctor share the requirement.
10. Add stage tests with injected GitHub, Sandbox, agent, and run-control
    fakes, then run `npm run check`.

Set the Workflows task timeout for the longest expected run and ensure
`sandbox.timeoutSeconds` is at least that large. Built-in stages disable
automatic retries because another attempt would repeat model spend; a person
relabels to start a fresh run.

Before adding another framework around stages, check whether `withRun`,
Workflows task state, GitHub markers, and the existing Postgres claim already
cover the requirement.

## Add or change a GitHub trigger

The gateway routing table is a pure mapping from `(event, payload)` to one
validated task input or an ignore reason. The gateway verifies the webhook
signature before calling that table.

For another label, comment command, or GitHub event:

1. update `route()` in `app/gateway/routes.ts`, passing the task's Zod
   input schema to `start()`;
2. update `REQUIRED_EVENTS`, `REQUIRED_PERMISSIONS`, or `LABELS` in
   `scripts/lib/requirements.ts`;
3. update the existing GitHub App's permissions or event subscriptions when
   needed;
4. rerun `setup:github` for labels and webhook configuration;
5. add route and setup/doctor tests; and
6. run `doctor`.

Use the GitHub delivery ID as the task idempotency key. Inputs must derive the
repository, App installation, issue or PR, actor, and commit from the
authenticated payload—not model output.

Every GitHub write should look for a marker on an earlier App-authored comment
or review before creating another. Render's idempotency window is finite and
scoped to a Workflows version, so marker idempotency remains necessary.

If integrating a non-GitHub system, keep it as an authenticated adapter:
verify and acknowledge its event, translate it to a bounded task input, and
leave repository and write authority with trusted stage code. Do not pass
arbitrary destinations through an agent schema.

## Run a second deployment

Use a separate GitHub App and database when deployments should have
independent authority and history. Within one Render workspace:

1. rename the project resources in `render.yaml`;
2. update every `fromService` and `fromDatabase` reference;
3. create the second Blueprint from its configured fork;
4. create and install its App; and
5. run its setup and doctor commands.

Repository snapshot names are derived from `owner/name`. Two deployments in
the same workspace that act on the same repository will share that snapshot
name. Isolate them in separate workspaces when their runner, runtime scripts,
install behavior, or trust requirements can differ.

## Environment reference

Every variable appears in [`.env.example`](../.env.example). Local scripts
load `.env` when present.

### Gateway

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Deployed factory | Migrations and delivery events |
| `GITHUB_WEBHOOK_SECRET` | Yes | Verify `x-hub-signature-256`; gateway refuses to start without it |
| `RENDER_API_KEY` | Yes | Start Workflows tasks |
| `RENDER_WORKFLOW_SLUG` | Yes | Prefix task names with the deployed Workflows slug |
| `PORT` | No | Listener port, default `3000`; server binds `0.0.0.0` |

### Workflows

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Strict run claims and best-effort events |
| `RENDER_API_KEY` | Yes | Create Sandboxes and snapshots; read and cancel task runs |
| `RENDER_WORKSPACE_ID` | Yes | Workspace (`tea-…`) that owns the Sandboxes and snapshots |
| `GITHUB_APP_ID` | Yes | Authenticate as the GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Yes | Mint installation tokens; accepts PEM, escaped PEM, or base64 PEM |
| `ANTHROPIC_API_KEY` | Default models | Model calls; replace or supplement for other providers |
| `GITHUB_API_URL` | No | GitHub API base URL, default `https://api.github.com` |

### Scripts

| Variable | Used by |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | `setup:github`, `doctor` |
| `RENDER_EXTERNAL_URL` | Deployed `doctor`, to verify the App points at this gateway |
| `NO_COLOR` | Disable script color output |

`setup:app --write-env` writes the three GitHub values. `db:migrate` reads
`DATABASE_URL`. `doctor` reads variables for the selected service but never
prints their values.
