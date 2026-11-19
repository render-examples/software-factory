# Quickstart

Use a coding agent for the first deployment. The
[Setup runbook](runbooks/setup.md) gives it the commands, checks, and human
checkpoints.

## Before you start

Prepare:

- a fork of this repository;
- a Render workspace with Sandboxes access in Oregon;
- a Render API key;
- a dedicated Anthropic API key with a provider-enforced spend limit;
- admin access to each target GitHub repository, with Issues enabled
  (Settings > General > Features); and
- the Node.js version in [`.node-version`](../.node-version).

The Blueprint creates paid resources: a Starter web service, a Workflows
service, and a Basic-256mb Postgres database. Sandbox and model usage are
billed separately.

## Start the setup

Open your fork in a coding agent and use this prompt:

```text
Set up software-factory by following docs/runbooks/setup.md.
Configure <owner/repository> with base branch <branch>.
Stop at every human checkpoint. Do not print or expose secrets.
```

You must take over for:

- approval to commit or push;
- GitHub App creation and installation;
- adding `RENDER_API_KEY` and `ANTHROPIC_API_KEY` to local `.env` (never put
  secrets in chat, issues, commits, or command output);
- applying the Blueprint and redeploying `factory-workflows` once its database
  is linked;
- webhook activation; and
- creation or labeling of the smoke-test issue.

## Definition of done

Setup is complete when:

- `factory-gateway` and `factory-workflows` are live;
- the GitHub App is installed and its webhook is active;
- `doctor` passes for both services; and
- applying `factory:triage` produces an App-authored status comment and a
  useful outcome.

software-factory has no web UI; you use it through labels and comments in
GitHub. Opening the `factory-gateway` URL in a browser shows only a short
message that the gateway is running.

## Next steps

- [Run the full pipeline](runbooks/setup.md#optional-run-the-full-pipeline)
  — take a small request from issue to spec, draft pull request, and review,
  step by step or with `factory:autopilot`.
- [Configuration](configuration.md) — change settings, manage environment
  groups, follow or cancel runs, check a deployment, and manage snapshots.
- [Architecture](architecture.md) — understand state, coordination, and
  security.
- [Extension runbook](runbooks/extend.md) — add agents, Workflows tasks, or
  GitHub triggers.
