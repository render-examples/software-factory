# create-render-agent

Scaffolder for [render-agents](../../README.md). Generates a runnable, deployable
project in the spec layout — the **code-review** example (security + performance
reviewers → judge) — in one command.

```sh
npm create render-agent@latest my-agents
# or non-interactive (CI):
npm create render-agent@latest my-agents -- --yes --pm pnpm --provider anthropic
```

Emits: `agents/` (markdown), `tools/` (local + MCP), `skills/`, `workflows/code-review/`,
`webhooks/`, `hooks/`, `src/server.ts` + `src/worker.ts`, `package.json`, `tsconfig.json`,
`.env.example`, `compose.yaml`, and the canonical `render.yaml` (gateway + workflow service +
Postgres + retention cron).

Ships with **no `@render-agents/*` runtime dependencies** — it only prompts and writes files.
