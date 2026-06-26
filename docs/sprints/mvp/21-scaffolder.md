# Sprint 21 — Scaffolder (`create-render-agent`) + Default Example

**Status:** DRAFT
**Wave:** 4 — DX, Operability & Ship
**Depends on:** Wave 3 (a complete, deployable project shape to generate)
**Unblocks:** —

---

## Goal

Build the `npm create render-agent` scaffolder: an interactive wizard that emits a working project in the spec's layout — agents, tools, a default workflow (code-review), `render.yaml`, `compose.yaml`, `package.json`, `tsconfig.json`, `.env` — so a new user goes from zero to a runnable, deployable agent system in one command.

---

## Foundational decisions in play

- [D1](../specs/00-foundations.md#d1--markdown-is-the-agent) — generated agents are markdown files; the scaffolder writes the convention layout.
- Configuration homes from [Operations → Configuration](../specs/04-operations.md#configuration): no project-level config file; metadata in `package.json`, agent config in frontmatter, deploy in `render.yaml`, secrets in `.env`.

---

## Scope

**In:**
- **Wizard flow** (`@clack/prompts`): project name, package manager, which example (start with the **code-review** pipeline as default), model provider + API key env, optional Postgres (compose) toggle.
- **Project emission** in the [Authoring → Project Layout](../specs/01-authoring.md#project-layout--discovery) shape:
  - `agents/` (e.g. `_shared.md`, `security.md`, `performance.md`, `judge.md`) with valid frontmatter.
  - `tools/` (a sample local tool + an MCP source example).
  - `skills/` (a sample `SKILL.md`).
  - `workflows/code-review/index.ts` (the default pipeline — ported from the template).
  - optional `webhooks/`, `hooks/` examples.
  - `render.yaml` (gateway web service + workflow service + Postgres + optional cron) — full version delivered in Sprint 23, referenced here.
  - `compose.yaml` (local Postgres), `package.json`, `tsconfig.json`, `.env.example`.
- **No runtime deps in the scaffolder package** (it ships as `npm create`).
- **Post-scaffold instructions:** install, run locally (in-memory or compose Postgres), deploy to Render.
- **Generated project validates + builds + runs** the default example against a mock or real model.

**Out:**
- A template registry/gallery ([deferred](../specs/porting-map.md#3-not-ported-intentionally-dropped)).
- The deployment topology details of `render.yaml` (Sprint 23 owns the canonical manifest; the scaffolder embeds it).

---

## Deliverables

`create-render-agent`:
- Wizard (`@clack/prompts`), `buildFileMap`, blueprint emission adapted to the spec layout.
- The default code-review example project (agents + tools + workflow + skill).
- Generated `package.json`/`tsconfig.json`/`.env.example`/`compose.yaml`/`render.yaml`.
- A smoke test that scaffolds to a temp dir and runs `build` + the example.

---

## Porting source

- **H — Scaffolder:** `render-agent-harness/create-render-agent/` — port the wizard flow (`@clack/prompts`), `buildFileMap`, blueprint emission; adapt to generate **our** project layout (markdown agents, not YAML; the 4-package SDK deps; spec directory conventions).
- **T — Default workflow + agents:** `agent-workflows-template/src/workflows/code-review/`, `src/agents/*.md`, `src/tools/*` — the code-review pipeline + sample agents/tools become the scaffolder's default example ([Porting Map](../specs/porting-map.md#1-from-agent-workflows-template-orchestration-kernel)).

---

## Implementation notes

1. **Generate the canonical layout** so discovery (Sprint 02) finds everything by convention with no manual registration.
2. **Default example = code-review**, matching the spec's running example (security/performance/judge fan-out + `ctx.step`), so a new user sees multi-agent + HITL + structured output immediately.
3. **`.env.example` documents the env contract** (Sprint 23): `DATABASE_URL`, provider API keys, `PORT`, and the `RENDER_AGENTS_`-prefixed settings (`RENDER_AGENTS_API_KEY`, retention/encryption/approval vars) — but ships as `.example` (no secrets).
4. **Local-first:** generated project runs in-memory with no Postgres (Wave 0 parity) and with `compose.yaml` Postgres for the durable path.
5. **Keep the scaffolder dependency-light** — no `@render-agents/*` runtime deps; it only writes files + prompts.

---

## Exit criteria / acceptance

- `npm create render-agent@latest my-app` runs the wizard and emits a project in the spec layout.
- The generated project: `pnpm install` + `build` succeed; `loadAgents()` discovers the agents/tools/skills/workflow without errors; the code-review workflow runs against a mock model (and a real model with keys).
- Generated `render.yaml`/`compose.yaml`/`.env.example` are present and coherent with Sprint 23.
- The scaffolder package has no runtime dependencies on `@render-agents/*`.
- A CI smoke test scaffolds to a temp dir and builds/runs the example.

---

## Risks / open questions

- **Version pinning of generated deps:** the generated `package.json` must reference published `@render-agents/*` versions (Sprint 24) — coordinate release ordering (scaffolder may pin `latest` or a known-good range).
- **Wizard scope creep:** keep prompts minimal for MVP (name, PM, provider, Postgres toggle); defer multi-example selection if it complicates.
- **`render.yaml` duplication:** the canonical manifest lives in Sprint 23; ensure the scaffolder embeds the same one (single source — generate from a shared template).
