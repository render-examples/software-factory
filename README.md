# software-factory

A self-hosted production-ready software factory. Built on Render Postgres, Workflows, Sandboxes, and Web services. 

Fork the repo, extend with your logic, and deploy full-stack coding agents with fine-grained control and full observability.

## Four workflows come out-of-the-box
1. triage: an agent receives a GitHub issue, researches the codebase in a sandbox, asks questions as necessary, and produces a specification.
2. spec-to-pr: an agent receives a specification, creates a plan, delegates implementation, review, and testing to isolated subagents, and posts a PR.
3. pr-reviewer: an agent receives a PR, reviews code quality across multiple dimensions in parallel, consolidates the findings as comments, and optionally conducts user testing on a preview environment deployment.
4. full-run: Run all three workflows in order.

## Why software-factory?
1. It's portable to other platforms. 
2. You can bring your own harness and agents.
3. It's secure by design.
4. You can configure, inspect, and customize every aspect of the platform.

## The architecture

| Resource | Render type | Job |
|---|---|---|
| `factory-gateway` | Web Service | Verifies webhooks, queues runs, serves the API and trace UI |
| `factory-dispatcher` | Background Worker | Starts Workflow tasks for queued runs |
| `factory-workflows` | Workflows | Runs the workflows and agents; owns all GitHub writes |
| `factory-maintenance` | Cron Job | Refreshes snapshots, reaps sandboxes, recovers stuck runs |
| `factory-db` | Postgres | All state |

Each run gets its own sandbox, restored from a snapshot of your repo. See [docs/architecture.md](docs/architecture.md).

## Get started
1. Fork the repo and point `factory.config.ts` at your repository.
2. Create a GitHub App: `npm run setup:app`.
3. Deploy the Blueprint in `render.yaml`.
4. Connect the webhook and labels: `npm run setup:github -- --gateway-url <url>`.
5. Check everything: `npm run doctor`.
6. Label an issue `factory:triage`.

See [docs/getting-started.md](docs/getting-started.md) for local development and details.

## Docs
- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Extending](AGENTS.md#recipes)
