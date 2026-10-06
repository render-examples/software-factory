# Getting started

## Prerequisites
- Node.js 22+
- Docker (local Postgres)
- [Render CLI](https://render.com/docs/cli), authenticated
- A Render workspace with Workflows and Sandboxes access
- An Anthropic or OpenAI API key
- A GitHub repo you can install a GitHub App on

## Deploy to Render
1. Fork the repo.
2. Set `repos[0]` in `factory.config.ts` to your target repository.
3. In `render.yaml`, set `repo` on `factory-workflows` to your fork.
4. Create a GitHub App with `npm run setup:app` and install it on your repo.
5. Create a Blueprint from `render.yaml` and fill in the `sync: false` variables.
6. Run `npm run setup:github -- --gateway-url https://<gateway>.onrender.com`. Use the gateway's `GITHUB_WEBHOOK_SECRET`.
7. Run `npm run doctor`.

The gateway migrates the database in its pre-deploy command.

## Run locally
```bash
npm ci
cp .env.example .env
npm run dev:postgres
npm run db:migrate
npm run dev:gateway
npm run dev:workflows
npm run dev:dispatcher
```

Local runs still create real sandboxes and call real models. Expose the gateway through an HTTPS tunnel to receive webhooks.

## Triggers
| Label | On | Starts |
|---|---|---|
| `factory:triage` | Issue | triage |
| `factory:spec-approved` | Issue | spec-to-pr |
| `factory:pr-review` | PR | pr-reviewer |
| `factory:full-run` | Issue | all three, in order |

Comment `/factory cancel` to stop a run.

## Commands
```bash
npm run doctor                # read-only setup check; safe in CI
npm run check                 # lint, typecheck, tests
npm run test:integration      # integration tests
npm run eval                  # validate eval cases
render blueprints validate    # after editing render.yaml
```
