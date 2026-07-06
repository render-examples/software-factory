# AGENTS.md

## Cursor Cloud specific instructions

### Repo layout / branch caveat
- The `main` branch is **documentation-only** (`docs/specs/*`, `docs/sprints/*`). There is no `package.json`, build, or runnable service on `main`.
- The buildable code (the `render-agents` TypeScript SDK monorepo) currently lives on the unmerged branch `jacob/mvp-sprint-00`. If `package.json` / `packages/` are missing in your checkout, you are on a docs-only branch — there is nothing to install, build, or run.

### Toolchain
- Node.js 20+ (the VM ships Node 22, which is fine; CI matrix tests Node 20 and 22).
- pnpm is pinned to `9.15.4` via the `packageManager` field. Use **corepack** (`corepack enable`) so the correct pnpm is used automatically; do not rely on the globally-installed pnpm. The update script runs `corepack enable` + `pnpm install` (guarded so it's a no-op on the docs-only branch).

### Services (when code is present)
- This is a pnpm-workspace + Turborepo monorepo of 5 packages (`store` ← `engine` ← `sdk` ← `gateway`, plus the `create-render-agent` scaffolder). It is an **SDK/library, not a deployed app yet**.
- There are **no long-running services to start** at this stage: the store is in-memory only and the gateway has no HTTP server yet. Build/test do **not** require Postgres, LLM API keys, or any external service.

### Commands (run from repo root; defined in root `package.json`)
- `pnpm install` — install workspace deps.
- `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` — Turborepo runs the per-package script across all packages. Turbo caches results; pass `--force` to bypass cache.
- CI (`.github/workflows/ci.yml`) additionally enforces an acyclic dependency-graph guard: `store` must not import from `engine`/`sdk`, and `engine` must not import from `sdk`. Keep imports flowing in that direction.

### "Hello world" sanity check
- Core functionality today is loading agents from markdown. After `pnpm build`, you can exercise it by calling `loadAgents("<project-dir>")` from `@render-agents/sdk` against a project that has an `agents/` directory (e.g. the fixture at `packages/sdk/src/__fixtures__/valid-project`). To run a standalone script that imports the package, place it inside `packages/sdk` and import the built `./dist/index.js` (the workspace symlinks for `@render-agents/*` live under `packages/sdk/node_modules`, not the repo-root `node_modules`).
