# Getting started

Scaffold → run → deploy a render-agents project.

## 1. Scaffold

```sh
npm create render-agent@latest my-agents
cd my-agents
npm install
```

You get the **code-review** example: `security` and `performance` reviewer agents
(markdown), a `judge` with a structured output schema, a `code-review` workflow that
fans out then decides, sample tools/skills/webhooks/hooks, and deploy config.

## 2. Run locally

```sh
cp .env.example .env     # set ANTHROPIC_API_KEY (or OPENAI_API_KEY) + RENDER_AGENTS_API_KEY
npm run dev              # gateway on :3000 (in-memory store unless DATABASE_URL is set)
```

Dispatch a run and watch it:

```sh
curl -X POST localhost:3000/workflows/code-review \
  -H "Authorization: Bearer $RENDER_AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":{"diff":"--- a/app.ts\n+++ b/app.ts\n+ const x = 1"}}'
```

Open `http://localhost:3000/ui` (enter your API key) to see the run list, span tree,
and per-agent cost. For the durable path, start Postgres with `docker compose up -d`
and set `DATABASE_URL`.

## 3. Author

- **Add an agent:** drop `agents/<name>.md` with frontmatter (`model`, `tools`, `skills`, `permissions`, `budget`, `plan`). Shared defaults live in `agents/_shared.md`.
- **Add a tool:** `tools/<name>/index.ts` default-exporting `defineTool(...)` (or `defineMcpSource(...)`). Agents reference it by directory name.
- **Add a workflow:** `workflows/<name>/index.ts` default-exporting `workflow(handler)`. Use `ctx.agents` (run-scoped) and `ctx.step()` for deterministic side effects.

## 4. Deploy to Render

Commit and create a Blueprint from `render.yaml` — it provisions the gateway (web),
the workflow service (worker), Postgres, and a daily retention cron. Set provider keys
as environment variables; the API key and encryption key are generated automatically.
See [deployment](deployment.md) for the full env contract.
