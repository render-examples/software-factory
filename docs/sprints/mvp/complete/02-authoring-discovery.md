# Sprint 02 — Authoring & Discovery (markdown → `AgentSet`)

**Status:** DRAFT
**Wave:** 0 — Foundations & Walking Skeleton
**Depends on:** 01 (type contracts)
**Unblocks:** 04 (runtime/loop), 07 (tools), 08 (skills)

---

## Goal

Implement project discovery and the markdown authoring model: scan the conventional directories, parse + validate agent frontmatter, merge `_shared.md`, resolve tool/skill references, and return an inert (not-yet-runtime-bound) `AgentSet`. This is the front door of the SDK and the home of the canonical fail-fast validation list.

---

## Foundational decisions in play

- [D1](../specs/00-foundations.md#d1--markdown-is-the-agent) — an agent *is* a single `.md` file; identity and config live in the file, not a registry.
- [D6](../specs/00-foundations.md#d6--tools-are-declared-per-agent-tools-is-the-sole-allowlist-mcp-at-the-boundary) — `tools[]` is the sole allowlist; references resolve to source ids or `sourceId__toolName`.

---

## Scope

**In:**
- **Project layout discovery** per [Authoring → Project Layout & Discovery](../specs/01-authoring.md#project-layout--discovery): the directory→key→glob→collision table for `agents/`, `tools/`, `skills/`, `workflows/`, `webhooks/`, `hooks/`, `runners/`. All directories optional; missing dirs skipped unless referenced.
- **Frontmatter parsing + validation** per [Authoring → Agent Markdown Schema](../specs/01-authoring.md#agent-markdown-schema): every field, its type, default, and load-time validation. Unknown fields are hard errors.
- **Model tier resolution** (`small`/`medium`/`large` → concrete `ModelSpec`) and the split validation: routing validity (hard error), tier validity (hard error), pricing availability (warning only — see Sprint 06/08 for cost). The tier table + `resolveModelSpec` are a **data-only `@render-agents/engine` module** — the single source of truth for tiers — which the loader imports for load-time validation; **Sprint 06 layers provider inference + pricing onto this same table** rather than defining a second one.
- **`_shared.md` merge semantics:** body prepend; frontmatter deep-merge per leaf (agent wins; arrays union+dedupe; scalars agent → shared → built-in default).
- **Tool reference resolution:** bare source id mounts all tools; namespaced `sourceId__toolName` exposes only that tool; `requireApproval` matches expanded resolved names.
- **Skill resolution:** skill ids → fully-resolved `SkillMetadata` stored on the definition.
- **The `loadAgents(dir?, runtime?)` discovery+validation pipeline steps 3–8** from [Execution → Runtime & composition](../specs/02-execution.md#runtime--composition) (binding to a runtime is step 9 = Sprint 04; here it returns definitions ready to bind).
- **The full [validation canonical fail-fast list](../specs/01-authoring.md#validation-canonical-fail-fast-list)** — implemented and individually tested.
- The `ToolRegistry`/`SkillRegistry` discovery (loading source modules from `tools/` and `SKILL.md` from `skills/`). Tool *execution* is Sprint 07; here we only need the registry to validate references and compute resolved model-facing names + collisions.

**Out:**
- Binding agents to a runtime / `Agent.run()`/`.task()` (Sprint 04).
- Tool invocation, MCP connection, environment mounting (Sprint 07).
- Workflow/webhook/hook/runner *loading and execution* (their discovery keys are validated here for collisions, but their module semantics land in Sprints 12/15/20 and the runner registry in 04).

---

## Deliverables

`@render-agents/sdk` (or an internal `loader` module re-exported by sdk):
- `loadAgents` discovery + validation pipeline (runtime binding stubbed/injected).
- Frontmatter parser (YAML) → typed `AgentFrontmatter` → validated `AgentDefinition`.
- `_shared.md` merge function (pure, unit-testable in isolation).
- Tier table + `resolveModelSpec(model?, provider?)` as a data-only `@render-agents/engine` module (single source of tiers; Sprint 06 extends it with provider inference + pricing).
- Tool-reference resolver (source id / namespaced name → expanded model-facing names; collision detection).
- Skill resolver producing `SkillMetadata[]`.
- `ToolRegistry` + `SkillRegistry` discovery loaders.
- A precise error type/catalog so each fail-fast rule yields a clear, testable message.

---

## Porting source

- **T — Markdown agent loading + validation:** `agent-workflows-template/src/engine/parse-agents.ts`. Extend its frontmatter schema (add `plan`, `runner`, `permissions.requireApproval`, `output`, `context`, `subagents`, `sampling`, `budget.*`); replace explicit-id loading with **directory globbing** (non-recursive `*.md`, skip `_shared.md`); add `_shared.md` merge; swap ad-hoc `throw new Error` for **Zod-backed fail-fast** validation. Note the template currently defaults `name` to the id and trims the body — keep that.
- **T — Skill system:** `agent-workflows-template/src/engine/skills.ts`, `types/skill.ts` — direct lift for `SKILL.md` discovery → `SkillMetadata`.
- **T — Tool discovery (registry only):** `agent-workflows-template/src/engine/tools.ts` — lift the directory scan that builds a `ToolRegistry`; defer mount/invoke to Sprint 07.
- The template's `Permissions` carried `allowedTools`/`deniedTools`; the spec collapses this to `requireApproval` only (the `tools[]` allowlist replaces allow/deny — see [D6](../specs/00-foundations.md#d6--tools-are-declared-per-agent-tools-is-the-sole-allowlist-mcp-at-the-boundary)). Drop allow/deny.

---

## Implementation notes

1. **Discovery first, then per-agent build.** Resolve the `tools/` and `skills/` registries before building agent definitions so references can be validated and expanded.
2. **Validation is fail-fast and ordered** — the first error stops the load. But each rule must be individually testable; structure validation so every bullet in the [fail-fast list](../specs/01-authoring.md#validation-canonical-fail-fast-list) maps to a distinct error.
3. **`_shared.md` merge is a pure function** over `(sharedFrontmatter, agentFrontmatter)` + `(sharedBody, agentBody)`. Test the worked example from the spec (`maxIterations` preserved, `maxCostUsd` overridden).
4. **Resolved tool names:** a multi-tool/MCP source yields `sourceId__toolName`; a single-tool source yields `sourceId`. `requireApproval` validates against the *expanded* set. `load_skill` is a reserved name — a source resolving to it is a collision.
5. **Plan validation:** `plan` must be a known `RenderPlan` slug; `pro_plus`/`pro_max`/`pro_ultra` are allowed at load time but flagged as needing workspace access (enforcement is a deploy/dispatch concern, Sprint 11).
6. **Performance:** the NFR target is < 500ms to load + validate 20 agents ([Operations](../specs/04-operations.md#non-functional-requirements)). Avoid per-agent re-scanning of the tools/skills dirs.

---

## Exit criteria / acceptance

- `loadAgents(projectRoot)` against a fixture project (the project root containing `agents/`, `tools/`, `skills/`) returns an `AgentSet` with `.get()/.has()/.all()` over fully-resolved `AgentDefinition`s (model resolved, skills resolved, tools expanded). Runtime binding is injected/stubbed.
- Every rule in the [canonical fail-fast list](../specs/01-authoring.md#validation-canonical-fail-fast-list) has a dedicated failing-fixture test asserting the specific error.
- `_shared.md` merge matches the spec's worked example and array-union/scalar-precedence rules.
- Unknown frontmatter field → hard error; empty body → hard error; self-referential `subagents` → hard error.
- 20-agent fixture loads in < 500ms.

---

## Risks / open questions

- **Tool registry vs runtime binding ordering:** discovery needs to *enumerate* tool names without *resolving/connecting* sources (esp. MCP). Ensure the registry can list resolved names cheaply (from static export shape) without opening MCP connections — defer connection to mount time (Sprint 07).
- **`subagents` validation** resolves against the AgentSet, which is mid-construction; resolve in a second pass after all definitions are parsed.
- **Zod vs hand-rolled validation:** Zod gives precise messages cheaply but adds a dependency to the SDK (watch the < 100KB target). Recommend Zod in the loader path; keep it out of the hot loop.
