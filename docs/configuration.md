# Configuration

[`factory.config.ts`](../factory.config.ts) is committed application
configuration. The gateway and Workflows service both import it.

Edit it before the first deployment and whenever you change repositories,
labels, model assignments, permissions, publishing limits, or Sandbox
lifetimes.

## Example

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
    autopilot: "factory:autopilot",
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

## Repositories

`repos` is keyed by exact GitHub `owner/name`. The factory ignores webhooks
from any other repository, even if the App is installed there.

| Field | Required | Meaning |
|---|---|---|
| `baseBranch` | Yes | Branch used for Triage, implementation, and snapshots |
| `install` | No | Dependency command run after clone credentials are removed |
| `verify` | Yes | Commands required before publishing and during PR review |

Use deterministic install commands such as `npm ci`. Snapshot creation fails
if installation changes a tracked file. Use `verify: []` only when you
intentionally want no command-based verification.

After adding a repository:

1. commit and deploy the configuration;
2. install the GitHub App on the repository;
3. run `npm run setup:github`; and
4. push to the base branch, start a factory task, or
   [refresh the snapshot directly](#refresh-a-snapshot).

## Labels, permission, and limits

| Setting | Default | Meaning |
|---|---|---|
| `labels.triage` | `factory:triage` | Starts or continues Triage |
| `labels.specApproved` | `factory:spec-approved` | Starts Spec-to-PR |
| `labels.prReview` | `factory:pr-review` | Starts PR Reviewer |
| `labels.autopilot` | `factory:autopilot` | Runs all three stages through a reviewed draft PR |
| `commandPrefix` | `/factory` | Prefix for commands such as `/factory cancel` |
| `minimumPermission` | `write` | Live repository permission required to start work |
| `models.medium` | `anthropic/claude-sonnet-5` | Triage and PR Reviewer model |
| `models.large` | `anthropic/claude-opus-5` | Spec writer and implementer model |
| `limits.repairRounds` | `2` | Repair attempts after failed verification |
| `limits.maxChangedFiles` | `200` | Maximum files in a published change |
| `limits.maxFileBytes` | `1000000` | Maximum size of one changed file |
| `sandbox.timeoutSeconds` | `14400` | Provider-side Sandbox lifetime in seconds |

`minimumPermission` accepts `triage`, `write`, `maintain`, or `admin`. The
factory checks the triggering actor's current permission at the start of
every GitHub task.

`setup:github` also creates `factory:working`. This label records an active
run; it is not a trigger.

If you rename a trigger label, deploy both services and rerun
`npm run setup:github`. The command creates required labels but does not
remove old ones.

Keep `sandbox.timeoutSeconds` at least as long as the longest Workflows task.

## Models

Agent definitions select the `medium` or `large` tier.
`factory.config.ts` maps each tier to a `provider/model` supported by
`@earendil-works/pi-ai`, the model client used by the Sandbox runner.

Changing a model mapping requires a Workflows redeploy. To add another
provider:

1. choose a registered `provider/model`;
2. find its key name in [`app/runner/keys.ts`](../app/runner/keys.ts);
3. add the key to `factory-workflows` in [`render.yaml`](../render.yaml);
4. add it to [`.env.example`](../.env.example) and
   `SERVICE_ENV` in `scripts/lib/requirements.ts`;
5. set the key in Render; and
6. run `npm run doctor -- --service workflows`.

Use a key dedicated to this deployment with a provider-enforced spend limit.
The factory has no hard dollar budget.

## What must be redeployed

| Change | Required action |
|---|---|
| Repository, label, permission, or publishing limit | Deploy both services |
| Model mapping | Deploy `factory-workflows` |
| Prompt or Workflows service code | Deploy `factory-workflows` |
| Gateway routing or validation | Deploy `factory-gateway` |
| Label, App permission, or subscribed event | Run `npm run setup:github`; update the App when prompted |
| `app/runner/` or `sandbox/` | Deploy Workflows, then refresh each repository snapshot |
| Repository `install` command or lockfiles | Refresh the snapshot, or let the next task reinstall |

## Snapshots

Each configured repository has a dependency-installed Sandbox snapshot. A
push to its base branch refreshes it. If no snapshot exists, the first task
builds one.

A failed refresh does not delete the previous usable snapshot.

### Refresh a snapshot

Start the `refresh-snapshot` task with the repository, its GitHub App
installation ID, and the base branch's current commit:

```bash
git ls-remote https://github.com/<owner>/<name>.git refs/heads/<base-branch>

cat > input.json <<'JSON'
[{"repo":"<owner>/<name>","installationId":<id>,"sha":"<commit>"}]
JSON

render workflows tasks runs start \
  <workflow-slug>/refresh-snapshot \
  --input-file input.json
```

The installation ID is the number at the end of the installation settings
URL:

```text
https://github.com/settings/installations/<id>
```

Organization installations use the equivalent organization settings URL.

## Follow and control runs

While a GitHub task runs, the issue or pull request has `factory:working`.
The App-authored status comment shows progress, the run ID, and the final
result. Its hidden marker records the current Sandbox for cancellation.

Open that run under `factory-workflows` in the Render Dashboard to inspect its
input, logs, and result.

The service also writes structured events:

- `run.finished` records the task, state, outcome, and duration.
- `agent.finished` records the agent, model, turns, token usage, reported
  cost, and stop reason.

Search them with the Render CLI:

```bash
render logs -r <factory-workflows-id> --text run.finished
render logs -r <factory-workflows-id> --text agent.finished
```

To cancel a run, post this as the first line of an issue or pull request
comment:

```text
/factory cancel
```

The commenter needs `minimumPermission`. Cancellation stops the run named in
the status comment and terminates its recorded Sandbox. It also clears a stale
`running` status when the task has already stopped.

To restart work, remove the trigger label and apply it again.

`factory:autopilot` grants upfront approval to draft a spec, implement it,
open a draft pull request, and post a COMMENT review. It never approves or
merges the pull request, and it does not apply the three manual transition
labels. Triage may still clear a stale spec-approval label when it revises the
spec. The trigger label is removed when a run starts. If Triage asks questions,
the factory adds it back so a human reply can start the continuation. Use
`/factory cancel` to stop an active root workflow.

## Check a deployment

`doctor` is read-only, does not print secret values, and exits nonzero when a
required check fails.

From a local checkout, this checks the services and credentials represented
by local `.env`:

```bash
npm run doctor
```

It cannot inspect values stored only in Render. Check the deployed gateway
from its Render Shell:

```bash
npm run doctor -- --service gateway
```

Workflows services have no Shell. Put the deployed Workflows values and exact
`RENDER_WORKFLOW_SLUG` in local `.env`, then run:

```bash
npm run doctor -- --service workflows
```

The [setup runbook](runbooks/setup.md#phase-10-run-doctor) lists the required
values and common failures.

## Environment variables

Local variables are listed in [`.env.example`](../.env.example). The
Blueprint supplies `RENDER_WORKFLOW_SLUG` to the gateway from the Workflows
service. Every other deployed value comes from an
[environment group](#environment-groups).

### Gateway

| Variable | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | Verify GitHub webhook signatures |
| `RENDER_API_KEY` | Start Workflows tasks |
| `RENDER_WORKFLOW_SLUG` | Address the deployed Workflows service |
| `PORT` | HTTP port; defaults to `3000` |

### Workflows

| Variable | Purpose |
|---|---|
| `RENDER_API_KEY` | Manage Sandboxes, snapshots, and task cancellation |
| `RENDER_WORKSPACE_ID` | Workspace that owns Sandboxes and snapshots |
| `GITHUB_APP_ID` | Authenticate the GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Mint installation tokens |
| `ANTHROPIC_API_KEY` | Call the default models |
| `GITHUB_API_URL` | Optional GitHub API base URL |

`GITHUB_API_URL` is not in the Blueprint. GitHub Enterprise Server users must
set it in local `.env` for setup commands and add it to the
`software-factory-workflows` env group in the Render Dashboard.

Never commit `.env` or provider keys.

## Environment groups

Secrets never pass through `render.yaml` or the Blueprint form. Each service
links Render
[environment groups](https://render.com/docs/configure-environment-variables#environment-groups)
instead:

| Group | Linked to | Variables |
|---|---|---|
| `software-factory-shared` | both services | `RENDER_API_KEY` |
| `software-factory-gateway` | `factory-gateway` | `GITHUB_WEBHOOK_SECRET` |
| `software-factory-workflows` | `factory-workflows` | `RENDER_WORKSPACE_ID`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY` |

The gateway links no group that holds GitHub App credentials or a model key.
`ENV_GROUPS` in
[`scripts/lib/requirements.ts`](../scripts/lib/requirements.ts) defines this
layout for setup and `doctor`.

A Blueprint can't define a group that holds secrets it doesn't commit, so the
groups must exist in the workspace before the Blueprint is applied. Create or
update them from local `.env`:

```bash
npm run setup:render -- --workspace <tea-...>
```

The command writes nothing until every value is set. It updates only values
that changed, leaves other variables in each group alone, and never prints a
secret. A second group with the same name makes it stop, because a Blueprint
links groups by name.

To rotate a secret, change it in `.env`, rerun `npm run setup:render`, and
redeploy the services that link the group.

### Create the groups in the Dashboard

To keep the Render API key out of local `.env`, create the groups by hand
before applying the Blueprint. In the workspace, open **Environment Groups**
and create each group in the table with the exact name and variables shown.
Paste values from `.env` or from their source without showing them in chat.
Workflows `doctor` still reads these values locally, so export them in the
shell where it runs.
