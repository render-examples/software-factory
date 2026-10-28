# Repository guide for agents

This file applies to the whole repository.

## Use the right guide

- Agent libraries, models, or harness adapters:
  [docs/configuration.md#agent-harnesses-and-models](docs/configuration.md#agent-harnesses-and-models)
  and [docs/runbooks/extend.md](docs/runbooks/extend.md#add-an-agent-harness)
- First deployment:
  [docs/runbooks/setup.md](docs/runbooks/setup.md)
- Repositories, labels, models, permissions, limits, or snapshots:
  [docs/configuration.md](docs/configuration.md)
- Agents, Workflows tasks, or GitHub triggers:
  [docs/runbooks/extend.md](docs/runbooks/extend.md)
- State, coordination, publishing, or security:
  [docs/architecture.md](docs/architecture.md)
- Local development:
  [CONTRIBUTING.md](CONTRIBUTING.md)

Follow runbooks in order. Stop at every human checkpoint. Do not claim setup
is complete until both `doctor` checks and the Triage smoke test pass.

## System boundaries

software-factory deploys two processes:

- `app/entrypoints/gateway.ts` verifies webhooks and starts tasks.
- `app/entrypoints/workflows.ts` registers and runs tasks.

Agents run inside Render Sandboxes. Only code in the Workflows service writes
to GitHub. GitHub and Render Workflows hold application state; there is no
database.

Two dependency rules are mandatory:

1. The Sandbox runner bundle (`app/runner/`, `app/harness/`, the agent
   definitions in `app/agents/registry.ts`, and `app/schemas/`) imports no
   host-only code: GitHub, Sandboxes, Workflows, claims, events, or config.
   `tests/agents-catalog.test.ts` enforces it.
2. `app/gateway/` does not import GitHub authentication, Sandboxes, agents, or
   workflows. The gateway holds no GitHub credential and runs no model.

Read the canonical
[security invariants](docs/architecture.md#security-invariants) before
changing credentials, claims, Sandboxes, publishing, or GitHub writes.

## Code conventions

- Use strict TypeScript, ESM, and NodeNext. Relative imports end in `.js`.
  There are no path aliases.
- Biome uses tabs and a line width of 150.
- Import public module APIs through `index.ts` barrels. Do not export
  module-internal helpers.
- Validate every external or cross-process input with Zod at its boundary.
- Build agent output objects with `z.strictObject`. Bound strings and arrays.
- Keep task inputs and results small and JSON-serializable.
- Open Sandboxes through `withSandbox`. In GitHub tasks, call
  `claim.trackSandbox()` immediately after opening one.
- Use `ExpectedFailure` only for expected messages safe to publish on GitHub.
  Keep outcome names in snake_case.
- Quote generated shell arguments with `shq`. Put long or
  security-sensitive Sandbox commands in `sandbox/` scripts.
- Pass model text through `app/format/` before writing it to GitHub.
- Inject GitHub, Sandbox, agent, and run-control dependencies into task
  implementations. Tests use fakes, never live services.
- Comment security reasons, platform constraints, and required ordering. Do
  not narrate obvious code.

## Tests

Test behavior at process and trust boundaries:

- authenticated input;
- user-visible output;
- authority and target selection;
- cleanup and cancellation; and
- security invariants.

Do not test private helper calls, incidental command sequences, task
registration, barrel exports, or formatting that users cannot observe. Assert
ordering only when it is part of a security contract.

Update tests when observable behavior or an invariant changes. A refactor
with unchanged behavior should not require new assertions.

`tests/agents-catalog.test.ts` protects unique agent IDs, tool authority, and
strict output schemas.

## Cross-cutting changes

- Configuration key: update `FactoryConfig` in `factory.config.ts` and
  `docs/configuration.md`.
- Environment variable: update `.env.example`, `SERVICE_ENV` and, for a
  secret, `ENV_GROUPS` in `scripts/lib/requirements.ts`, and
  `docs/configuration.md`. Secrets belong in an env group, not a
  `sync: false` entry in `render.yaml`. Never link a group with GitHub App
  credentials or a model key to the gateway.
- App permission, event, or label: update
  `scripts/lib/requirements.ts`, setup behavior, and doctor tests.
- Agent harness: declare the env var of its key as the adapter's
  `credential`; setup and `doctor` derive the key list. It must give the
  model only the factory's tools; add it to `HARNESSES` in
  `tests/helpers/runner.ts` if it can run the conformance suite.
- `sandbox/`: refresh every repository snapshot after deployment. Changes to
  `app/runner/`, `app/harness/`, or agents reach Sandboxes with the Workflows
  deploy, because each Sandbox replaces a stale runner bundle when it opens.

## Verify

```bash
npm run check
```

See [Contributing](CONTRIBUTING.md#verify-changes) for targeted and
change-specific checks.
