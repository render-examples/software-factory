# AGENTS.md

## Cursor Cloud specific instructions

### Repo layout / branch caveat (read this first)
- The `main` branch is **documentation-only** (`docs/specs/*`, `docs/sprints/*`). There is no `package.json`, build step, or runnable service on `main`.
- The buildable code (the `render-agents` TypeScript SDK monorepo) currently lives on the unmerged branch `jacob/mvp-sprint-00`. If `package.json` / `packages/` are missing from your checkout, you are on a docs-only branch — there is nothing to install, build, or run, and the update script is a no-op by design.

### Toolchain
- Node.js 20+ (the VM ships Node 22, which is fine; CI matrix tests Node 20 and 22).
- pnpm is pinned via the `packageManager` field (`pnpm@9.15.4`). Use **corepack** (`corepack enable`) so the pinned pnpm is used automatically; do not rely on the globally-installed pnpm (it is a newer major). The update script runs `corepack enable` and then `pnpm install` only when a root `package.json` is present.

### Services
- This is a pnpm-workspace + Turborepo monorepo of 5 packages (`store` ← `engine` ← `sdk` ← `gateway`, plus the `create-render-agent` scaffolder). At this MVP stage it is an **SDK/library, not a deployed app**.
- There are **no long-running services to start**: the store is in-memory only and the gateway has no HTTP listener yet. Build/test/lint do **not** require Postgres, LLM API keys, or any external service.

### Commands (run from repo root; defined in root `package.json`, all via Turborepo)
- `pnpm install` — install workspace deps.
- `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` — run the per-package script across all packages. Turbo caches results; pass `--force` to bypass the cache.
- CI (`.github/workflows/ci.yml`) additionally enforces an acyclic dependency-graph guard: `store` must not import from `engine`/`sdk`, and `engine` must not import from `sdk`. Keep imports flowing in that direction.

### "Hello world" sanity check
- Core functionality today is loading agents from markdown (an agent is a `.md` file: YAML frontmatter = config, body = system prompt).
- After `pnpm build`, exercise it by calling `loadAgents("<project-dir>")` from `@render-agents/sdk` against a project that has an `agents/` directory (e.g. the fixture at `packages/sdk/src/__fixtures__/valid-project`). A script that imports the package should live inside `packages/sdk` and import the built `./dist/index.js` — the `@render-agents/*` workspace symlinks live under `packages/sdk/node_modules`, not the repo-root `node_modules`.
