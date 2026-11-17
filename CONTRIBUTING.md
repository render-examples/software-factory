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

Fill `.env` without committing it. `DATABASE_URL` can point at a local
Postgres; see [Database](docs/configuration.md#database). Start each process
in its own terminal:

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
calls. Vitest replaces `factory.config.ts` with the explicit configuration in
`tests/fixtures/config.ts`, so customizing your deployment does not change test
subjects, permissions, or expected verification commands. Keep configuration
compatibility cases in that fixture and exercise them through routing and tasks.

Database tests run on PGlite, in-process Postgres, through
`tests/helpers/db.ts`. PGlite runs one transaction at a time, so tests that
need concurrent transactions or connections run only when `TEST_DATABASE_URL`
points at a Postgres server where the user can create databases. CI sets it.
Name those files `*-postgres.test.ts`: Vitest runs them one at a time, since a
transaction anywhere on the server holds back readers of a subject's events.

```bash
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npx vitest run --project postgres
```

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

Persistent factory state goes in the event log in `app/db/`. GitHub owns
collaboration artifacts, Render Workflows owns task execution, and telemetry
goes to logs. To add state:

1. Declare each event type with `defineEvent` in `app/events/catalog.ts`.
   Bound every string and array; bump the version when a payload changes.
2. Add tables in a new `app/db/migrations/NNN_name.sql`. Keep it additive:
   both services migrate at startup, and the other may still run the previous
   code. Mark operational columns, which hold metadata rather than state
   derived from events.
3. Add a projection to `PROJECTIONS` in `app/db/projections.ts`. Derive its
   rows only from events, so `npm run db:rebuild` can recreate them.
4. Append inside `withTx` and keep the transaction short: it holds back
   readers of a subject's events until it ends.

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
