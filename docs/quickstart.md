# Quickstart

The fastest path is to ask a coding agent to follow the
[Setup runbook](runbooks/setup.md). It gives the agent exact commands,
verification criteria, recovery steps, and explicit checkpoints for actions
only you should take.

## What you need

- a fork of this repository;
- a Render workspace with Sandboxes access in Oregon;
- a Render API key;
- a dedicated, spend-capped Anthropic API key;
- admin access to each target GitHub repository; and
- the Node.js version in [`.node-version`](../.node-version).

The Blueprint creates paid Render resources: a Starter web service, a
Workflows service, and a Basic-256mb Postgres database. Sandbox and model
usage are charged separately.

## What the setup agent will do

The agent will:

1. inspect the repository and run its checks;
2. configure target repositories in `factory.config.ts`;
3. guide creation and installation of a GitHub App;
4. guide deployment of the Render Blueprint;
5. connect the webhook and create labels;
6. verify both deployed services with `doctor`; and
7. run one approved Triage smoke test.

The agent must stop for your confirmation before:

- committing or pushing configuration unless already authorized;
- creating the GitHub App;
- installing it on repositories;
- creating paid Render resources;
- entering secrets;
- activating the webhook; or
- creating and labeling a test issue.

Never paste API keys, private keys, or webhook secrets into chat. Enter them
directly in `.env` or the Render Dashboard.

## Start

Open the fork in your coding agent and ask:

```text
Set up Software Factory by following docs/runbooks/setup.md.
Configure <owner/repository> using base branch <branch>.
Stop at every human checkpoint and do not expose secrets.
```

Setup is complete only when both deployed `doctor` checks pass and applying
`factory:triage` produces an App-authored status comment.

## Continue

- [Setup runbook](runbooks/setup.md): complete agent execution protocol.
- [Configuration](configuration.md): repositories, models, labels, and limits.
- [Operations](operations.md): logs, cancellation, snapshots, and troubleshooting.
- [Architecture](architecture.md): state ownership and trust boundaries.
- [Contributing](../CONTRIBUTING.md): local development and implementation changes.
