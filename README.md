# render-factory

An open-source, self-hosted platform and framework for building autonomous
coding agent workflows that run on [Render](https://render.com). Define agents
in markdown, wire them as durable multi-step workflows, and deploy them to
Render. They receive work from Slack and GitHub, execute code in sandboxes, and
deliver results back to those surfaces automatically.

## Prerequisites

- Node ≥ 22.13
- [pnpm](https://pnpm.io) 11
- [Docker](https://docs.docker.com/get-docker/) (for Postgres and/or full-stack compose)
- [Render CLI](https://render.com/docs/cli) (bare-metal dev only — runs the workflows host)

## Install

```sh
pnpm install
```

## Run locally

### Docker Compose (recommended)

```sh
cp .env.example .env   # fill in API keys
docker compose up --build
```

The operator UI is at <http://localhost:3010/ui>.

### Bare-metal dev

```sh
pnpm build

# start Postgres
docker compose up -d postgres

# terminal 1 — gateway
pnpm --filter @render-factory/app dev

# terminal 2 — workflows host (requires Render CLI)
pnpm --filter @render-factory/app dev:workflows
```

## Other scripts

```sh
pnpm test        # run tests
pnpm typecheck   # tsc --noEmit across all packages
pnpm lint        # eslint
pnpm build       # production build
```
