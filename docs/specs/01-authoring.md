# Authoring

**Status:** DRAFT
**Date:** 2026-06-25

**Layer:** L1 — *what you write.* Part of the [render-agents specification](00-foundations.md) ([Document Map](00-foundations.md#document-map)).

This layer covers everything a developer authors in a project: the directory layout, the agent markdown schema, tools, skills, workflows, subagents, and the API you call. Exact type shapes live in the [Type Reference](05-type-reference.md); runtime behavior lives in [Execution](02-execution.md).

Each section below follows the same shape: **Purpose** (what & why), **Model** (how it works), **Contract** (link to exact types), and an **Example** where useful.

---

## Project Layout & Discovery

**Purpose** — A project is a directory of conventionally-named folders; the SDK discovers everything by location, with no manual registration.

**Model** — A project using the SDK follows this structure:

```
my-project/
├── agents/                           # markdown agent definitions
│   ├── _shared.md                    # merged into every agent
│   ├── security.md
│   └── judge.md
├── tools/                            # tool sources (one or many tools per source)
│   ├── github/                       # multi-tool source
│   │   ├── index.ts
│   │   ├── get-file.ts
│   │   └── create-pr.ts
│   ├── web_fetch/index.ts            # single-tool source
│   └── brave_search/index.ts         # MCP source (many remote tools)
├── skills/
│   └── security-patterns/SKILL.md    # on-demand instruction content
├── workflows/
│   └── code-review/index.ts          # orchestration pipelines
├── webhooks/                         # inbound event adapters (auto-discovered)
│   └── github.ts
├── hooks/                            # event-stream middleware (auto-discovered)
│   └── audit-log.ts
├── runners/                          # custom AgentRunner implementations (optional)
│   └── opencode.ts
├── render.yaml                       # Render deploy manifest
├── compose.yaml                      # local dev: Postgres, etc.
├── package.json
├── tsconfig.json
└── .env
```

**Discovery rules** — each directory has a fixed key derivation and glob. Only duplicate agent names, skill ids, and tool source ids are hard errors; workflow, webhook, and runner keys are **not** separately collision-checked (a duplicate key resolves last-wins, one entry per key):

| Directory | Key | Glob | Collision behavior |
|---|---|---|---|
| `agents/` | filename without `.md` | `*.md` (non-recursive, skip `_shared.md`) | Hard error |
| `tools/` | directory name (source id) | `*/index.{ts,js,mjs}` (single or array export) | Hard error on source id; model-facing tool name collisions enforced at tool mount time (see [Tools](#tools)) |
| `skills/` | directory name | `*/SKILL.md` | Hard error |
| `workflows/` | directory name | `*/index.{ts,js,mjs}` | Last wins (one entry per key) |
| `webhooks/` | filename without ext | `*.{ts,js,mjs}` (skips `.d.ts`) | Last wins (one entry per key) |
| `hooks/` | filename without ext | `*.{ts,js,mjs}` (skips `.d.ts`) | Last wins (one entry per key) |
| `runners/` | filename without ext | `*.{ts,js,mjs}` (skips `.d.ts`) | Last wins (one entry per key) |

> The `Glob` column reflects what the runtime import loaders (`loadToolSources`, `loadWorkflows`, `loadWebhooks`, `loadHooks`, `loadRunners`) accept. `loadAgents`' own discovery/validation pass still only scans `index.ts` / `*.ts` today.

All directories are optional. Missing directories are silently skipped unless an agent references a tool/skill from a missing one. Duplicate-id failures for agents, skills, and tool sources are load-time errors — see the [validation list](#validation-canonical-fail-fast-list).

A `connectors/` directory is also a convention, but it is loaded by the gateway via `loadConnectors(root)` (outside the `loadAgents` discovery set) — see [Platform](03-platform.md).

---

## Agent Markdown Schema

**Purpose** — An agent is a single `.md` file: YAML frontmatter declares configuration; the body is the system prompt.

**Model** — Format:

```markdown
---
model: claude-sonnet-4-6
tools: [github, sandbox]
skills: [security-patterns]
permissions:
  requireApproval: [github__push_code, github__merge_pr]
budget:
  maxIterations: 30
  maxCostUsd: 2
output:
  type: object
  properties:
    decision: { type: string, enum: [approve, reject] }
    reasons: { type: array, items: { type: string } }
  required: [decision]
plan: standard
sampling:
  temperature: 0
runner: default
---

You are a security reviewer. Given a set of file patches, analyze each for...
```

**Frontmatter fields:**

| Field | Type | Default | Validated at |
|---|---|---|---|
| `model` | `string` (tier name or model id) | `"medium"` | Load time (any non-tier string is treated as a raw model id and must be routable; a misspelled tier therefore fails as a routing error, not a tier error) |
| `provider` | `"anthropic" \| "openai"` | Inferred from model | Load time (if set, must be a supported provider) |
| `description` | `string` | (none) | Load time |
| `tools` | `string[]` | `[]` | Load time (source ids or `sourceId__toolName`) |
| `subagents` | `string[]` | `[]` | Load time (resolved against the AgentSet) |
| `skills` | `string[]` | `[]` | Load time (resolved against `skills/`) |
| `permissions.requireApproval` | `string[]` | `[]` | Load time |
| `output` | JSON Schema (object) | (none — text only) | Load time (must be a well-formed object; **not** compiled/validated as a JSON Schema) |
| `context.compaction` | `string` (strategy name, or `none`) | `auto` | Load time (parsed & stored, but **not read at runtime** — the compaction strategy is chosen at `createRuntime({ contextManager })`) |
| `context.maxContextTokens` | `number` | runtime fallback `100_000` | Load time (the ~75%-of-window default applies only when the `DefaultContextManager` is active) |
| `budget.maxIterations` | `number` | `50` | Load time |
| `budget.maxTokens` | `number` | `1000000` | Load time |
| `budget.maxCostUsd` | `number` | `10` (per agent) | Load time |
| `budget.maxWallSeconds` | `number` | (none) | Load time |
| `plan` | `RenderPlan` (Render instance-type slug) | (none)[^plans] | Load time (must be a known plan) |
| `sampling.temperature` / `topP` / `maxOutputTokens` | `number` | (provider default) | Load time |
| `runner` | `string` | `"default"` | Load time (resolved against `runners/`) |
| `interactive` | `boolean` | `false` | Load time (must be a boolean) |

Unknown fields are hard errors at load time.

The `budget.*` defaults above (`maxIterations: 50`, `maxTokens: 1000000`, `maxCostUsd: 10`) are **not** merged at load time; they are applied at run time by `resolveBudget` in the runner. Omitting a budget field leaves it unset on the definition.

[^plans]: Valid plans are `starter`, `standard`, `pro`, `pro_plus`, `pro_max`, `pro_ultra`. Plan-availability against workspace access is enforced at deployment time, not at load time.

**`interactive`** — marks the agent as a *chat surface*. The flag is stored on the definition and read by the gateway/worker to select thread-scoped history when driving turns (`driveAgentTurn`/`resumeRun`); a gateway's `defaultAgent` is typically an `interactive: true` agent. It does **not** change the default runner's loop semantics.

**Model tiers** — tier aliases resolve to concrete models; raw model strings pass through (provider inferred from the name if not set):

| Tier | Provider | Model |
|---|---|---|
| `small` | anthropic | `claude-haiku-4-5` |
| `medium` | anthropic | `claude-sonnet-4-6` |
| `large` | anthropic | `claude-opus-4-6` |

**Model resolution & validation** — model checks are intentionally split so failures are precise:

1. **Routing validity (hard error):** the runtime must be able to route the resolved model to a supported provider client (`anthropic`/`openai`), either from explicit `provider` or inference from `model`. Any non-tier string is treated as a raw model id, so a misspelled tier fails here as a routing error — there is no distinct "unknown tier" error.
2. **Tier resolution:** recognized tier aliases (see table above) resolve to concrete models; unrecognized strings pass through unchanged as raw model ids.
3. **Pricing availability (warning, not hard error):** a routable model id without pricing is allowed; the warning is emitted at run time (on first cost estimation), not at load time. Cost behavior is defined in [Execution → Budgets & cost](02-execution.md#budgets--cost).

**Tool references** — the `tools` array accepts source ids and individual tool names. A bare source id (`github`) mounts the source and exposes all its tools; a namespaced name (`github__get_file`) mounts the source but exposes only that tool. `tools[]` is the allowlist for model-callable tools: only declared tools are presented to the model — with one exception, subagent tools (see [Subagents](#subagents)), which are auto-mounted without appearing in `tools[]`.

`requireApproval` entries may be a source id, a namespaced tool name, or a mix. Load-time validation is bidirectional: it accepts a ref that matches a declared tool/source directly, a whole source when a specific tool of it is declared, or a specific tool of a declared whole source. Run-time gating applies to the expanded tool names with the same symmetry.

> **Known gap (reconciliation):** subagent tools (`subagents__<name>`) are mounted at run time and are absent from the load-time expanded tool set, so `requireApproval: [subagents__researcher]` fails load-time validation even when `subagents: [researcher]` is declared — see `packages/sdk/src/loader/tool-resolver.ts:60`.

**`_shared.md`** — if present, it supplies shared defaults merged into every agent:

- **Body:** `_shared.md` body + `\n\n` + agent body (prepend).
- **Frontmatter (deep merge):** nested objects (`budget`, `permissions`, `sampling`, `context`) deep-merge per leaf (agent wins on conflict, shared leaves preserved); arrays (`tools`, `skills`, `requireApproval`) union + dedupe; `subagents` **replaces** (the agent's list wins wholesale — no union with shared); scalars (`model`, `plan`, `runner`) take agent → shared → built-in default.

`version` is **not** a supported frontmatter field — supplying it (in `_shared.md` or an agent) is an unknown-field hard error. (`AgentDefinition.version` exists but is runtime-only.)

Example: `_shared.md` sets `budget: { maxIterations: 30, maxCostUsd: 10 }` and an agent sets `budget: { maxCostUsd: 2 }` → merged `{ maxIterations: 30, maxCostUsd: 2 }`.

**Contract** — [`AgentDefinition`](05-type-reference.md#agentdefinition), [`Permissions`](05-type-reference.md#permissions), [`Budget`](05-type-reference.md#budget), [`RenderPlan`](05-type-reference.md#renderplan), [`SamplingParams`](05-type-reference.md#samplingparams).

---

## Tools

**Purpose** — Tools are the capabilities an agent's model can call. A tool directory is a **source** that provides one or many tools.

**Model** — Agents reference sources by directory name in frontmatter (`tools: [github]`). Three shapes:

- **Single-tool source** — `index.ts` default-exports one `ToolSource` (or a bare `DefineToolSpec` object, which is coerced via `defineTool`); the model-facing name equals the directory name (`web_fetch`).
- **Multi-tool source** — `index.ts` default-exports an array of `DefineToolSpec` (each coerced via `defineTool`); each tool is namespaced `sourceId__toolName` (`github__get_file`) to prevent cross-source collisions.
- **MCP source** — `index.ts` default-exports `defineMcpSource(...)`; the server's tools are namespaced the same way (`brave_search__web_search`).

| Source type | # tools | Model-facing name |
|---|---|---|
| Single `ToolSource` / `DefineToolSpec` | 1 | `sourceId` (e.g. `web_fetch`) |
| Array of `DefineToolSpec` | N | `sourceId__toolName` |
| `defineMcpSource` | N | `sourceId__toolName` |

> **Known gap (reconciliation):** `defineMcpSource` derives its namespace from `spec.name ?? "mcp"`, **not** the directory name — so if `name` is omitted the model sees `mcp__*` tools regardless of the folder. MCP authors must set `name` in `defineMcpSource` to match the directory name — see `packages/engine/src/tool-impl.ts:73`.

Cross-source collisions on the final model-facing name are hard errors at tool mount time (when an agent run resolves its declared tools), not at load time; load time only checks duplicate source directory ids. Tool *execution* semantics (input validation, idempotency, approval gating) live in [Execution → Tool dispatch](02-execution.md#tool-dispatch).

**Contract** — [`defineTool`](05-type-reference.md#definetool) / [`DefineToolSpec`](05-type-reference.md#definetoolspec), [`defineMcpSource`](05-type-reference.md#definemcpsource) / [`DefineMcpSpec`](05-type-reference.md#definemcpspec), [`Tool`](05-type-reference.md#tool), [`ToolSource`](05-type-reference.md#toolsource), [`ToolContext`](05-type-reference.md#toolcontext).

**Example:**

```ts
// tools/github/index.ts — model sees: "github__get_file", "github__create_pr"
import { defineTool } from "@render-agents/sdk";

export default [
  defineTool({ name: "get_file", description: "Fetch file contents", inputSchema: { /* … */ }, invoke: async (input, ctx) => { /* … */ } }),
  defineTool({ name: "create_pr", description: "Create a pull request", inputSchema: { /* … */ }, invoke: async (input, ctx) => { /* … */ } }),
];
```

A tool's `invoke` may return a plain `string` as shorthand for `{ content: string }`, in addition to a full result object.

---

## Skills

**Purpose** — A skill is on-demand instruction content the model pulls into context when relevant — not always-on system-prompt text.

**Model** — A skill is a directory under `skills/` containing `SKILL.md`. The directory name is the skill `id`. Frontmatter advertises metadata to the model; the body is the `content` injected on load.

```markdown
---
name: Security patterns
description: Common web-app vulnerability patterns and how to spot them.
whenToUse: When reviewing code or diffs for security issues (authn, injection, SSRF, secrets).
---

When auditing for security issues, work through these categories in order:
1. Authentication & session — ...
2. Injection (SQL, command, template) — ...
```

| `SkillMetadata` field | Source |
|---|---|
| `id` | Directory name |
| `name` / `description` / `whenToUse` | `SKILL.md` frontmatter |
| `content` | `SKILL.md` body |

Unlike agent frontmatter, unknown fields in `SKILL.md` frontmatter are **ignored** (not hard errors).

Agents list skill ids in frontmatter (`skills: [security-patterns]`); `loadAgents` resolves each id to fully-resolved `SkillMetadata` stored on the definition. The model loads a skill via the built-in `load_skill` tool — see [Execution → Skill loading](02-execution.md#skill-loading).

**Contract** — [`SkillMetadata`](05-type-reference.md#skillmetadata), [`SkillRegistry`](05-type-reference.md#skillregistry).

---

## Workflows

**Purpose** — A workflow is the composition layer: a TypeScript handler under `workflows/` that orchestrates agents and deterministic steps into a pipeline.

**Model** — `workflows/<dir>/index.ts` default-exports a `workflow()` definition. The name is inferred from the directory (`workflows/code-review/` → `"code-review"`); config is optional. Inside a handler, **always access agents via `ctx.agents`** (the run-scoped set) — not a module-level `loadAgents()` closure (see [Execution → Runtime & composition](02-execution.md#runtime--composition)). Side-effecting or non-deterministic work belongs in `ctx.step()`; the why is in [Execution → Determinism & replay](02-execution.md#determinism--replay).

The handler receives a `WorkflowContext` with: `runId`, `trigger`, `input`, `agents`, `tracer`, `logger`, `signal`, an optional `userId`, and `step()`. Duplicate `ctx.step` names within a run are hard errors.

`workflow()` accepts optional `WorkflowOptions`: `name?`, `timeout?`, `retries?` (defaults to `0`), and `plan?`. The returned `WorkflowDefinition` also exposes `dispatch` and `drive` for execution — see [Execution](02-execution.md).

**Contract** — [`workflow`](05-type-reference.md#workflow), [`WorkflowOptions`](05-type-reference.md#workflowoptions), [`WorkflowContext`](05-type-reference.md#workflowcontext), [`WorkflowDefinition`](05-type-reference.md#workflowdefinition).

**Example:**

```ts
// workflows/code-review/index.ts
export default workflow(async (ctx) => {
  const patches = await ctx.step("prepare-diff", () => prepareDiff(ctx));
  const findings = await Promise.all(
    ctx.agents.get(["security", "performance"]).map(a => a.task({ patches }))
  );
  return ctx.agents.get("judge").run({ findings });
});
```

---

## Subagents

**Purpose** — Subagents add *dynamic* composition: an agent declares which agents it may delegate to, and those are exposed to the model as tools it can call mid-loop (complementing the static composition a workflow handler expresses).

**Model** — An agent lists spawnable agents in frontmatter:

```yaml
subagents: [researcher, summarizer]
```

Each becomes one resolved tool, `subagents__<name>`, whose description is the subagent's `description` (falling back to `Delegate work to the <name> agent.`). These tools are **auto-mounted without appearing in the agent's `tools[]`** — the one exception to `tools[]` being the sole model-callable allowlist. The model calls it like any tool; the tool input is `{ input: string }` (not a full `AgentInput`), and the result is the subagent's output (text + structured `data` when it declares an `output` schema). Default delegation limits are `maxDepth: 5` and `maxFanout: 50`. Spawn mechanics, depth/fan-out limits, and tracing are in [Execution → Subagent delegation](02-execution.md#subagent-delegation).

**Contract** — `subagents` on [`AgentDefinition`](05-type-reference.md#agentdefinition); limits in [`DelegationLimits`](05-type-reference.md#delegationlimits).

---

## Hooks

**Purpose** — Hooks are event-stream middleware applied to every run: cross-cutting concerns (logging/metrics, notifications, policy gates, loop detection) without reimplementing the agent loop. They subscribe to the unified event stream — see [Execution → Hooks](02-execution.md#hooks) for the runtime mechanics.

**Model** — A hook is a `*.ts` file under `hooks/` that default-exports a `Hook`. It declares the event types/categories it reacts to via `on`; `handle(event, ctx)` runs before each matching event is appended and returns `continue` (optionally rewriting the event) or `reject` (a veto, valid for gate categories like `tool`). Hooks under `hooks/` are discovered via `loadHooks(dir)` and applied to all runs when passed to `createRuntime({ hooks })` — `loadAgents` does not load or wire them itself.

**Contract** — [`Hook`](05-type-reference.md#hook), [`HookResult`](05-type-reference.md#hookresult), [`HookContext`](05-type-reference.md#hookcontext).

**Example:**

```ts
// hooks/block-destructive.ts — a policy gate over the event stream
import { defineHook } from "@render-agents/sdk";

export default defineHook({
  name: "block-destructive",
  on: ["tool.called"],
  handle: async (event, ctx) => {
    if (event.type === "tool.called" && event.name === "github__delete_repo") {
      return { action: "reject", reason: "delete_repo is not permitted" };
    }
    return { action: "continue" };
  },
});
```

---

## Authoring API

**Purpose** — The functions you call to load, compose, and test agents. These are the authoring entry points of `@render-agents/sdk`; the runtime composition root (`createRuntime`) is covered in [Execution → Runtime & composition](02-execution.md#runtime--composition).

**Model** — Core exports:

```ts
export function loadAgents(dir?: string, runtime?: AgentRuntime): Promise<AgentSet>;
export function workflow(/* opts?, handler */): WorkflowDefinition;
export function defineTool(spec: DefineToolSpec): ToolSource;
export function defineToolSource(/* … */): ToolSource;
export function defineMcpSource(spec: DefineMcpSpec): ToolSource;
export function defineHook(spec: Hook): Hook;
export function createRuntime(opts?: { /* toolSources, hooks, extraRunners, contextManager, … */ }): Promise<AgentRuntime>;

// Convention-directory loaders (return values you pass into createRuntime):
export function loadToolSources(dir?: string): Promise<Map<string, ToolSource>>;
export function loadHooks(dir?: string): Promise<Hook[]>;
export function loadRunners(dir?: string): Promise<Map<string, AgentRunner>>;
export function loadWorkflows(dir?: string): Promise<Map<string, WorkflowDefinition>>;
export function loadWebhooks(dir?: string): Promise<Map<string, WebhookAdapter>>;

// Execution helpers:
export function bindWorkflow(/* … */): WorkflowDefinition;
export function resumeRun(/* … */): Promise<RunResult>;
export function driveAgentTurn(/* … */): Promise<RunResult>;
```

**Bootstrap sequence** — `loadAgents` is *not* a full bootstrap. It discovers `agents/*.md`, parses + validates frontmatter, merges `_shared.md`, and fully loads the `skills/` registry (markdown parsed into `SkillMetadata`). For `tools/` it only collects the source directory **names** (to validate tool references) — it does **not** import tool modules or populate `runtime.toolSources`. Tool modules, hooks, runners, workflows, and webhooks are loaded by their own loaders and wired through `createRuntime`:

```ts
const toolSources = await loadToolSources(".");
const hooks = await loadHooks(".");
const extraRunners = await loadRunners(".");
const runtime = await createRuntime({ toolSources, hooks, extraRunners });
const agents = await loadAgents(".", runtime);
```

`loadAgents` takes the **project root** `dir` (default `"."`) — the directory that contains the convention folders (`agents/`, `tools/`, `skills/`, …), not the `agents/` folder itself; it throws if the given root looks like an `agents/` folder. It discovers `agents/*.md`, parses + validates frontmatter (failing fast — see below), merges `_shared.md`, fully loads the `skills/` registry, and collects the `tools/` source directory **names** (for reference validation only — it does not import tool modules) from under the same root, binds every agent to the `runtime` (default `await createRuntime()`), and returns an [`AgentSet`](05-type-reference.md#agentset). It is bootstrapping/outside-handler API; inside a handler use `ctx.agents`.

**Testing** (`@render-agents/sdk/testing`) — because the runtime is injectable, tests run the *real* loop against a mock model and in-memory store (no network/Postgres/Workflows):

```ts
import { loadAgents } from "@render-agents/sdk";
import { mockModel, createTestRuntime } from "@render-agents/sdk/testing";

const model = mockModel((args) => ({
  content: [{ type: "text", text: '{"decision":"approve"}' }],
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: "end_turn",
}));
const runtime = await createTestRuntime({ model });
const agents = await loadAgents(".", runtime);
const { data } = await agents.get("judge").run<{ decision: string }>({ findings: [] });
```

**Contract** — [`loadAgents`](05-type-reference.md#loadagents) / [`AgentSet`](05-type-reference.md#agentset) / [`Agent`](05-type-reference.md#agent), [`mockModel`](05-type-reference.md#mockmodel) / [`createTestRuntime`](05-type-reference.md#createtestruntime).

---

## Validation (canonical fail-fast list)

Hard errors raised at `loadAgents()` time. Other layers reference this list rather than restating rules.

**Discovery & collisions:**
- Two sources resolving to the same key — only `agent name`, `tool source id`, and `skill` are hard-error collisions (workflow, webhook, and runner keys are last-wins, not separately validated; model-facing tool name collisions are enforced at tool mount time, not here)
- A tool source resolving to a reserved model-facing name (`load_skill`)
- An agent references a tool/skill from a directory that does not exist

**Frontmatter & references:**
- Unknown frontmatter fields
- Tool reference not resolvable — only the **source id** existence is checked at load; a namespaced tool name absent from an existing source is **not** caught here (it warns at mount time)
- Skill name not found in the `skills/` registry
- Model/provider pair is not routable to a supported provider client (a misspelled tier is treated as a raw model id and surfaces here as a routing error, not a distinct tier error)
- `plan` not a known `RenderPlan` slug
- `output` is not a well-formed object (well-formedness only — not compiled as a JSON Schema)
- `subagents` references an agent not in the AgentSet, or an agent lists itself
- Runner name not found in `runners/` or not `"default"`
- `requireApproval` references a name not accepted against the agent's declared tools/sources (bidirectional match — see [Tool references](#agent-markdown-schema))
- Budget values non-positive (except `maxCostUsd`, which accepts `null`/`0` to disable the cost ceiling)
- `interactive` is not a boolean
- Empty system prompt body
