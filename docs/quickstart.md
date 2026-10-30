# Quickstart

Use a coding agent for the first deployment. The
[Setup runbook](runbooks/setup.md) gives it the commands, checks, recovery
steps, and points where you must take over.

## Before you start

Prepare:

- a fork of this repository;
- a Render workspace with Sandboxes access in Oregon;
- a Render API key;
- a dedicated Anthropic API key with a provider-enforced spend limit;
- admin access to each target GitHub repository;
- Issues enabled on each target repository (Settings > General > Features); and
- the Node.js version in [`.node-version`](../.node-version).

The Blueprint creates paid resources: a Starter web service and a Workflows
service. Sandbox and model usage are billed separately.

Setup checks the pinned Node version locally, then checks workspace and
repository access before writing Render environment groups. Disabled Issues
or an inaccessible base branch blocks that preflight. See the
[pre-deployment check](runbooks/setup.md#phase-6-create-the-render-env-groups)
for the command and its limits; model and Sandbox execution are verified by
the separately approved smoke test.

## Start the setup

Open your fork in a coding agent and use this prompt:

```text
Set up software-factory by following docs/runbooks/setup.md.
Configure <owner/repository> with base branch <branch>.
Stop at every human checkpoint. Do not print or expose secrets.
```

The agent will configure the fork, create a GitHub App, create the Render
environment groups, deploy the Blueprint, connect the webhook, verify the
deployment, and guide one Triage smoke test.

You must take over for:

- approval to commit or push;
- GitHub App creation and installation;
- secret entry;
- paid Render resource creation;
- webhook activation; and
- creation or labeling of the smoke-test issue.

You enter each secret once, in local `.env`: the Render API key and the
Anthropic API key. The GitHub App setup writes its own values there.
`npm run setup:render` copies them into
[environment groups](configuration.md#environment-groups) that both services
link, so the Blueprint form asks for nothing. Never put secrets in chat,
issues, commits, or command output.

## Definition of done

Setup is complete when:

- `factory-gateway` and `factory-workflows` are live;
- the GitHub App is installed and its webhook is active;
- gateway `doctor` passes in its Render Shell and Workflows `doctor` passes
  locally with the deployed service's values; and
- applying `factory:triage` produces an App-authored status comment and a
  useful outcome.

software-factory has no web UI. You use it through labels and comments in
GitHub. Opening the `factory-gateway` URL in a browser shows only a short
message that the gateway is running.

## Next steps

- [Run the full pipeline](runbooks/setup.md#optional-run-the-full-pipeline)
  — take a small request from issue to spec, draft pull request, and review,
  step by step or with `factory:autopilot`.
- [Configuration](configuration.md) — change settings, follow or cancel runs,
  check a deployment, and manage snapshots.
- [Architecture](architecture.md) — understand state, coordination, and
  security.
- [Extension runbook](runbooks/extend.md) — add agents, Workflows tasks, or
  GitHub triggers.
