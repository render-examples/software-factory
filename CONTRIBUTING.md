# Contributing

Read [Architecture](docs/architecture.md) before changing claims, credentials,
Sandboxes, publishing, or GitHub authority. Use the
[extension runbook](docs/runbooks/extend.md) for agents, Workflows tasks, and
GitHub triggers.

## Local development

Local development requires Render CLI 2.29 or later. It still uses real
Render Sandboxes, a real GitHub App, and a real model. Use a test repository
and, when possible, a separate App.

Install dependencies and create a local environment file:

```bash
npm ci
cp .env.example .env
```

Fill `.env` without committing it. Start each process in its own terminal:

```bash
# Terminal 1
npm run dev:workflows

# Terminal 2
RENDER_USE_LOCAL_DEV=true npm run dev:gateway
```

Expose port 3000 over public HTTPS:

```bash
cloudflared tunnel --url http://localhost:3000
npm run setup:github -- --gateway-url https://<tunnel-host>
```

A GitHub App has one webhook URL. Pointing a production App at local
development interrupts production deliveries.

### Start a task directly

List and invoke local tasks with the Render CLI:

```bash
render workflows tasks list --local

render workflows tasks runs start --local \
  --task <task> \
  --input='[{...}]'
```

Task input schemas are in
[`app/schemas/tasks.ts`](app/schemas/tasks.ts).

## Verify changes

Run the standard check before handing off:

```bash
npm run check
```

It runs Biome, TypeScript, and Vitest. Tests fake GitHub, Render, and model
calls.

Run additional checks when relevant:

```bash
shellcheck sandbox/*.sh sandbox/build/*.sh
render blueprints validate render.yaml
npm audit --omit=dev --audit-level=high
```

`render blueprints validate` resolves the Blueprint's
[env groups](docs/configuration.md#environment-groups) in the CLI's current
workspace. Outside a workspace where `npm run setup:render` has run, expect
only `depends on non-existent group` errors.

Run one test file with:

```bash
npx vitest run tests/gateway.test.ts
```

## Extend the factory

Follow [docs/runbooks/extend.md](docs/runbooks/extend.md) to:

- add a typed agent and prompt;
- add a GitHub or maintenance task;
- route a GitHub event, label, or command;
- update GitHub App requirements;
- test authority and user-visible behavior; and
- identify required deploys and snapshot refreshes.

The runbook is the canonical procedure. Keep implementation details in code
and architectural reasons in [Architecture](docs/architecture.md).

## Add persistent state

The default template has no database. GitHub owns collaboration artifacts,
Render Workflows owns task execution, and telemetry goes to logs.

Add a database only for new data with its own lifecycle, such as a searchable
spec library, budgets, or retained run history:

1. Add a Render Postgres database to the `production` environment's
   `databases` list in `render.yaml`.
2. Wire `DATABASE_URL` into only the services that need it.
3. Run migrations from a service `preDeployCommand`.
4. Use the internal connection string on Render. Local tools use the external
   connection with TLS.

Do not move claim ownership into the database. The status comment must remain
the single source of truth for the run that owns an issue or pull request.

## Documentation ownership

- `README.md`: product entry point.
- `docs/quickstart.md`: human setup handoff.
- `docs/runbooks/setup.md`: first-deployment agent protocol.
- `docs/configuration.md`: settings, run control, deployment checks, and
  snapshot procedures.
- `docs/architecture.md`: state, boundaries, invariants, and accepted risks.
- `docs/runbooks/extend.md`: extension agent protocol.
- `CONTRIBUTING.md`: local development and verification.

Link to the canonical document instead of copying its content.
