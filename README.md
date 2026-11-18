# software-factory

software-factory is an extensible template for building GitHub-native coding agent
workflows on Render. It includes a complete issue-to-PR workflow that you can
run, change, or use as the foundation for your own automations.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy-template/api/github/start?template_repo=software-factory)

## Setup

Setup is agent-guided:

1. Check the prerequisites in the [Quickstart](docs/quickstart.md).
2. Ask a coding agent to follow the [Setup runbook](docs/runbooks/setup.md).
3. Approve the GitHub, secret, and paid-resource checkpoints when prompted.

**What software-factory solves for you:**
1. Authenticating GitHub events and routing them to durable Render Workflows tasks.
2. Running agents and tools inside short-lived, isolated Render Sandboxes.
3. Handling overlapping runs, cancellation, cleanup, and idempotency.
4. Validating typed agent output and safely publishing proposed code to GitHub.
5. Recording every delivery, task run, and agent run in a Postgres event log, and streaming agent runs live.
6. Providing deployment configuration, setup scripts, and health checks.

**What software-factory leaves for you:**
1. The agents, prompts, and workflow logic for your use case.
2. Repository-specific install and verification commands.
3. The GitHub triggers, approval gates, and permissions your workflow needs.
4. Model selection, budgets, and evaluation strategy.
5. Channel integrations.
6. Data your workflows persist beyond the factory's event log.

## Included workflows

- **Triage:** reads the issue, discussion, and repository. It asks questions,
  writes a specification, or declines the request.
- **Spec-to-PR:** implements the approved specification, runs your verification
  commands, and opens a draft pull request.
- **PR Reviewer:** runs verification and reviews security, correctness,
  performance, and tests. It posts a non-approving GitHub COMMENT review.

## How it works

### Architecture

The factory deploys as one Render project with two services and a database,
and creates Sandboxes as it needs them:

- **GitHub** holds the conversation: issues, labels, specs, pull requests, and
  reviews. People work there, and the factory writes its results back.
- **Gateway** (`factory-gateway`, a web service) verifies each GitHub webhook,
  records it, and starts the matching Workflows task. It also serves the live
  event streams. It holds no GitHub credentials and runs no model.
- **Workflows** (`factory-workflows`, a Render Workflows service) runs each
  task, such as Triage or Spec-to-PR, as a durable task run. It's the only
  part that writes to GitHub, and it decides every repository, branch, and
  pull request the factory touches.
- **Sandboxes** run the agents and your verification commands, each in an
  isolated VM created from a snapshot pre-baked with the repository, its
  dependencies, and the agent runner. A Sandbox reaches only an HTTPS
  allow-list and holds no GitHub write or database credentials.
- **Postgres** (`factory-db`) is the source of truth: an append-only event log
  of every delivery, task run, and agent run, with tables derived from it. It
  records which run owns each issue or pull request, and the status comment
  on GitHub is rendered from it.

A label on an issue becomes a webhook to the gateway, which starts a task in
Workflows. The task opens a Sandbox, runs an agent there, records what happens
in Postgres, and writes the result back to GitHub.

### Labels

The factory uses GitHub labels to trigger actions:

| Label | Apply to | Starts |
| --- | --- | --- |
| `factory:triage` | Issue | Triage, which asks questions, drafts a spec, or declines. |
| `factory:spec-approved` | Issue | Spec-to-PR, which implements the current spec and opens a draft pull request. |
| `factory:pr-review` | Pull request | PR Reviewer, which reviews the pull request's head commit. |
| `factory:autopilot` | Issue | All three stages in one Render Workflow, with no approval between them. |

Each label is a command. The factory removes it when the run starts, so apply
it again to run the stage again. The factory shows `factory:working` while a
run is in progress.

- **Approval:** apply `factory:spec-approved` after you review a spec.
- **Replies:** after Triage asks questions or drafts a spec, a comment resumes
  it, so answer the questions or ask for changes in the issue. Comments at
  other times start nothing. Autopilot waits the same way when Triage asks
  questions.
- **One run at a time:** starting a run on an issue or pull request stops
  whatever was running there.
- **Cancel:** comment `/factory cancel` on the issue or pull request.
- **Factory pull requests:** a draft pull request the factory opens belongs to
  its issue. A label or `/factory cancel` on it acts on the issue's work, and
  its status appears on the issue.
- **Permission:** only people with `minimumPermission` on the repository
  (`write` by default) can start a run.

Label names and `minimumPermission` are set in `factory.config.ts`.


### Watch agents work

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
- Change repositories, verification commands, permissions, and limits in
  `factory.config.ts`, and agent models in `app/agents/models.ts`.

The Sandbox runner, run lifecycle, GitHub client, formatting helpers, and
publishing boundary are reusable building blocks. Start with the
[extension runbook](docs/runbooks/extend.md), which covers the required files,
tests, authority rules, deploys, and snapshot refreshes.

## Security

- Model-directed code and tools run inside Sandboxes, not on the Workflow task.
- GitHub write credentials never enter a Sandbox.
- Clone and fetch credentials are read-only and removed before repository code
  or agents run.
- Models propose typed results and file trees. Code in the Workflows service
  chooses every repository, ref, branch, issue, pull request, and write target.
- Publishing rejects unsafe paths and modes, workflow files, symlinks,
  submodules, oversized changes, and branches with human commits.
- GitHub must reproduce the candidate tree SHA before the factory publishes
  it.
- Sandboxes reach only an HTTPS allow-list: GitHub, the agents' model APIs,
  and the hosts each repository's install and verify commands need.
- Nothing in a Sandbox holds a database credential. The Workflows host
  records agent runs, and their outcomes and costs come from its own reading
  of the result.

Allowed hosts can still carry data out, and the model key exists in runner
memory during a call. Read the [trust boundaries](docs/architecture.md#trust-boundaries)
and [residual risks](docs/architecture.md#residual-risks) before using private
code or untrusted pull requests.

## Limits

- Verification runs shell commands. Browser testing is not included.
- Turn limits and timeouts bound execution, but the factory has no hard dollar
  budget.
- Anyone with `minimumPermission` can start model spend.
- PR Reviewer runs configured commands against the labeled pull request.
- Sandbox API calls count against the Render workspace's request limit.

## Documentation

- [Quickstart](docs/quickstart.md) — what you need and how to start setup.
- [Setup runbook](docs/runbooks/setup.md) — agent protocol for the first
  deployment.
- [Configuration](docs/configuration.md) — settings, environment groups, run
  control, event streams, snapshots, deployment checks, and the database.
- [Architecture](docs/architecture.md) — execution, state, the event log,
  coordination, and trust boundaries.
- [Extension runbook](docs/runbooks/extend.md) — add agents, Workflows tasks,
  and GitHub triggers.
- [Contributing](CONTRIBUTING.md) — local development and verification.

## License

MIT. See [LICENSE](LICENSE).
