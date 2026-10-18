# software-factory

A self-hosted factory that turns a labeled GitHub issue into a spec, a draft pull request, and a COMMENT review. It runs on your own Render workspace: one web service, one Workflows service, Render Sandboxes, and Postgres.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/software-factory)

You label an issue and the factory takes it from there. An agent reads the issue and your code in an isolated Sandbox, then asks questions or posts a spec. Approve the spec with a second label, and another agent implements it, runs your verify commands, reviews its own change, and opens a draft PR. Label any PR, including the factory's own, and four specialist reviewers post one COMMENT review. Every step stops at a human decision. The factory never approves or merges anything.

The button deploys this repository as is, which acts on the example repository in `factory.config.ts`. To point it at your own repositories, fork first and deploy your fork.

## How it works

| Resource | Render type | Job |
|---|---|---|
| `factory-gateway` | Web Service | Verifies GitHub webhooks, starts the matching Workflows task, serves the trace UI |
| `factory-workflows` | Workflows | Runs every task: the three phases, agents, snapshot refresh, and cancel |
| `factory-db` | Postgres | An append-only `events` table for observability, cost, and evals. No decision reads it |

Each run opens a Sandbox restored from a per-repository snapshot (your code, with dependencies installed), runs its agents there, and terminates the Sandbox when it finishes. Agents never hold a GitHub write credential: the Workflows task publishes their changes through GitHub's API after checking them. There is no queue, no dispatcher, and no cron job. Render Workflows owns run state, and GitHub holds the conversation. See [docs/architecture.md](docs/architecture.md).

## Prerequisites

- A Render workspace with **Sandboxes** early access. Everything deploys in **Oregon**, the only region Sandboxes run in during early access.
- A **Render API key** for that workspace. The gateway uses it to start tasks; the Workflows service uses it to manage Sandboxes and cancel runs.
- An **Anthropic API key**. Use a dedicated, spend-capped key: it enters the Sandbox during agent runs (see [docs/security.md](docs/security.md)).
- A **GitHub App**, which `npm run setup:app` creates for you, installed on each repository the factory acts on.
- Node.js 22.19 or later locally, to run the setup scripts.

## Set up

Setup runs in a fixed order because the App and the gateway each need something from the other: the App's credentials go into the Blueprint, and the gateway's URL goes into the App's webhook.

1. **Fork and configure.** Fork this repository and list your repositories in `factory.config.ts`, each with its base branch, install command, and verify commands (see [docs/configuration.md](docs/configuration.md)). Commit and push.
2. **Create the GitHub App.** Run `npm ci`, then `npm run setup:app -- --write-env` (add `--org <org>` to create it in an organization). It opens a page that creates the App through GitHub's manifest flow, then prints `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET`. `--write-env` also saves them to `.env`. The App's webhook starts out inactive.
3. **Install the App** on every repository in `factory.config.ts`, using the link the script prints.
4. **Deploy the Blueprint.** Create a Blueprint from your fork in the Render Dashboard, or click the button above. Paste the values from step 2, your Render API key, and your Anthropic key into the form. `RENDER_WORKSPACE_ID` is optional when the key can see only one workspace.
5. **Connect the webhook and create the labels.** Once the gateway is live, run `npm run setup:github -- --gateway-url https://<gateway>.onrender.com`. It points the App's webhook at the gateway and creates the factory's labels on each repository.
6. **Activate the webhook.** GitHub's API can't turn an App webhook on, so open the App's settings page (the script prints the link), check **Webhook > Active**, and save.
7. **Check everything.** Run `npm run doctor`. It checks the environment, the App's permissions and webhook, each repository's installation and labels, Postgres, and the registered tasks, without printing secrets. Run it in each service's Render Shell (`npm run doctor -- --service gateway` or `--service workflows`) to check the deployed environment.

The first run on a repository builds its snapshot inline, which takes a few minutes. After that, each push to the base branch rebuilds it in the background.

[docs/getting-started.md](docs/getting-started.md) covers each step in more detail, plus local development.

## Use it

| To | Do this | The factory |
|---|---|---|
| Triage an issue | Add `factory:triage` | Asks up to five questions, posts a spec, or declines. Reply on the issue and it runs again |
| Implement a spec | Add `factory:spec-approved` | Implements the spec as it stood when you applied the label, verifies it, and opens a draft PR on `factory/issue-<n>` |
| Review a PR | Add `factory:pr-review` | Runs your verify commands and posts one COMMENT review on the labeled commit |
| Stop a run | Comment `/factory cancel` | Cancels the run in progress on that issue or PR |
| Rerun a phase | Remove the label and add it again | Starts a fresh run. The newest run wins: it cancels any earlier run on the same issue or PR |

Only people with at least `write` permission on the repository can start or cancel runs (`minimumPermission` in `factory.config.ts`). While a run is active, the issue or PR carries `factory:working`.

## What you get back

- **A status comment** on each issue or PR, updated as the run progresses, with its outcome and links when it finishes.
- **Questions or a spec** from Triage. The spec is a comment with the problem, goals and non-goals, numbered acceptance criteria, the approach, the files likely to change, a test plan, and risks. Revising it edits the same comment. If you edit the spec after approving it, Spec-to-PR refuses to run until you approve it again.
- **A draft PR** from Spec-to-PR, with the spec, what changed, the verify results, and the self-review's notes. It references the issue without closing it.
- **A COMMENT review** from PR Reviewer: a risk tier, a summary, verify results, and inline comments where GitHub can place them.
- **A trace** of every run in the gateway's trace UI at `/ui`: deliveries, phases, each agent's turns and cost. Sign in with the gateway's `FACTORY_ADMIN_TOKEN` (generated by the Blueprint, shown in the Dashboard).

## Cost

Each run has a dollar budget, `limits.perRunUsd` in `factory.config.ts` ($20 by default). It covers every agent the run calls, including ones that fail. Each agent call gets what's left, and an agent stops when its share is spent. PR Reviewer splits the budget so the four specialists, running in parallel, can't spend each other's share or the synthesizer's.

Agents pick a model by tier. The default tiers are Anthropic's:

| Tier | Default model | Agents |
|---|---|---|
| `large` | `anthropic/claude-opus-5` | spec writer, implementer |
| `medium` | `anthropic/claude-sonnet-5` | triage, self-review, the four specialist reviewers, synthesizer |
| `small` | `anthropic/claude-haiku-4-5` | none yet |

Spec-to-PR is the expensive phase: the implementer can run once, plus once per repair round (`limits.repairRounds`), plus once more if self-review asks for a revision. Render charges separately for the services, Postgres, Workflows task runs, and Sandbox time.

## What it won't do

- **Approve, request changes, mark a PR ready, or merge.** Automation ends at a draft PR and a COMMENT review.
- **Chain phases automatically.** A human applies each label.
- **Test in a browser.** Verification is the commands you configure, run in the Sandbox.
- **Change GitHub Actions workflows.** Publishing refuses changes under `.github/workflows/`, symlinks, submodules, more than `limits.maxChangedFiles` files, and files over `limits.maxFileBytes`.
- **Scale without limit.** The Sandbox API allows 100 requests a minute per workspace, shared with everything else in that workspace. Opening a Sandbox and running agents in it uses a handful of requests each, so expect a few concurrent runs per workspace, not dozens.

## Docs

- [Getting started](docs/getting-started.md): deploy, local development, checks, and evals
- [Architecture](docs/architecture.md): the resources, how a webhook becomes a run, state, snapshots, agents, and publishing
- [Configuration](docs/configuration.md): every `factory.config.ts` key and environment variable
- [Security](docs/security.md): the invariants, where each is enforced, and the residual risks
- [Agents](docs/agents.md): adding or changing an agent or a phase, and how evals work
- [Redesign](docs/redesign.md): why the factory is built this way
- [AGENTS.md](AGENTS.md): a guide for coding agents working on this repository

## License

MIT. See [LICENSE](LICENSE).
