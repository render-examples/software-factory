# Contributing

Read [Architecture](docs/architecture.md) before changing run coordination,
Sandbox boundaries, credentials, or publishing.

## Local development

Local development requires Render CLI 2.29 or later. It still uses
real Render Sandboxes, a real GitHub App, and a real model. Use a separate
test repository and preferably a separate App.

```bash
npm ci
cp .env.example .env
```

Fill `.env`, then start each process in its own terminal:

```bash
# Terminal 1
npm run dev:workflows

# Terminal 2
RENDER_USE_LOCAL_DEV=true npm run dev:gateway
```

Expose port 3000 through a public HTTPS tunnel and point the App at it:

```bash
cloudflared tunnel --url http://localhost:3000
npm run setup:github -- --gateway-url https://<tunnel-host>
```

A GitHub App has one webhook URL. Repointing a production App interrupts its
production deliveries.

You can also invoke a local task directly:

```bash
render workflows tasks list --local
render workflows tasks runs start --local \
  --task <task> \
  --input='[{...}]'
```

Task input schemas are in
[`app/schemas/tasks.ts`](app/schemas/tasks.ts).

## Verify changes

```bash
npm run check
```

This runs Biome, TypeScript, and Vitest. Tests fake GitHub, Render, and model
calls.

When relevant, also run:

```bash
shellcheck sandbox/*.sh sandbox/build/*.sh
render blueprints validate render.yaml
npm audit --omit=dev --audit-level=high
```

For one test:

```bash
npx vitest run tests/gateway.test.ts
```

## Customize an agent

An agent consists of a Markdown prompt and typed definition:

```text
app/agents/<id>/
  index.ts
  prompt.md
```

```typescript
export const implementer = defineAgent({
  id: "implementer",
  prompt: "implementer/prompt.md",
  model: "large",
  tools: ["read", "ls", "bash", "edit", "write"],
  output: Implementation,
  maxTurns: 150,
});
```

The definition fixes:

- a unique ID;
- a prompt relative to `app/agents/`;
- a configured model tier;
- tools selected from `read`, `ls`, `bash`, `edit`, and `write`;
- a bounded Zod output schema;
- a maximum number of model calls; and
- an optional thinking level.

Put repository- and run-specific context in the typed message passed to
`runAgent`, not in the system prompt. Tell the model to call `submit` exactly
once; the tool supplies the output schema.

Only an implementer should normally receive `edit` or `write`. The read-only
shell policy is a behavioral guard, not a security boundary.

To add an agent:

1. add its prompt and definition under `app/agents/<id>/`;
2. export it from `app/agents/index.ts`;
3. add or reuse a bounded schema in `app/schemas/`;
4. call it from a task with that task's Sandbox and `claim.agentOptions(sandbox)`;
5. add it to `tests/agents-catalog.test.ts`; and
6. run `npm run check`.

Prompt changes require a Workflows deploy. Changes under `app/runner/` or
`sandbox/` also require repository snapshot refreshes.

## Add a claiming task

A claiming task acts on one issue or PR while it holds a claim on it.
Triage, Spec-to-PR, and PR Reviewer are claiming tasks. The claim is the
status comment: the run it names holds it. Declare a claiming task with
`claimingTask()` (`app/workflows/claiming-task.ts`). It registers the
Workflows task, validates the input, resolves the repository, and runs your
work inside `withClaim` (`app/claims/claim.ts`). `withClaim` checks the
actor's permission, stops the previous run and takes over the status comment,
keeps the comment current, and reports how the run ended.

1. Add the task name to `TASKS` in `app/config/index.ts`.
2. Add a bounded input schema in `app/schemas/tasks.ts`.
3. Declare the task under `app/workflows/<name>/` with
   `claimingTask({ name, title, input, subject, timeoutSeconds }, work)`.
   `title` is how the status comment names the task.
4. Open Sandboxes through `withSandbox`, and call
   `claim.recordSandbox(sandbox)` first thing, so a run that replaces yours
   can terminate its Sandbox.
5. Call `claim.progress()` before major steps and `claim.checkpoint()` before
   durable writes.
6. Throw `ExpectedFailure` only for expected messages safe to show on GitHub.
7. Import the task module from `app/workflows/index.ts`.
8. Route an authenticated webhook to it in `app/gateway/routes.ts`.
9. Update setup requirements and add boundary-focused tests.

Claiming tasks never retry automatically, because a retry can repeat model
spend and durable work. A person reapplies a label to start a fresh run.

## Add or change a GitHub trigger

The gateway routing table is a pure mapping from authenticated event payload
to one validated task input.

1. Update `route()` in `app/gateway/routes.ts`.
2. Update `REQUIRED_EVENTS`, `REQUIRED_PERMISSIONS`, or `LABELS` in
   `scripts/lib/requirements.ts`.
3. Update the existing App when permissions or subscriptions changed.
4. Rerun `npm run setup:github`.
5. Add route and setup/doctor tests.

Use the GitHub delivery ID as the task idempotency key. Derive repositories,
installations, actors, subjects, and commits from the authenticated payload.
Never accept write destinations from model output.

Every GitHub write should update or reuse an App-authored artifact marker.
Workflows idempotency alone has a finite scope and is not sufficient.

## Add persistent state

The factory keeps no database: GitHub and Render Workflows hold the state it
needs, and telemetry goes to logs. When a feature needs its own data, such as
a spec library, budgets, or run history you query:

1. Add a Render Postgres database to `render.yaml` and wire `DATABASE_URL`
   into the services that need it with `fromDatabase`.
2. Run migrations from the gateway's `preDeployCommand`, so each deploy
   migrates before new code starts.
3. Use the internal connection string on Render. The external one is for
   local tools and requires TLS.
4. Keep run coordination in the status comment. A database that also decides
   who owns an issue becomes a second source of truth to reconcile.

## Code structure

```text
app/
  entrypoints/  Gateway and Workflows process entry points
  gateway/      Webhook authentication and routing
  workflows/    Triage, Spec-to-PR, PR Reviewer, cancel, snapshots
  claims/       withClaim: permission, status-comment claim, takeover, failure reporting
  agents/       Agent definitions and host-side execution
  runner/       Self-contained agent runtime bundled into snapshots
  sandbox/      Sandbox and snapshot lifecycle
  changeset/    Candidate-tree validation and publishing
  github/       App authentication, REST, Git Data, and markers
  events/       Run and agent telemetry as JSON log lines
  schemas/      Cross-process Zod contracts
sandbox/        Runtime scripts copied into snapshots
scripts/        Setup and doctor
tests/          Unit and boundary tests with fakes
```

Two dependency boundaries are mandatory:

- `app/runner/` must not import from the rest of `app/`; it is bundled into a
  self-contained Sandbox program.
- `app/gateway/` must not import GitHub authentication, Sandboxes, agents, or
  workflows; the gateway holds no GitHub credential and runs no model.

## Documentation rules

Keep each fact in its canonical document:

- agent deployment protocol: `docs/runbooks/setup.md`;
- short human setup guide: `docs/quickstart.md`;
- supported settings: `docs/configuration.md`;
- runtime procedures and failures: `docs/operations.md`;
- state, boundaries, and invariants: `docs/architecture.md`; and
- contributor workflows: this file.

Link to the canonical explanation instead of copying it.
