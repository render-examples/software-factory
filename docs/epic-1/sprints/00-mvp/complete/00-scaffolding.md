# Sprint 00 — Scaffolding & Monorepo

**Status:** DRAFT
**Wave:** 0 — Foundations & Walking Skeleton
**Depends on:** —
**Unblocks:** all subsequent sprints

---

## Goal

Stand up the pnpm + Turborepo monorepo with the four runtime packages and the scaffolder package as empty-but-buildable shells, wired for strict TypeScript, `NodeNext`/ESM, declaration emit, independent publishing, and CI — so every later sprint has a place to land code and a green build to extend.

---

## Foundational decisions in play

- [Architecture at a Glance](../specs/00-foundations.md#architecture-at-a-glance) — the four-package + scaffolder layout and the dependency graph.
- Non-functional baselines from [Operations → Non-functional requirements](../specs/04-operations.md#non-functional-requirements): Node 20+, ESM only, strict TS + declaration emit, `@render-agents/sdk` < 100KB minified.

---

## Scope

**In:**
- Root workspace: `pnpm-workspace.yaml`, root `package.json`, Turborepo `turbo.json`, shared `tsconfig.base.json`.
- Five packages under `packages/*`, each building to ESM with `.d.ts`:
  - `@render-agents/sdk`
  - `@render-agents/engine`
  - `@render-agents/store`
  - `@render-agents/gateway`
  - `create-render-agents`
- The package dependency graph wired exactly as specified (sdk → engine + store; engine → store; gateway → sdk + store; scaffolder has no runtime deps). `store` is the bottom layer with zero internal deps.
- Linting/formatting, a `build`/`typecheck`/`test`/`lint` task graph in Turborepo, and a CI workflow running them.
- A placeholder entrypoint + `index.ts` per package so each compiles and emits declarations.
- Test runner wired (Vitest) with one trivial passing test per package.

**Out:**
- Any real types or runtime logic (those begin in Sprint 01+).
- Publishing automation / release tooling (Sprint 24).
- `render.yaml` / deployment topology (Sprint 23).

---

## Deliverables

**Repo layout:**

```
render-agents/                 # (this repo; specs already live in docs/)
├── package.json               # private root, workspaces + scripts
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .github/workflows/ci.yml
├── packages/
│   ├── sdk/
│   │   ├── package.json        # @render-agents/sdk
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   ├── engine/                 # @render-agents/engine
│   ├── store/                  # @render-agents/store
│   ├── gateway/                # @render-agents/gateway
│   └── create-render-agents/   # create-render-agents
```

**Per-package `package.json` contract:**
- `"type": "module"`, `"exports"` map with `import` + `types` conditions.
- `"engines": { "node": ">=20" }`.
- Build via `tsc` (or `tsup`) emitting ESM + declarations to `dist/`.
- `@render-agents/sdk` declares the subpath export `@render-agents/sdk/testing` (empty stub for now; implemented in Sprint 01).
- Workspace deps use `workspace:*` per the dependency graph.

**Root scripts (Turborepo):** `build`, `typecheck`, `test`, `lint`, `clean`.

---

## Porting source

No logic is ported in this sprint. Use as structural reference only:
- `agent-workflows-template/` root (`package.json`, `tsconfig.json`) for a working ESM/NodeNext baseline.
- `render-agent-harness/` workspace for the monorepo/Turborepo conventions — but **flatten to 4 packages** per [Porting principle 2](../specs/porting-map.md#4-porting-principles); do *not* reproduce the harness's 10+ package graph.

---

## Implementation notes

1. Start from the root workspace files, then generate the five package skeletons.
2. Set `tsconfig.base.json` with `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `declaration: true`, `declarationMap: true`, `target: "ES2022"`. Each package `tsconfig.json` extends it and sets `outDir`/`rootDir`.
3. Wire the dependency graph so a `turbo run build` topologically orders `store` first, then `engine`, then `sdk`/`gateway`. Confirm `@render-agents/sdk` re-exports nothing yet but resolves `engine`/`store`, and that `engine` resolves `store`. A lightweight CI check should assert `engine`/`store` never import from `sdk` (guards the acyclic graph — see Sprint 01).
4. Keep the scaffolder package free of runtime dependencies (it ships as `npm create`).
5. Add Vitest config at root with per-package projects; one `expect(true).toBe(true)`-style smoke test per package so `turbo run test` is green.

---

## Exit criteria / acceptance

- `pnpm install` succeeds at the root.
- `pnpm turbo run build typecheck lint test` is green across all five packages.
- Each package emits `dist/*.js` (ESM) + `dist/*.d.ts`.
- The dependency graph matches [Foundations](../specs/00-foundations.md#architecture-at-a-glance): importing `@render-agents/store` from `@render-agents/sdk` resolves at build time.
- CI runs the full task graph on push/PR and passes.

---

## Risks / open questions

- **Builder choice:** plain `tsc`
- **Package manager pinning:** pin the pnpm version via `packageManager` in root `package.json` to keep CI reproducible.
- **`create-render-agents` naming:** confirm the unscoped npm name is available/desired vs a scoped alias.
