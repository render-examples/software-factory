# render-factory

A self-hosted production-ready software factory. Built on Render Postgres, Workflows, Sandboxes, and Web services. 

Fork the repo, extend with your logic, and deploy full-stack coding agents with fine-grained control and full observability.

## Four workflows come out-of-the-box
1. triage: an agent receives a GitHub issue, researches the codebase in a sandbox, asks questions as necessary, and produces a specification.
2. spec-to-pr: an agent receives a specification, creates a plan, delegates implementation, review, and testing to isolated subagents, and posts a PR.
3. pr-reviewer: an agent receives a PR, reviews code quality across multiple dimensions in parallel, consolidates the findings as comments, and optionally conducts user testing on a preview environment deployment.
4. full-run: Run all three workflows.

## The architecture

| Resource | Render type | Entry point | Job |
|---|---|---|---|
| `factory-gateway` | Web Service | `app/src/server.ts` | Verifies webhooks, records deliveries, creates queued runs; serves the read API, trace UI, and artifact links |
| `factory-dispatcher` | Background Worker | `app/src/dispatcher.ts` | Polls queued runs and starts Workflow tasks |
| `factory-workflows` | Workflows | `app/src/workflows.ts` | Runs the three workflows and all agent tasks; owns GitHub writes and publishing |
| `factory-maintenance` | Cron Job | `app/src/maintenance.ts` | Re-queues stuck dispatches, fails lost executions, maintains the warm pool, expires artifacts |
| `factory-db` | Postgres | — | All state: runs, deliveries, events, specs, sandboxes, artifacts |

Sandboxes are managed through a warm pool. [TODO]

## Why render-factory?
1. It's portable to other platforms. 
2. You can bring your own harness and agents.
3. It's secure by design.
4. You can configure, inspect, and customize every aspect of the platform.

## Get started 