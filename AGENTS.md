# Repository guide for agents

This file applies to the whole repository. Read
[docs/architecture.md](docs/architecture.md) for how the system works and
[docs/design-notes.md](docs/design-notes.md) for why it is built this way.

## Task routing

- **Set up or deploy the factory:** follow
  [docs/runbooks/setup.md](docs/runbooks/setup.md) in order. Do not skip its
  human checkpoints or claim completion before both deployed `doctor` checks
  and the Triage smoke test pass.
- **Change repositories, labels, models, or limits:** use
  [docs/configuration.md](docs/configuration.md).
- **Diagnose a live deployment:** use
  [docs/operations.md](docs/operations.md).
- **Add an agent, claiming task, or trigger:** use
  [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

software-factory turns a labeled GitHub issue into a spec, a draft PR, and a COMMENT review. Three claiming tasks (Triage, Spec-to-PR, PR Reviewer) run on Render Workflows, each holding a claim on its issue or PR while it works. Agents run in Render Sandboxes restored from a per-repository snapshot. The status comment on the issue or PR names the run that holds the claim. Postgres is optional and keeps an append-only `events` table for telemetry only.

Two processes deploy:

- `app/entrypoints/gateway.ts`: the gateway web service. Verifies webhooks, routes each to one task, and calls `startTask` with the delivery ID as the idempotency key.
- `app/entrypoints/workflows.ts`: the Workflows service. Importing `app/workflows/index.ts` registers every task.

`app/sql/` holds the migrations, applied by `npm run db:migrate` as the gateway's pre-deploy command.

## Module map

```text
factory.config.ts   Repositories (base branch, install, verify), labels, permission, model tiers, publish and repair limits, sandbox timeout
app/
  entrypoints/      Gateway and Workflows process entry points
  config/           Loads factory.config.ts; RepoContext and resolveRepo; TASKS names; modelFor; requireEnv
  schemas/          Zod schemas: task inputs (tasks.ts) and agent outputs (triage, spec, implementation, review)
  gateway/          Hono app: signature check, body cap, the routing table (routes.ts), which validates task inputs; viewer/ is the read-only run viewer
  workflows/        The tasks: triage/, spec-to-pr/, pr-review/, cancel.ts, refresh-snapshot.ts; claiming-task.ts and run-verify.ts are shared
  claims/           withClaim lifecycle: permission, the status-comment claim, takeover and sandbox cleanup, checkpoints, expected failures
  agents/           One directory with index.ts and prompt.md per agent; shared defineAgent/runAgent runtime
  runner/           The agent runner: one Pi agent loop, tools, read-only shell policy, submit. Bundled into the snapshot
  sandbox/          Sandbox API client with pacing and retries; snapshot build, openSandbox, withSandbox, verification
  changeset/        Collects, validates, and publishes sandbox changes through the Git Data API
  github/           REST client, App JWT and installation tokens, Git Data API, hidden comment markers
  format/           Renders specs, questions, PR bodies, and reviews as GitHub markdown; sanitizes model text
  events/           Optional best-effort emit() over the events table
  sql/              Migrations
sandbox/            Shell scripts copied into the snapshot (run-agent, as-runner, verify, collect-changes, ...)
scripts/            setup-app, setup-github, doctor, migrate
tests/              Vitest unit tests; fakes in tests/helpers/
```

Dependencies point one way, from entry points down to leaves:

```text
entrypoints → gateway, workflows
workflows → claims, changeset, agents, sandbox, github, format, events, schemas, config
claims → agents, sandbox, github, events, config
agents → sandbox, runner, events, schemas, config
changeset → sandbox, github, config
sandbox → runner (to bundle it), github (read tokens), config
format → schemas, config
gateway → schemas, events, config
github → config
runner, events, schemas, config → nothing in app/
```

Two edges must never appear:

- **Nothing in `runner/` imports from the rest of `app/`.** esbuild bundles `runner/main.ts` into a self-contained file that runs in the sandbox with only Node.
- **`gateway/` never imports `github/`, `sandbox/`, `agents/`, or `workflows/`.** The gateway holds no GitHub credential and runs no model.

Import another module through its `index.ts` barrel where one exists. A barrel exports what other modules use; keep module-internal helpers out of it.

## Conventions

- Strict TypeScript, ESM, NodeNext. Relative imports end in `.js`. No path aliases.
- Biome is configured for tabs and a line width of 150 (`biome.json`); CI runs `biome lint`, which must pass with no warnings.
- Validate every external or cross-process input with Zod at the boundary: webhook payloads, task inputs, agent output, markers, sandbox output, environment.
- Task inputs and results stay small and JSON-serializable. Each task opens
  one sandbox with `withSandbox`, which closes it within the same task.
- Throw `ExpectedFailure` for an expected failure whose message is safe to show on GitHub. `withClaim` also treats an agent
  that stops on its own (turn limit, timeout, no or invalid submission) as expected; every other error fails the task.
  Outcome names are snake_case.
- Quote every shell argument you build with `shq` (`app/sandbox/shell.ts`). Anything long or security-sensitive that runs in a sandbox belongs in a script in `sandbox/`, which CI checks with shellcheck.
- Model text that reaches GitHub goes through the helpers in `app/format/`.
- Task implementations take GitHub, sandboxes, `runAgent`, and run control as injectable dependencies. Tests never call live Render, GitHub, Postgres, or model APIs.
- Keep the suite focused; it currently has 100+ tests. Test durable behavior at process and trust
  boundaries: authenticated inputs, user-visible outcomes, authority,
  cleanup, and security invariants. Prefer one end-to-end happy path and the
  meaningful failure modes over helper permutations. Do not assert private
  helper calls, incidental command sequences, task registration, barrel
  exports, or exact intermediate formatting. Assert ordering only when the
  ordering is itself a security contract, such as scrubbing a credential
  before untrusted code runs.
- Add or update a test when externally observable behavior or a security
  invariant changes; refactors with unchanged behavior should not require
  test changes.
- Write comments only for constraints the code can't show (platform limits, security reasons, ordering requirements), not to narrate the next line.

## Invariants

Don't weaken these without an explicit change to the security model
([docs/architecture.md](docs/architecture.md#trust-boundaries) says where
each is enforced):

1. The gateway verifies the webhook signature before parsing the body.
2. Every run checks the triggering actor's live repository permission before doing anything.
3. Only workflow code writes to GitHub, and every write finds its marker before creating anything.
4. No write credential enters a sandbox. A read-only token is present only to clone or fetch.
5. Tools run only in sandboxes, never in a Workflows task.
6. Models never choose sandbox IDs, branches, repositories, or GitHub targets.
7. A PR opens only after GitHub's tree SHA equals the verified sandbox tree.
8. Automation ends at a draft PR and a COMMENT review. It never approves, requests changes, marks a PR ready, or merges.
9. Spec-to-PR implements the spec as it stood when the approval label was applied.
10. Every sandbox is created with a timeout and closed by `withSandbox` (in `finally`). A claiming task records its sandbox in the status comment, so the run or `/factory cancel` that stops it can terminate the sandbox: Render kills a cancelled task without running `finally`.
11. Postgres is telemetry only; no task behavior depends on it.

`tests/agents-catalog.test.ts` protects unique agent identities and tool authority. Change it only on purpose.

## Common changes

- **An agent or a claiming task:** follow
  [CONTRIBUTING.md](CONTRIBUTING.md#customize-an-agent) or
  [CONTRIBUTING.md](CONTRIBUTING.md#add-a-claiming-task).
- **A configuration key:** add it to `FactoryConfig` in `factory.config.ts`
  with a doc comment, and to
  [docs/configuration.md](docs/configuration.md#behavior-and-limits).
- **An environment variable:** add it to `render.yaml`, `.env.example`,
  `SERVICE_ENV` in `scripts/lib/requirements.ts` (so `doctor` checks it), and
  [docs/configuration.md](docs/configuration.md#environment-variables).
- **A webhook event, label, or App permission:** update `scripts/lib/requirements.ts`, which `setup:app`, `setup:github`, and `doctor` all read.
- **The runner or `sandbox/`:** these are baked into each snapshot, so they reach sandboxes only after a rebuild (the next push to each base branch, or a `refresh-snapshot` run).

## Verify

```bash
npm run check                    # Biome lint, tsc --noEmit, all Vitest tests
shellcheck sandbox/*.sh sandbox/build/*.sh
render blueprints validate render.yaml   # when render.yaml changes
npm audit --omit=dev --audit-level=high
```

For one test file: `npx vitest run tests/gateway.test.ts`. `npm run doctor` is read-only; see
[Operations](docs/operations.md#check-a-deployment) for local and deployed usage.
