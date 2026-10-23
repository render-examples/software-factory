# Quickstart

Deploy the factory, run its three stages, develop locally, and operate it.
Once the default path works, use [1_EXTENSION.md](1_EXTENSION.md) to change
repositories, models, agents, stages, or GitHub triggers. For the
implementation, continue to [2_ARCHITECTURE.md](2_ARCHITECTURE.md).

## Prerequisites

- A Render workspace with Sandboxes access in **Oregon**.
- A **Render API key** for that workspace.
- A dedicated, spend-capped **model API key**. Anthropic is the default; see
  [Choose models](1_EXTENSION.md#choose-models).
- Admin access to each GitHub repository where the App will be installed, and
  to the organization if the App will be owned by one.
- Node.js 24, as pinned in [`.node-version`](../.node-version), and npm. The
  package declares Node.js 22.19 as its minimum supported version.

The Blueprint creates paid resources: a Starter gateway, a Workflows service,
and a Basic-256mb Postgres database. Sandbox and model usage are charged
separately.

## Deploy to Render

Setup has a fixed order. The GitHub App credentials go into the Blueprint,
then the deployed gateway URL goes back into the App's webhook settings.

### 1. Fork and configure

[Fork the repository](https://github.com/render-examples/software-factory/fork).
The Blueprint must use your fork because
[`factory.config.ts`](../factory.config.ts) is application configuration.

Replace the example repository:

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
  // Keep or customize the remaining settings.
});
```

`install` runs as the unprivileged Sandbox user after Git credentials are
removed. It must not modify tracked files. `verify` runs before a draft PR is
published and during PR review. Commit and push the configuration.

See [Configure repositories](1_EXTENSION.md#configure-repositories) for every
field and the snapshot behavior that follows a configuration change.

### 2. Create the GitHub App

```bash
npm ci
npm run setup:app -- --write-env

# To create the App in an organization instead:
npm run setup:app -- --org acme --write-env
```

The script serves a page on `127.0.0.1`. Open it and select **Create on
GitHub**. The manifest requests:

- Contents, Issues, and Pull requests: write
- Metadata: read
- Issues, Issue comments, Pull requests, and Pushes: webhook events

The App receives no Actions, Workflows, or Administration permission.

GitHub redirects to the local script, which prints:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`, base64-encoded for a single-line environment
  variable
- `GITHUB_WEBHOOK_SECRET`

GitHub shows the private key only once. `--write-env` saves all three values
to the ignored `.env` file for later setup commands. The webhook starts
inactive and points at a placeholder because the gateway does not exist yet.

### 3. Install the App

Open the installation link printed by `setup:app` and install the App on every
repository listed in `factory.config.ts`. One App can serve repositories
across multiple accounts; each webhook identifies the installation the
factory should use.

### 4. Create the Blueprint

In the Render Dashboard, create a Blueprint from **your fork**, not
`render-examples/software-factory`. [`render.yaml`](../render.yaml) creates:

| Resource | Type | Purpose |
|---|---|---|
| `factory-gateway` | Web Service | Verify webhooks and start tasks |
| `factory-workflows` | Workflows | Run stages, agents, snapshot refresh, and cancel |
| `factory-db` | Postgres | Store strict run claims and best-effort telemetry events |

Enter these values:

| Service | Variable | Value |
|---|---|---|
| Gateway | `GITHUB_WEBHOOK_SECRET` | From `setup:app` |
| Gateway | `RENDER_API_KEY` | Your Render API key |
| Workflows | `RENDER_API_KEY` | The same Render API key |
| Workflows | `RENDER_WORKSPACE_ID` | Workspace ID (`tea-…`) that owns the Sandboxes |
| Workflows | `GITHUB_APP_ID` | From `setup:app` |
| Workflows | `GITHUB_APP_PRIVATE_KEY` | From `setup:app` |
| Workflows | `ANTHROPIC_API_KEY` | Dedicated, spend-capped Anthropic key |

The Blueprint wires `DATABASE_URL` to both services and the workflow slug to
the gateway. The gateway runs the database migrations before each deploy. Check every `sync: false` value after
creation; a blank field counts as unset.

### 5. Connect the webhook and create labels

Wait for `factory-gateway` to become live, then run:

```bash
npm run setup:github -- \
  --gateway-url https://<gateway>.onrender.com
```

The command is idempotent. It:

- sets the App webhook URL to
  `https://<gateway>.onrender.com/webhooks/github`;
- preserves the webhook secret created earlier; and
- creates `factory:triage`, `factory:spec-approved`,
  `factory:pr-review`, and `factory:working` on each configured repository.

Rerun it after adding a repository or renaming a label. Without `.env`, set
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, and pass
`--webhook-secret <secret>`.

### 6. Activate the webhook

GitHub's API cannot activate an App webhook. Open the App settings page
printed by the setup script, check **Webhook > Active**, and save without
changing the URL or secret.

### 7. Check the deployment

Run locally:

```bash
npm run doctor
```

`doctor` is read-only and does not print secret values. It checks the local
`.env`, the App's permissions and events, the webhook, repository
installations and labels, Postgres, and registered tasks.

To inspect the deployed environments, run these in the corresponding Render
Shells:

```bash
# factory-gateway
npm run doctor -- --service gateway

# factory-workflows
npm run doctor -- --service workflows
```

The command exits nonzero when a required check fails.

## Run the factory

### Triage an issue

Create an issue in a configured repository and add `factory:triage`.

The factory checks the actor's live repository permission, opens the
repository at its configured base branch, and either:

- asks up to five focused questions;
- posts a spec; or
- explains why the request should not proceed.

Reply to the issue while it still has `factory:triage` to start another
round. The factory edits its existing questions or spec comment rather than
creating a new conversation.

The first run for a repository builds its snapshot inline. This can take
several minutes. Later runs restore the snapshot and fetch the requested ref.

### Approve and implement the spec

Review the spec comment, then add `factory:spec-approved`.

Spec-to-PR reads the spec as it existed when the label was applied. It refuses
to continue if the spec was edited afterwards; remove and reapply the label
to approve the new version.

The stage:

1. implements the spec in a Sandbox;
2. runs every configured `verify` command;
3. asks the implementer to repair failures, up to `limits.repairRounds`;
4. validates the collected changes on the host; and
5. publishes `factory/issue-<number>` and opens a draft PR.

The PR describes the approved spec, implementation, and verification. It
references the issue without closing it.

### Review a pull request

Add `factory:pr-review` to any open PR, including one the factory created.

PR Reviewer checks out the labeled head commit, runs `verify`, then inspects
security, correctness, performance, and tests in one read-only agent call. It
posts one COMMENT review with a risk tier, summary, verification results, and
inline comments where GitHub permits them.

The review is pinned to the head SHA from the webhook. Label the PR again to
review a newer commit.

### Cancel or restart

Comment this as the first line on an issue or PR:

```text
/factory cancel
```

Only someone with `minimumPermission` can cancel. To restart a stage, remove
its label and add it again. The new run claims the subject, cancels the prior
task when possible, and the prior run stops at its next ownership checkpoint.

While a stage is active, the issue or PR has `factory:working`. Its status
comment shows progress, the current run ID, and final links.

## Inspect a run

The status comment names the run ID. Find that run under `factory-workflows`
in the Render Dashboard for its logs, inputs, and result.

Deliveries, stage outcomes, and each agent's model, turns, token usage, and
reported cost are also appended to the `events` table. Query them with
`render psql factory-db`, for example:

```sql
select created_at, type, subject, payload
from events
where trace_id = '<run id>'
order by id;
```

## Run locally

Local development needs Docker and Render CLI 2.29 or later. It still uses
real Render Sandboxes, the real GitHub App, and a real model. Use a separate
test repository and preferably a separate App.

```bash
npm ci
cp .env.example .env
```

Fill `.env`; `setup:app --write-env` can provide the GitHub values. Start each
process in its own terminal:

```bash
# Terminal 1: Postgres on localhost:55432
npm run dev:postgres

# Terminal 2: create or update the events table
npm run db:migrate

# Terminal 3: Workflows task server (localhost:8120 by CLI default)
npm run dev:workflows

# Terminal 4: gateway on localhost:3000
RENDER_USE_LOCAL_DEV=true npm run dev:gateway
```

`RENDER_USE_LOCAL_DEV=true` sends task starts to the local Workflows server.
The Workflows process still creates Sandboxes in Render.

GitHub needs a public HTTPS webhook URL. Expose port 3000 with a tunnel, then
point the App at it:

```bash
cloudflared tunnel --url http://localhost:3000
npm run setup:github -- --gateway-url https://<tunnel-host>
```

An App has one webhook URL. Repointing a production App disables production
deliveries until it is restored.

You can bypass GitHub when testing a task:

```bash
render workflows tasks list --local
render workflows tasks runs start --local \
  --task <task> \
  --input='[{...}]'
```

Task input schemas are in
[`app/schemas/tasks.ts`](../app/schemas/tasks.ts).

## Check changes

```bash
npm run check
```

`npm run check` runs Biome, TypeScript, and every Vitest test. Tests fake
GitHub, Render, Postgres, and models; they do not call live services.

For one test:

```bash
npx vitest run tests/gateway.test.ts
```

When applicable, also run:

```bash
shellcheck sandbox/*.sh sandbox/build/*.sh
render blueprints validate render.yaml
npm audit --omit=dev --audit-level=high
```

CI runs the normal checks and shellcheck, audits production dependencies, and
validates `render.yaml` when its Render credentials are configured.

## Operate it

### After a change

- `factory.config.ts`, application code, or prompt changes require a deploy
  of the affected services.
- Runner or `sandbox/` changes are bundled into repository snapshots.
  They reach a repository on its next base-branch push or manual
  `refresh-snapshot` run.
- A changed `install` command is detected when a Sandbox opens and causes a
  reinstall. The next base-branch push bakes it into a new snapshot.
- Added repositories or renamed labels require another
  `npm run setup:github`.
- GitHub permission or event changes require updating the App and passing
  `doctor`.

### Troubleshooting

- **No status comment:** inspect the App's recent webhook deliveries. Confirm
  the webhook is active, the URL ends in `/webhooks/github`, and the
  repository appears in `factory.config.ts`.
- **A delivery gets 401:** `GITHUB_WEBHOOK_SECRET` differs between the App and
  gateway.
- **A delivery gets 502:** the gateway could not start the task. Check
  `RENDER_API_KEY`, `RENDER_WORKFLOW_SLUG`, and the Workflows service.
- **A run is rejected:** the triggering actor does not have
  `minimumPermission`.
- **Snapshot build fails:** inspect `refresh-snapshot` or the first stage run.
  Common causes are an invalid install command, tracked files changed by
  install, missing App installation, or a Sandbox verification failure.
- **The stage fails closed around ownership:** Postgres could not append or
  read `run.claimed`. Restore the database and relabel to retry.
- **The agent cannot start:** verify the selected model's provider key in
  `factory-workflows` and run `doctor -- --service workflows`.
- **Publishing refuses the diff:** inspect the task logs for workflow files,
  unsafe paths, symlinks, submodules, file-count or size limits, or a tree-SHA
  mismatch.

### Operating limits

Sandbox API calls share the workspace's 100-requests-per-minute limit. The
client paces calls, but expect a few concurrent stages rather than dozens.
The README's [Limits](../README.md#limits) and the architecture guide's
[residual risks](2_ARCHITECTURE.md#residual-risks) cover the rest, including
spend and PR code execution.

See [3_TAKEAWAYS.md](3_TAKEAWAYS.md) for the operational and security patterns
worth carrying into other agent systems.
