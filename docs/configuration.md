# Configuration

[`factory.config.ts`](../factory.config.ts) is committed application
configuration. The gateway and Workflows service both import it.

Edit it before the first deployment and whenever you change repositories,
labels, permissions, publishing limits, or Sandbox lifetimes.

## Example

```typescript
export default defineFactoryConfig({
  repos: {
    "acme/web": {
      baseBranch: "main",
      install: "npm ci",
      verify: ["npm run build", "npm test"],
      egress: ["registry.npmjs.org"],
    },
    "acme/api": {
      baseBranch: "main",
      install: "go mod download",
      verify: ["go test ./..."],
      egress: ["proxy.golang.org", "sum.golang.org"],
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
| `egress` | No | Extra HTTPS hosts this repository's Sandboxes may reach, or `"allow-all"` |

Use deterministic install commands such as `npm ci`. Snapshot creation fails
if installation changes a tracked file. Use `verify: []` only when you
intentionally want no command-based verification.

### Sandbox egress

Sandboxes reach the network through an HTTPS allow-list that Render enforces.
Every other destination fails as a reset connection. The factory builds each
list:

| Sandbox | Allowed hosts |
|---|---|
| Task Sandbox | `github.com`, every agent harness's model API, and the repository's `egress` |
| Snapshot builder | `github.com`, `deb.debian.org`, and the repository's `egress` |

List in `egress` every host the repository's `install` and `verify` commands
download from. Task Sandboxes need the list too: they reinstall when the
lockfiles change. Common hosts:

| Ecosystem | Hosts |
|---|---|
| npm | `registry.npmjs.org` |
| Go modules | `proxy.golang.org`, `sum.golang.org` |
| Go toolchain download | `go.dev`, `dl.google.com` |
| PyPI | `pypi.org`, `files.pythonhosted.org` |

A rule matches one exact hostname. Use `*.example.com` to admit its
subdomains; a wildcard may only be the leftmost label. Only HTTPS is admitted.
An invalid host stops both services at startup. An install that fails under
the allow-list names the allowed hosts in its error.

Set `egress: "allow-all"` to lift the restriction for one repository. Prefer
listing hosts: the allow-list is what stops dependency scripts and
prompt-injected agents from sending code or the model key to arbitrary
destinations.

Render fixes a Sandbox's policy when it is created, so an `egress` change
applies to the next Sandbox after a Workflows deploy. No snapshot refresh is
needed.

After adding a repository:

1. commit and deploy the configuration;
2. install the GitHub App on the repository;
3. run `npm run setup:github`; and
4. push to the base branch, start a factory task, or
   [refresh the snapshot directly](#refresh-a-snapshot).

## Labels, permission, and limits

| Setting | Default | Meaning |
|---|---|---|
| `labels.triage` | `factory:triage` | Starts Triage |
| `labels.specApproved` | `factory:spec-approved` | Starts Spec-to-PR |
| `labels.prReview` | `factory:pr-review` | Starts PR Reviewer |
| `labels.autopilot` | `factory:autopilot` | Runs Triage and Spec-to-PR, then starts PR Reviewer on the draft PR |
| `commandPrefix` | `/factory` | Prefix for commands such as `/factory cancel` |
| `minimumPermission` | `write` | Live repository permission required to start work |
| `limits.repairRounds` | `2` | Repair attempts after failed verification |
| `limits.maxChangedFiles` | `200` | Maximum files in a published change |
| `limits.maxFileBytes` | `1000000` | Maximum size of one changed file in bytes |
| `sandbox.timeoutSeconds` | `14400` | Provider-side Sandbox lifetime in seconds |

`minimumPermission` accepts `triage`, `write`, `maintain`, or `admin`, checked
at the start of every GitHub task. A rejected run leaves its trigger label in
place; an accepted run removes it immediately so reapplying starts a new run
(see [Workflow](architecture.md#workflow)).

`setup:github` also creates `factory:working`, which marks an active run and is
not a trigger. If you rename a trigger label, deploy both services and rerun
`npm run setup:github` (old labels are not removed).

Keep `sandbox.timeoutSeconds` at least as long as the longest Workflows task.

## Agent harnesses and models

Each agent runs on a harness: an agent library and its configuration, built by
an adapter in [`app/harness/`](../app/harness/). The built-in agents share two
harnesses from [`app/agents/models.ts`](../app/agents/models.ts):

```typescript
export const piSonnet = pi({ model: getBuiltinModel("anthropic", "claude-sonnet-5") });
export const piOpus = pi({ model: getBuiltinModel("anthropic", "claude-opus-5") });
```

Triage and PR Reviewer use `piSonnet`; the spec writer and implementer use
`piOpus`. Each value is named for its library and model. To change a model,
add or edit a value and rename it to match, or give one agent its own harness
in its definition. Model IDs are type-checked against the library's
catalog, so a typo fails `npm run typecheck`. The `pi` adapter also takes
`thinkingLevel` (`off`, `minimal`, `low`, `medium`, or `high`; default
`medium`).

The `pi` adapter runs Pi's coding agent SDK, `@earendil-works/pi-coding-agent`,
with its model catalog from `@earendil-works/pi-ai`. `package.json` pins
`pi-coding-agent`, `pi-ai`, and `pi-agent-core` to one exact version; upgrade
them together. Pi retries a model request that fails transiently up to twice
and compacts a conversation that nears the model's context window. Each retry
and compaction request counts toward the agent's turn limit.

Each harness declares the env var of its key, its `credential`. Setup and
`doctor` derive the keys they manage from the agents' harnesses, so a harness that needs a new key
needs no other configuration change. The `pi` adapter supports Anthropic
(`ANTHROPIC_API_KEY`), Google (`GEMINI_API_KEY`), and OpenAI
(`OPENAI_API_KEY`). After a harness change that needs a new key:

1. add the key to local `.env`;
2. run `npm run setup:render` to add it to the `software-factory-workflows`
   env group;
3. deploy `factory-workflows`; and
4. run `npm run doctor -- --service workflows`.

Each harness also declares its `egress`: the hosts its model requests go to.
Every task Sandbox's allow-list includes the hosts of all registered agents.
The `pi` adapter uses the host of the model's `baseUrl`, so switching
providers needs no egress change. Pass `egress` to `pi()` when a provider from
a custom `models` registry serves the model from another host, such as a
proxy. That registry's providers are added to Pi's catalog, each replacing a
built-in provider with the same ID.

### Tool support

Every harness gives the model the factory's own tools, so an agent's tools and
the read-only shell policy behave the same on any harness.

Use a key dedicated to this deployment with a provider-enforced spend limit.
The factory has no hard dollar budget.

## Environment variables

Local variables are listed in [`.env.example`](../.env.example). The
Blueprint supplies `RENDER_WORKFLOW_SLUG` and `DATABASE_URL` to the gateway
from the Workflows service and `factory-db`. Every other deployed value,
including Workflows' `DATABASE_URL`, comes from an
[environment group](#environment-groups).

### Gateway

| Variable | Purpose |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | Verify GitHub webhook signatures |
| `EVENTS_READ_TOKEN` | Authenticate readers of the [event streams](#event-streams); `npm run setup:render` generates it |
| `RENDER_API_KEY` | Start Workflows tasks |
| `RENDER_WORKFLOW_SLUG` | Address the deployed Workflows service |
| `DATABASE_URL` | Connect to the [database](#database); the Blueprint links it |
| `PORT` | HTTP port; defaults to `3000` |

### Workflows

| Variable | Purpose |
|---|---|
| `RENDER_API_KEY` | Manage Sandboxes, snapshots, and task cancellation |
| `RENDER_WORKSPACE_ID` | Workspace that owns Sandboxes and snapshots |
| `GITHUB_APP_ID` | Authenticate the GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Mint installation tokens |
| `DATABASE_URL` | Connect to the [database](#database); linked after the Blueprint is applied |
| `ANTHROPIC_API_KEY` | Call the default models; each agent's harness declares the key it needs |
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
| `software-factory-gateway` | `factory-gateway` | `GITHUB_WEBHOOK_SECRET`, `EVENTS_READ_TOKEN` |
| `software-factory-workflows` | `factory-workflows` | `RENDER_WORKSPACE_ID`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL` |

The gateway links no group that holds GitHub App credentials or a model key.
`DATABASE_URL` is copied into `software-factory-workflows` after the Blueprint
is applied (see [Database](#database)). `ENV_GROUPS` in
[`scripts/lib/requirements.ts`](../scripts/lib/requirements.ts) defines this
layout for setup and `doctor`.

Create or update the groups from local `.env` before applying the Blueprint:

```bash
npm run setup:render -- --workspace <tea-...>
```

The command runs the [pre-deployment checks](runbooks/setup.md#phase-6-create-the-render-env-groups)
before writing any group (use `npm run setup:preflight -- --workspace <tea-...>`
to run those checks alone). It updates only values that changed, leaves other
variables in each group alone, and never prints a secret. A second group with
the same name makes it stop, because a Blueprint links groups by name.

To rotate a secret, change it in `.env`, rerun `npm run setup:render`, and
redeploy the services that link the group.

### Create the groups in the Dashboard

To keep the Render API key out of local `.env`, create the groups by hand
before applying the Blueprint. In the workspace, open **Environment Groups**
and create each group in the table with the exact name and variables shown,
except `DATABASE_URL`: after the Blueprint is applied, copy the gateway's
`DATABASE_URL` into `software-factory-workflows`.
Paste values from `.env` or from their source without showing them in chat.
Workflows `doctor` still reads these values locally, so export them in the
shell where it runs.

## What must be redeployed

| Change | Required action |
|---|---|
| Repository, label, permission, or publishing limit | Deploy both services |
| Agent harness or model | Deploy `factory-workflows` |
| Prompt, agent definition, or Workflows service code | Deploy `factory-workflows` |
| Gateway routing or validation | Deploy `factory-gateway` |
| Label, App permission, or subscribed event | Run `npm run setup:github`; update the App when prompted |
| `app/runner/` or `app/harness/` sources | Deploy `factory-workflows`; each Sandbox gets the new runner payload when it opens |
| `sandbox/` | Deploy `factory-workflows`, then refresh each repository snapshot |
| Database migration in `app/db/migrations/` | Deploy both services; whichever starts first applies it |
| Repository `install` command or lockfiles | Refresh the snapshot, or let the next task reinstall |

## Upgrade an existing deployment

A deployment from before the event log has no database and no
`EVENTS_READ_TOKEN`. The gateway won't start without the token, so provision it
before the new code deploys:

1. Let running factory tasks finish, or comment `/factory cancel` on them.
2. With the new version checked out locally and your `.env` in place, run
   `npm run setup:render`. It adds `EVENTS_READ_TOKEN` to the
   `software-factory-gateway` group and saves it to `.env`.
3. Push the new version to the branch your Blueprint deploys, then sync the
   Blueprint. It creates the paid `factory-db` and gives the gateway its
   `DATABASE_URL`; the gateway applies the migrations when it starts.
4. Run `npm run setup:render -- --link-database`, then redeploy
   `factory-workflows`, so Workflows can reach the database.
5. Run `npm run doctor` for both services, as in [Check a deployment](#check-a-deployment).
6. Refresh every repository's snapshot (see [Refresh a snapshot](#refresh-a-snapshot)),
   because `sandbox/run-agent.sh` changed.
7. Restart issues that were waiting for a reply. The new database has no record
   of earlier runs, so a reply on an issue where Triage asked questions starts
   nothing. Apply `factory:triage` (or `factory:autopilot`) again; Triage
   rereads the whole conversation, including the answers.

Trigger labels are now removed when their run starts. Labels left on open
issues from the previous version no longer mean anything; remove them.

## Follow and control runs

Active issues and pull requests carry `factory:working`. The App-authored
status comment shows progress, the run ID, the [event stream](#event-streams)
path, and the final result. It is a view of the [database](#database): editing
or deleting it changes nothing, and the next update recreates it. Open that run
under `factory-workflows` in the Render Dashboard to inspect its input, logs,
and result.

In Postgres, `runs` holds each task run (`run_id`, `trace_id`, `task`, `state`,
`outcome`, `summary`, `sandbox_id`), including permission rejections; `threads`
holds each thread's latest `trace_id` and `run_id`; and `agent_runs` holds each
model session (`id`, `run_id`, `agent_id`, `model`, `state`, `turns`, `usage`,
`cost_usd`, `tool_calls`). Rows name their thread as
`github:owner/name#issue-12` or `github:owner/name#pr-34`:

```sql
select run_id, task, state, outcome, summary from runs where thread = 'github:owner/name#issue-12' order by started_at;
select t.thread, r.task, r.state from threads t join runs r on r.trace_id = t.trace_id where r.state = 'running';
select thread, sum(cost_usd) from agent_runs group by thread order by 2 desc;
```

To cancel a run, post `/factory cancel` as the first line of an issue or pull
request comment (requires `minimumPermission`):

```text
/factory cancel
```

Cancel takes over the thread, stops the active root workflow and child task,
terminates recorded Sandboxes, and clears runs left in `running` after a task
stopped. If Render doesn't confirm the cancel or a Sandbox termination, the
status comment names what's unconfirmed; comment `/factory cancel` again to
retry. Reapply the trigger label to restart work. Cancel acts on the issue or
pull request it's posted on: to stop the review Autopilot started, comment on
the draft pull request. See [Coordination](architecture.md#coordination) and
[Autopilot](architecture.md#autopilot).

## Event streams

The gateway serves server-sent events (SSE) to anyone with
`EVENTS_READ_TOKEN`, sent as `Authorization: Bearer <token>`:

| Endpoint | Delivers | Ends |
|---|---|---|
| `GET /threads/github/<owner>/<repo>/<issue\|pr>/<number>/stream` | Every event recorded about the issue or pull request, including every agent run on it | Never; disconnect when done |
| `GET /threads/<thread>/stream` | The same for any thread, by its URL-encoded key | Never; disconnect when done |
| `GET /agent-runs/<id>/stream` | One agent run, whose ID is the `agent_run:<id>` stream of its events | After `agent_run.finished` |

On GitHub, a thread key is `github:<owner>/<repo>#issue-<number>` or
`github:<owner>/<repo>#pr-<number>` (a factory draft pull request resolves to
its issue's stream; see [Coordination](architecture.md#coordination)). These
two requests read the same stream:

```bash
curl -N -H "Authorization: Bearer $EVENTS_READ_TOKEN" \
  https://<gateway-host>/threads/github/acme/web/issue/12/stream
curl -N -H "Authorization: Bearer $EVENTS_READ_TOKEN" \
  https://<gateway-host>/threads/github%3Aacme%2Fweb%23issue-12/stream
```

Each stream sends the stored events first, then the text so far of each
message the model is still writing as `live.partial`, then new events as they
happen. The SSE event name is the event type, such as `agent_run.started`,
`assistant.message`, `tool.call`, `tool.result`, `usage`, or
`agent_run.finished`; its data is the event as JSON. The model's text arrives
as `live.delta` events while it's written; they aren't stored, so replaying a
finished run shows only final messages.

Stored events carry an SSE ID. To resume after a dropped connection, send the
last one you received as `Last-Event-ID`, or as `?after=`. Each endpoint keeps
its own IDs, so don't reuse one across endpoints. Stream content includes
model output, tool output, and repository text: treat it as untrusted, and
share the token only with people allowed to read every repository the factory
works on.

## Snapshots

Each configured repository has a dependency-installed Sandbox snapshot. A
push to its base branch refreshes it. If no snapshot exists, the first task
builds one. A failed refresh does not delete the previous usable snapshot.

### Refresh a snapshot

Start the `refresh-snapshot` task with the repository, its GitHub App
installation ID, and the base branch's current commit (private repositories
require local Git credentials for `git ls-remote`):

```bash
git ls-remote https://github.com/<owner>/<name>.git refs/heads/<base-branch>

render workflows tasks runs start \
  <workflow-slug>/refresh-snapshot \
  --input='[{"repo":"<owner>/<name>","installationId":<id>,"sha":"<commit>"}]'
```

The installation ID is the number at the end of
`https://github.com/settings/installations/<id>` (or the equivalent
organization settings URL).

## Check a deployment

`doctor` is read-only, does not print secret values, and exits nonzero when a
required check fails or cannot be verified. This includes unreachable task APIs,
missing task registration, and installation permissions or events that have not
been accepted. The gateway intentionally skips GitHub checks because it has no
App credentials.

Webhook delivery is verified only when the latest attempt went to the configured
gateway and received a 2xx response. If no such evidence is available, confirm
Webhook > Active in the App's settings, save, and redeliver a ping from Advanced
before rerunning doctor. GitHub's API does not report the Active setting, so a
successful delivery proves delivery only at the reported time; it cannot guarantee
that the hook has not since been disabled.

From a local checkout, check the values in local `.env`:

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

## Database

The Blueprint creates `factory-db`, a Render Postgres 17 database on the paid
`basic-256mb` plan, because free databases expire after 30 days. Both services
read its internal URL as `DATABASE_URL`. The Blueprint links it to the
gateway. A Blueprint can't reference a database from a Workflows service, so
after the Blueprint is applied, this command copies the gateway's value into
the `software-factory-workflows` env group:

```bash
npm run setup:render -- --link-database
```

It never prints the value and is safe to rerun. `factory-workflows` reads the
value on its next deploy.

Each service applies pending migrations from `app/db/migrations/` when it
starts. An advisory lock lets only one apply them; the other waits and finds
nothing to do. Keep migrations additive (new tables, new nullable columns),
because the other service may still be running the previous code.

To run the services locally, set `DATABASE_URL` in `.env` to a local Postgres
or to `factory-db`'s external URL from its **Connect** tab with
`?sslmode=verify-full` appended. The local services migrate that database when
they start. `npm run setup:preflight -- --local` and `doctor` check that
`DATABASE_URL` connects and warn about migrations it hasn't applied yet.

To recreate the projection tables from the event log:

```bash
npm run db:rebuild
```

It replays every event in one transaction and keeps operational columns:
metadata a projection stores that isn't derived from events. Appends wait
until it commits. Run it in the gateway's Render Shell, or locally with the
external URL.
