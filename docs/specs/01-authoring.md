# Authoring

**Status:** IMPLEMENTED (living)
**Date:** 2026-07-02
**Layer:** L1 - what you write.

This layer documents the authoring contracts currently enforced by the SDK loader and runtime wiring.

---

## Project Layout

The project root is the directory passed to `loadAgents(root)` and convention loaders:

```text
my-project/
  agents/
  tools/
  skills/
  workflows/
  webhooks/
  hooks/
  runners/
```

All directories are optional, but references to missing tools/skills/runners fail validation.

---

## Discovery Rules (Current Implementation)

There are two discovery paths:

1. **Agent load-time validation** (`loadAgentsFromDir`) for markdown, skill ids, tool source ids, and runner names.
2. **Runtime module loading** (`loadToolSources`, `loadWorkflows`, etc.) for executable code.

| Directory | Loader | Key | Pattern |
|---|---|---|---|
| `agents/` | `loadAgents` | filename (without `.md`) | `*.md`, skip `_shared.md` |
| `tools/` (validation) | `loadAgents` | directory name | `tools/*/index.ts` |
| `tools/` (runtime) | `loadToolSources` | directory name | `tools/*/index.{js,mjs,ts}` |
| `skills/` | `loadAgents` | directory name | `skills/*/SKILL.md` |
| `workflows/` | `loadWorkflows` | directory name | `workflows/*/index.{js,mjs,ts}` |
| `webhooks/` | `loadWebhooks` | filename | `*.{js,mjs,ts}` excluding `.d.ts` |
| `hooks/` | `loadHooks` | file export `Hook.name` | `*.{js,mjs,ts}` excluding `.d.ts` |
| `runners/` (validation) | `loadAgents` | filename | `*.ts` |
| `runners/` (runtime) | `loadRunners` | filename | `*.{js,mjs,ts}` excluding `.d.ts` |

Notes:

- `loadAgents` expects the **project root**, not the `agents/` directory itself.
- Duplicate-key hard failures are enforced in directory discovery where applicable.
- Connectors are loaded by the gateway from `tools/*/index.*` `connectors` exports, not a standalone `connectors/` directory.

---

## Agent Markdown Contract

Agents are markdown files with YAML frontmatter and a non-empty body.

Supported frontmatter keys (unknown keys fail):

- `model`, `provider`, `description`
- `tools`, `subagents`, `skills`
- `permissions.requireApproval`
- `output`
- `context.compaction`, `context.maxContextTokens`
- `budget.maxIterations`, `budget.maxTokens`, `budget.maxCostUsd`, `budget.maxWallSeconds`
- `plan`, `sampling`, `runner`, `interactive`

Important implementation details:

- `interactive` is a marker consumed by gateway/chat behavior; it does not change loop logic inside `DefaultRunner`.
- `context.maxContextTokens` is used at runtime.
- `context.compaction` is parsed and preserved on `AgentDefinition`, but strategy selection is currently runtime-global (`createRuntime({ contextManager })`).
- `maxCostUsd: null` or `0` disables cost budget enforcement.
- `plan` must be one of: `starter`, `standard`, `pro`, `pro_plus`, `pro_max`, `pro_ultra`.

---

## `_shared.md` Merge Behavior

If `agents/_shared.md` exists:

- Body is prepended to each agent body.
- Frontmatter is merged via `mergeFrontmatter`:
  - scalars prefer agent value over shared value,
  - nested objects deep-merge,
  - arrays dedupe-union except `subagents` (agent-side replacement behavior in code path).

---

## Tools

Tool declarations are references in agent frontmatter (`tools: [...]`).

Supported source exports:

- `ToolSource` from `defineTool`, `defineToolSource`, or `defineMcpSource`.
- Single `DefineToolSpec` object (coerced via `defineTool`).
- Array of `DefineToolSpec` (coerced via `defineToolSource`).

Model-facing naming:

- Single-tool source: `sourceId`
- Multi-tool source: `sourceId__toolName`
- MCP source: same namespacing model

Approval reference validation supports:

- a source id,
- a namespaced tool id,
- cross-match between source-level and namespaced references.

Reserved name:

- `load_skill` cannot be used as a user tool source id.

---

## Skills

Skills are discovered from `skills/*/SKILL.md`:

- skill id = directory name,
- metadata fields are read from frontmatter (`name`, `description`, `whenToUse`),
- body is stored as `content`.

Unknown skill-frontmatter fields are ignored.

At runtime, declared skills are loaded through the built-in `load_skill` tool.

---

## Workflows

Workflows are `workflows/<name>/index.*` default exports built with `workflow()`.

Key authoring contract:

- Inside handlers, use `ctx.agents` (run-scoped handles), not module-level agent handles.
- Side effects and non-determinism belong in `ctx.step(name, fn)` to guarantee replay safety.
- Duplicate `ctx.step` names in one handler execution are errors.

---

## Hooks and Runners

- Hooks are discovered from `hooks/` and passed to `createRuntime({ hooks })`.
- Runners are discovered from `runners/`; agent frontmatter `runner: <name>` must resolve.
- Gate hooks can veto events through the event interceptor path; runner code converts vetoed tool calls into recoverable tool errors.

---

## Bootstrap Sequence (Recommended)

```ts
const toolSources = await loadToolSources(".");
const hooks = await loadHooks(".");
const extraRunners = await loadRunners(".");
const runtime = await createRuntime({ toolSources, hooks, extraRunners });
const agents = await loadAgents(".", runtime);
const workflows = await loadWorkflows(".", runtime);
```

---

## Canonical Fail-Fast Checks

`loadAgents()` hard-fails on:

- unknown frontmatter keys,
- missing/invalid tool source references,
- missing skills,
- invalid plan,
- invalid budget values,
- invalid runner reference,
- invalid `requireApproval` references,
- unresolved subagent names or self-reference,
- empty prompt body,
- invalid frontmatter schema types.

