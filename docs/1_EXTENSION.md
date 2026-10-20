# Extend the factory

Start with a working deployment from [0_QUICKSTART.md](0_QUICKSTART.md).
This guide covers supported extension points: repositories, labels,
permissions, models, agents, stages, webhook routes, and evals. Read
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
    small: "anthropic/claude-haiku-4-5",
    medium: "anthropic/claude-sonnet-5",
    large: "anthropic/claude-opus-5",
  },
  limits: {
    perRunUsd: 20,
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
| `models.small` | `anthropic/claude-haiku-4-5` | Small model tier; no built-in agent currently uses it |
| `models.medium` | `anthropic/claude-sonnet-5` | Triage, implementation reviewer, and PR reviewer |
| `models.large` | `anthropic/claude-opus-5` | Spec writer and implementer |
| `limits.perRunUsd` | `20` | Soft reported-cost threshold shared by every agent in a stage |
| `limits.repairRounds` | `2` | Implementer runs allowed after failed verification |
| `limits.maxChangedFiles` | `200` | Publishing file-count limit |
| `limits.maxFileBytes` | `1000000` | Publishing per-file size limit |
| `sandbox.timeoutSeconds` | `14400` | Provider-side Sandbox lifetime backstop |

Keep `sandbox.timeoutSeconds` at least as long as the longest stage task.
Spec-to-PR's task timeout is four hours by default.

After renaming a label, deploy both services and rerun
`npm run setup:github`. Existing labels are not removed automatically.

`perRunUsd` is not a hard cap. Usage arrives after a model response, so the
response that crosses the remaining budget is still charged. Failed agent
calls count. Always pair the software threshold with a provider-enforced
spend limit.

## Choose models

Agents select a tier; `factory.config.ts` maps each tier to a
`provider/model` entry in Pi's model registry. This keeps model changes out of
individual agent definitions.

To change models within Anthropic, update the three mappings and redeploy the
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

The runner has key mappings for multiple Pi providers. Anthropic, OpenAI, and
Google are covered by the runner self-test; treat other providers as
unverified until you run the full checks and a live eval.

Use a key dedicated to this factory. Tool-using agents call the model from
inside an allow-all Sandbox, so the key enters the runner for the duration of
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
export const implementerVars = ["repo", "verifyCommands"] as const;

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
| `id` | Unique event and trace name |
| `prompt` | File relative to `app/agents/`, normally `<id>/prompt.md`, read verbatim |
| `model` | `small`, `medium`, or `large` |
| `tools` | Any of `read`, `ls`, `bash`, `edit`, `write` |
| `output` | Zod object schema used for the `submit` tool and host validation |
| `maxTurns` | Maximum model calls |
| `thinking` | Optional `off`, `minimal`, `low`, `medium`, or `high` |

The prompt is the system prompt. Put the run-specific task in
`runAgent(...).message`. `{{name}}` placeholders are filled from `vars`, and a
missing value fails before a model call. Each module exports its placeholder
list, and the catalog test checks it against the prompt.

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

Any agent with tools must receive a Sandbox. An agent with no tools must run
in the Workflows process and cannot receive a Sandbox. Types and runtime
checks enforce both directions, preventing model-directed tools from running
beside service credentials.

An agent without `edit` or `write` gets an additional shell policy that
rejects obvious mutation and network commands. This is a behavioral guard,
not the security boundary; Sandbox isolation and credential placement are the
boundaries. Only the built-in implementer has write tools.

### Run an agent

```typescript
// Tools run against this Sandbox checkout.
const result = await run.budget.track((budgetUsd) =>
  runAgent(
    implementer,
    { message, vars },
    {
      sandbox,
      traceId: run.traceId,
      runId: run.runId,
      repo: repo.fullName,
      subject,
      budgetUsd,
    },
  ),
);
```

`runAgent` returns output, usage, reported cost, and turns. It emits
`agent.started` and `agent.finished`. Failures throw `AgentError` with the
usage already incurred, so pass every call through `run.budget.track`.

For parallel calls, use the budget helper's `shareOf` option to reserve budget
for every call. The default call timeout is 30 minutes.

### Add an agent

1. Add `app/agents/<id>/prompt.md` and `app/agents/<id>/index.ts` with
   `defineAgent`.
2. Export the definition and its placeholder names from
   `app/agents/index.ts`.
3. Add or reuse a bounded Zod schema in `app/contracts/`.
4. Call it from a stage, passing a Sandbox exactly when it declares tools.
5. Add it to `tests/agents-catalog.test.ts` with its intended model, tools,
   turn limit, placeholders, and sample output.
6. Run `npm run check`.

The catalog deliberately pins the security-relevant shape of every agent.
Widening tools or moving an agent between the Sandbox and Workflows process
should require an explicit test change.

Changes to `app/runner/` or `sandbox/` are different from prompt
changes: those files are bundled into each repository snapshot. Rebuild by
pushing to each base branch or starting `refresh-snapshot` manually.

## Add a stage

A stage is a named Workflows task whose body runs inside `withRun`. That
shared lifecycle provides events, a live permission check, a durable run
claim, takeover of an older run, ownership checkpoints, a status comment,
the working label, and the stage budget.

1. Add the task name to `TASKS` in `app/config/index.ts` and the `Stage` type
   and title in `app/runs/status.ts`.
2. Add a bounded Zod input schema to `app/contracts/tasks.ts`. Extend
   `RepoInput` so the repository and installation still come from the
   authenticated webhook.
3. Implement the task under `app/workflows/<name>/`. Parse input, call
   `requireRepo`, identify the issue or PR, and wrap the body in `withRun`.
4. Open a Sandbox only when needed and close it in `finally`.
5. Call `run.progress()` before major steps and `run.checkpoint()`
   immediately before any durable write not already adjacent to progress.
6. Throw `RunError` only for expected messages safe to show on GitHub.
   Unexpected errors produce a generic public message and fail the task.
7. Export the task from `app/workflows/index.ts`.
8. Route an authenticated webhook to it in `app/gateway/routes.ts`, register
   its input in `app/gateway/index.ts`, and test the pure route.
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
task input or an ignore reason. It verifies the webhook signature before
calling that table.

For another label, comment command, or GitHub event:

1. update `route()` in `app/gateway/routes.ts`;
2. add the task's Zod input to the gateway registry;
3. update `REQUIRED_EVENTS`, `REQUIRED_PERMISSIONS`, or `LABELS` in
   `scripts/lib/requirements.ts`;
4. update the existing GitHub App's permissions or event subscriptions when
   needed;
5. rerun `setup:github` for labels and webhook configuration;
6. add route and setup/doctor tests; and
7. run `doctor`.

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

## Add eval cases

Evals currently cover Triage and the spec writer. One JSON file under
[`evals/cases/`](../evals/cases) describes the issue and expectations:

```json
{
  "id": "underspecified-search",
  "description": "A vague request gets questions, not a spec.",
  "stage": "triage",
  "issue": {
    "title": "Search",
    "body": "It would be nice to be able to search.",
    "labels": ["factory:triage"]
  },
  "expect": {
    "decision": "ask",
    "questionsMax": 3,
    "maxCostUsd": 2
  }
}
```

Expectations can constrain:

- `decision`: `ask`, `draft`, or `decline`;
- `questionsMax`: maximum questions;
- `specMustMention`: case-insensitive required terms;
- `mustNotContain`: strings forbidden from any output; and
- `maxCostUsd`: maximum reported case cost.

`comments` replays an oldest-first conversation. Mark a comment `"bot": true`
to represent another App; Triage excludes bot comments from the human thread.

Validate locally with no live calls:

```bash
npm run eval -- --validate
```

Then run the new case against a test installation:

```bash
npm run eval -- \
  --installation <id> \
  --case <case-id> \
  --budget 2
```

Include adversarial cases for new prompts and tools. A live eval uses the
real model and Sandbox and incurs cost.

## Run a second deployment

Use a separate GitHub App and database when deployments should have
independent authority and traces. Within one Render workspace:

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
| `DATABASE_URL` | Deployed factory | Migrations, delivery events, and trace UI |
| `GITHUB_WEBHOOK_SECRET` | Yes | Verify `x-hub-signature-256`; gateway refuses to start without it |
| `FACTORY_ADMIN_TOKEN` | Trace UI/API | Authenticate `/ui` and `/api`; those routes return 503 without it |
| `RENDER_API_KEY` | Yes | Start Workflows tasks |
| `RENDER_WORKFLOW_SLUG` | Yes | Prefix task names with the deployed Workflows slug |
| `PORT` | No | Listener port, default `3000`; server binds `0.0.0.0` |

### Workflows

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Strict run claims and best-effort events |
| `RENDER_API_KEY` | Yes | Create Sandboxes and snapshots; read and cancel task runs |
| `RENDER_WORKSPACE_ID` | Sometimes | Select the workspace when the key can see more than one |
| `GITHUB_APP_ID` | Yes | Authenticate as the GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Yes | Mint installation tokens; accepts PEM, escaped PEM, or base64 PEM |
| `ANTHROPIC_API_KEY` | Default models | Model calls; replace or supplement for other providers |
| `GITHUB_API_URL` | No | GitHub API base URL, default `https://api.github.com` |
| `RENDER_API_MIN_INTERVAL_MS` | No | Minimum gap between Sandbox API calls, default `1000` |

### Scripts and evals

| Variable | Used by |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | `setup:github`, `doctor` |
| `RENDER_EXTERNAL_URL` | Deployed `doctor`, to verify the App points at this gateway |
| `FACTORY_EVAL_INSTALLATION_ID` | Live eval target when `--installation` is omitted |
| `NO_COLOR` | Disable script color output |

`setup:app --write-env` writes the three GitHub values. `db:migrate` reads
`DATABASE_URL`. `doctor` reads variables for the selected service but never
prints their values.
