# Render Factory v2 — Minimal Agent Framework

Agent() is pure config. agentTask() bridges to Render tasks. Composition is bare Render workflows. Threads live in Key Value.

## Quick start

```bash
cd v2
npm install
npm run start:gateway      # Hono server on :3000
npm run start:workflows    # Render Workflows task host
```

## Architecture

- **SDK (~100 lines):** `Agent()`, `agentTask()`, `md`, KV thread store
- **Gateway (~150 lines):** Hono routes for health, threads, Slack, GitHub webhooks
- **Workflows:** Bare Render `task()` composition — spec-to-pr, pr-review, pr-fix
- **Agent execution:** Claude Agent SDK `query()` inside each Render task
- **Persistence:** Render Key Value (Redis) for thread memory. No Postgres.

## File structure

```
v2/
├── sdk/                    Framework
│   ├── agent.ts            Agent() + agentTask() + md
│   ├── threads.ts          KV-backed thread store
│   └── index.ts            Barrel
├── app/
│   ├── agents/index.ts     Pure agent configs (prompts, tools)
│   ├── tasks/index.ts      agentTask() bridge (one per agent)
│   ├── workflows/          Bare Render task() composition
│   ├── gateway/            Hono server + channel handlers
│   ├── lib/                Domain helpers (GitHub API)
│   └── src/                Entrypoints
└── render.yaml             Blueprint (web + workflows + KV)
```

## Environment variables

```
ANTHROPIC_API_KEY       Claude API key
REDIS_URL               Render Key Value connection string
RENDER_WORKFLOW_SLUG    Workflows service slug
GITHUB_TOKEN            Fine-grained PAT for repo operations
GITHUB_WEBHOOK_SECRET   GitHub webhook signature secret
SLACK_SIGNING_SECRET    Slack request signing secret
SLACK_BOT_TOKEN         Slack bot OAuth token
```
