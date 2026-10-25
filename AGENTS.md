# Repository guide for agents

This file applies to the whole repository.

## Use the right guide

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

1. `app/runner/` imports nothing from the rest of `app/`. It is bundled into
   a self-contained Sandbox program.
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
  `claim.recordSandbox()` immediately after opening one.
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
- Environment variable: update `render.yaml`, `.env.example`, `SERVICE_ENV`
  in `scripts/lib/requirements.ts`, and `docs/configuration.md`.
- App permission, event, or label: update
  `scripts/lib/requirements.ts`, setup behavior, and doctor tests.
- `app/runner/` or `sandbox/`: refresh every repository snapshot after
  deployment.

## Verify

```bash
npm run check
```

See [Contributing](CONTRIBUTING.md#verify-changes) for targeted and
change-specific checks.
