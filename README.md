# software-factory

[![Render](https://img.shields.io/badge/Render-000?style=flat-square&logo=render&logoColor=FFF&labelColor=000&color=000)](https://render.com/docs/workflows)
[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

software-factory is a GitHub-native coding agent template for Render. AI agents
triage issues, write specs, implement them in isolated Render Sandboxes, and
review pull requests. You make the judgment calls.

It's a foundation, not a finished product. The template handles authenticating
GitHub events, running agents in isolated Sandboxes, coordinating overlapping
runs and cancellation, validating agent output, publishing code safely, and
recording every run. You bring the agents, prompts, triggers, approval gates,
and channels your workflow needs.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy-template/api/github/start?template_repo=software-factory)

## How it works

- **Triage** reads the issue, the discussion, and the repository, then asks
  questions, drafts a spec, or declines. A reply to its questions, or a request
  for changes to its spec, resumes it.
- **Spec-to-PR** implements the approved spec, runs your verification
  commands, repairs failures a bounded number of times, and opens a draft pull
  request.
- **PR Reviewer** runs your verification commands against a pull request and
  reviews security, correctness, performance, and tests. It posts one COMMENT
  review and never approves or requests changes.
- **Autopilot** runs Triage and Spec-to-PR with no approval between them, then
  starts PR Reviewer on the draft pull request.

Each stage is a Render Workflows task that runs its agents in its own Sandbox,
created from a snapshot pre-baked with your repository, its dependencies, and
the agent runner. Agents propose typed results and file trees; code in the
Workflows service checks them and decides every repository, branch, issue, and
pull request the factory touches.

The factory deploys as one Render project:

- **Gateway** (`factory-gateway`, a web service) verifies each GitHub webhook,
  records it, and starts the matching Workflows task. It also serves the live
  event streams. It holds no GitHub credentials and runs no model.
- **Workflows** (`factory-workflows`) runs each task as a durable task run.
  It's the only part that writes to GitHub.
- **Sandboxes** run the agents and your verification commands in isolated VMs.
- **Postgres** (`factory-db`) is the source of truth: an append-only event log
  of every delivery, task run, and agent run. It records which run owns each
  issue or pull request, and the status comment on GitHub is rendered from it.

## How work arrives

Apply a label to start a stage:

| Label | Apply to | Starts |
| --- | --- | --- |
| `factory:triage` | Issue | Triage |
| `factory:spec-approved` | Issue | Spec-to-PR, on the issue's current spec |
| `factory:pr-review` | Pull request | PR Reviewer, on the pull request's head commit |
| `factory:autopilot` | Issue | Triage and Spec-to-PR, then PR Reviewer on the draft pull request |

- **Labels are commands.** The factory removes a label when its run starts, so
  apply it again to run the stage again. It shows `factory:working` while a run
  is in progress.
- **Replies resume Triage.** After Triage asks questions or drafts a spec, a
  comment on the issue resumes it. Comments at other times start nothing.
  Autopilot waits the same way when Triage asks questions.
- **One run at a time.** Starting a run on an issue or pull request stops
  whatever was running there.
- **Cancel** by commenting `/factory cancel` on the issue or pull request.
- **Each issue and pull request stands alone.** Work runs on the issue or pull
  request it acts on, and its status appears there. Follow, cancel, or rerun
  the review Autopilot starts on its draft pull request like any other.
- **A push to a base branch** refreshes that repository's Sandbox snapshot.

Only people with `minimumPermission` on the repository (`write` by default)
can start a run.

## Security

Credentials stay out of reach of the agents:

- GitHub write credentials never enter a Sandbox. Clone and fetch credentials
  are read-only and removed before repository code or agents run.
- Sandboxes reach only an HTTPS allow-list: GitHub and the agents' model APIs.
  Add anything your repository's install and verify commands need.
- Nothing in a Sandbox holds a database credential. The Workflows host records
  agent runs, and their outcomes and costs come from its own reading of the
  result.
- Agents load no instructions, skills, or extensions from the repository.
- Publishing rejects unsafe paths and modes, workflow files, symlinks,
  submodules, oversized changes, and branches with human commits, and GitHub
  must reproduce the candidate tree SHA before the factory publishes it.

Allowed hosts can still carry data out, and the model key exists in runner
memory during a call. Read the [trust boundaries](docs/architecture.md#trust-boundaries)
and [residual risks](docs/architecture.md#residual-risks) before using private
code or untrusted pull requests.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy-template/api/github/start?template_repo=software-factory)

The [Blueprint](render.yaml) creates a `software-factory` project with
`factory-gateway` (a Starter web service), `factory-workflows` (a Workflows
service), and `factory-db` (a Basic-256mb Postgres database). Sandbox and model
usage are billed separately.

Setup is agent-guided. Prepare a fork of this repository, a Render workspace
with Sandboxes access, a Render API key, an Anthropic API key with a spend
limit, and admin access to each target repository. Then open your fork in a
coding agent:

```text
Set up software-factory by following docs/runbooks/setup.md.
Configure <owner/repository> with base branch <branch>.
Stop at every human checkpoint. Do not print or expose secrets.
```

The [Setup runbook](docs/runbooks/setup.md) walks the agent through:

1. Configuring your repositories in `factory.config.ts` and publishing the fork.
2. Creating and installing the GitHub App (`npm run setup:app`).
3. Creating the Render environment groups from `.env` (`npm run setup:render`).
4. Applying the Blueprint, then linking the database to Workflows
   (`npm run setup:render -- --link-database`).
5. Configuring the App's webhook and labels (`npm run setup:github`) and
   activating the webhook.
6. Checking both services with `npm run doctor`, then smoke-testing Triage.

You take over at each checkpoint: committing, creating the App, entering
secrets, approving paid resources, activating the webhook, and labeling the
first issue. See the [Quickstart](docs/quickstart.md) for the full list.

Configure each repository in [`factory.config.ts`](factory.config.ts):

| Setting | Required | What it does |
| --- | --- | --- |
| `baseBranch` | Yes | Branch used for Triage, implementation, and snapshots |
| `verify` | Yes | Commands that must pass before publishing, and that PR Reviewer runs |
| `install` | No | Dependency command, run after clone credentials are removed |
| `egress` | No | Extra HTTPS hosts the repository's Sandboxes may reach, or `"allow-all"` |

Labels, `minimumPermission`, and limits are set in the same file, with their
defaults listed in [Configuration](docs/configuration.md#labels-permission-and-limits).
Agent models are set in [`app/agents/models.ts`](app/agents/models.ts), and
secrets and environment groups are covered in [Configuration](docs/configuration.md).

## Watch agents work

Every agent run is recorded in Postgres with its messages, tool calls, usage,
and cost. The gateway streams them as server-sent events, with the model's
text as it's written. Follow everything on an issue or pull request with the
`EVENTS_READ_TOKEN` that `npm run setup:render` saved to `.env`:

```bash
curl -N -H "Authorization: Bearer $EVENTS_READ_TOKEN" \
  https://<gateway-host>/threads/github/<owner>/<repo>/issue/<number>/stream
```

Use `pr` for a pull request. A dropped connection resumes where it left off
when the client sends the last event ID it saw as `Last-Event-ID`. See
[Event streams](docs/configuration.md#event-streams) for the per-run endpoint
and the event types.

## Local development

Local development uses real Render Sandboxes, a real GitHub App, and a real
model, so use a test repository and, when possible, a separate App:

```bash
npm ci
cp .env.example .env
npm run dev:workflows                               # terminal 1
RENDER_USE_LOCAL_DEV=true npm run dev:gateway       # terminal 2
```

Before you push a change to the factory itself:

```bash
npm run check   # lint, typecheck, and tests; GitHub, Render, and models are faked
```

See [Contributing](CONTRIBUTING.md) for exposing the gateway to GitHub,
starting tasks directly, and the real-Postgres tests.

## Extend the template

The built-in agents and tasks are examples of the template's extension model:

- Add or replace an agent with a Markdown prompt, a harness (agent library and
  model), a bounded Zod output schema, and the minimum tools it needs.
- Run agents on another agent library by adding a harness adapter.
- Define a GitHub task for work attached to an issue or pull request.
- Add a plain Workflows task for maintenance or other work without an issue
  or pull request.
- Route new GitHub events, labels, or commands through the authenticated
  gateway.
- Add a channel beside GitHub, such as Slack or Linear: verify its events in
  the gateway and key its conversations as `<channel>:<id>` threads in
  `app/threads/`. The event log, thread ownership, and live streams work for
  any channel; you add its tasks, permission check, and status updates.

The Sandbox runner, run lifecycle, GitHub client, formatting helpers, and
publishing boundary are reusable building blocks. Start with the
[extension runbook](docs/runbooks/extend.md), which covers the required files,
tests, authority rules, deploys, and snapshot refreshes.

## Limits

- Verification runs shell commands. Browser testing is not included.
- Turn limits and timeouts bound execution, but the factory has no hard dollar
  budget.
- Anyone with `minimumPermission` can start model spend.
- PR Reviewer runs configured commands against the labeled pull request.

## Resources

- [Quickstart](docs/quickstart.md) and [Setup runbook](docs/runbooks/setup.md)
- [Configuration](docs/configuration.md): settings, environment groups, run
  control, event streams, snapshots, deployment checks, and the database
- [Architecture](docs/architecture.md): execution, state, the event log,
  coordination, and trust boundaries
- [Extension runbook](docs/runbooks/extend.md)
- [Render Workflows](https://render.com/docs/workflows),
  [Render Sandboxes](https://render.com/docs/sandboxes), and
  [Blueprints](https://render.com/docs/blueprint-spec)

## License

MIT. See [LICENSE](LICENSE).
