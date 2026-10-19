# Repository guide for agents

This file applies to the whole repository. Read [docs/architecture.md](docs/architecture.md) for how the system works and [docs/redesign.md](docs/redesign.md) for why it's built this way.

## What this is

software-factory turns a labeled GitHub issue into a spec, a draft PR, and a COMMENT review. Three phases (Triage, Spec-to-PR, PR Reviewer) run as Render Workflows tasks. Agents run in Render Sandboxes restored from a per-repository snapshot. Postgres keeps an append-only `events` table; strict `run.claimed` rows coordinate phase ownership, while every other event is telemetry.

Two processes deploy:

- `app/src/server.ts`: the gateway web service. Verifies webhooks, routes each to one task, calls `startTask` with the delivery ID as the idempotency key, and serves the trace UI.
- `app/src/workflows.ts`: the Workflows service. Importing `app/workflows/index.ts` registers every task.

`app/sql/` holds the migrations, applied by `npm run db:migrate` as the gateway's pre-deploy command.

## Module map

```text
factory.config.ts   Repositories (base branch, install, verify), labels, permission, model tiers, limits, sandbox timeout
app/
  config/           Loads factory.config.ts; RepoContext and resolveRepo; TASKS names; modelFor; requireEnv
  contracts/        Zod schemas: task inputs (tasks.ts) and agent outputs (triage, spec, implementation, review)
  events/           strict run claims, best-effort emit(), and trace UI readers over the events table
  format/           Renders specs, questions, PR bodies, and reviews as GitHub markdown; sanitizes model text
  gateway/          Hono app: signature check, body cap, the routing table (routes.ts), admin auth, trace UI (ui/)
  github/           REST client, App JWT and installation tokens, Git Data API, hidden comment markers
  runner/           The agent runner: one Pi agent loop, tools, submit, key handling. Bundled into the snapshot
  sandbox/          Sandbox API client with pacing and retries; snapshot build, openSandbox, verification
  agents/           One prompt (.md) and defineAgent (.ts) per agent; runAgent runs one in a sandbox or in the task
  publish/          Collects the sandbox's changes and publishes them through the Git Data API
  phases/           withPhase lifecycle: permission, durable claim, takeover, ownership checkpoints, status, budget
  workflows/        The tasks: triage/, spec-to-pr/, pr-review/, cancel.ts, refresh-snapshot.ts
  sql/              Migrations
  src/              Process entry points
sandbox-runtime/    Shell scripts copied into the snapshot (run-agent, as-runner, verify, collect-changes, ...)
scripts/            setup-app, setup-github, doctor, migrate, eval
evals/cases/        Eval cases (JSON)
tests/              Vitest unit tests; fakes in tests/helpers/
```

Dependencies point one way, from entry points down to leaves:

```text
src → gateway, workflows
workflows → phases, publish, agents, sandbox, github, format, events, contracts, config
phases → agents, github, events, config
agents → sandbox, runner, events, contracts, config
publish → sandbox, github, config
sandbox → runner (to bundle it), github (read tokens), config
format → contracts, config
gateway → contracts, events, config
github → config
runner, events, contracts, config → nothing in app/
```

Two edges must never appear:

- **Nothing in `runner/` imports from the rest of `app/`.** esbuild bundles `runner/main.ts` into a self-contained file that runs in the sandbox with only Node.
- **`gateway/` never imports `github/`, `sandbox/`, `agents/`, or `workflows/`.** The gateway holds no GitHub credential and runs no model.

Import another module through its `index.ts` barrel where one exists. A barrel exports what other modules use; keep module-internal helpers out of it.

## Conventions

- Strict TypeScript, ESM, NodeNext. Relative imports end in `.js`. No path aliases.
- Biome formats with tabs and a line width of 150 (`biome.json`). `npm run lint` must pass with no warnings.
- Validate every external or cross-process input with Zod at the boundary: webhook payloads, task inputs, agent output, markers, sandbox output, environment.
- Task inputs and results stay small and JSON-serializable. Pass sandboxes between tasks by ID (`connectSandbox`).
- Quote every shell argument you build with `shq` (`app/sandbox/shell.ts`). Anything long or security-sensitive that runs in a sandbox belongs in a script in `sandbox-runtime/`, which CI checks with shellcheck.
- Model text that reaches GitHub goes through the helpers in `app/format/`.
- Phases take GitHub, sandboxes, `runAgent`, and run control as injectable dependencies. Tests never call live Render, GitHub, Postgres, or model APIs.
- Add or update tests with every behavior change.
- Write comments only for constraints the code can't show (platform limits, security reasons, ordering requirements), not to narrate the next line.

## Invariants

Don't weaken these without an explicit change to the security model ([docs/security.md](docs/security.md) says where each is enforced):

1. The gateway verifies the webhook signature before parsing the body.
2. Every run checks the triggering actor's live repository permission before doing anything.
3. Only workflow code writes to GitHub, and every write finds its marker before creating anything.
4. No write credential enters a sandbox. A read-only token is present only to clone or fetch.
5. Tools run only in sandboxes, never in a Workflows task.
6. Models never choose sandbox IDs, branches, repositories, or GitHub targets.
7. A PR opens only after GitHub's tree SHA equals the verified sandbox tree.
8. Automation ends at a draft PR and a COMMENT review. It never approves, requests changes, marks a PR ready, or merges.
9. Spec-to-PR implements the spec as it stood when the approval label was applied.
10. Every sandbox is created with a timeout and terminated in `finally`.
11. Postgres decides only cross-task run ownership; best-effort telemetry never drives phase behavior.

`tests/agents-catalog.test.ts` pins every agent's model, tools, and turn limit. Change it only on purpose.

## Common changes

- **An agent or a phase:** follow [docs/agents.md](docs/agents.md).
- **A configuration key:** add it to `FactoryConfig` in `factory.config.ts` with a doc comment, and to [docs/configuration.md](docs/configuration.md).
- **An environment variable:** add it to `render.yaml`, `.env.example`, `SERVICE_ENV` in `scripts/lib/requirements.ts` (so `doctor` checks it), and [docs/configuration.md](docs/configuration.md).
- **A webhook event, label, or App permission:** update `scripts/lib/requirements.ts`, which `setup:app`, `setup:github`, and `doctor` all read.
- **The runner or `sandbox-runtime/`:** these are baked into each snapshot, so they reach sandboxes only after a rebuild (the next push to each base branch, or a `refresh-snapshot` run).

## Verify

```bash
npm run check                    # Biome lint, tsc --noEmit, all Vitest tests
npm run eval -- --validate       # eval case files
shellcheck sandbox-runtime/*.sh sandbox-runtime/build/*.sh
render blueprints validate render.yaml   # when render.yaml changes
npm audit --omit=dev --audit-level=high
```

For one test file: `npx vitest run tests/gateway.test.ts`. `npm run doctor` checks a live deployment and is read-only.
