# Documentation Updates Spec

Update documentation, inline hints, and agent instructions so that users and their coding agents can extend the factory without reading framework source code.

**This spec touches only documentation, JSDoc, comments, and new instruction files. No runtime behavior changes.**

---

## Part 1: run() vs task()

### The Two Methods

Both live on the `Agent` interface (`packages/sdk/src/agents.ts:23-28`), usable from workflows via `ctx.agents.get("name")`.

| | `run()` | `task()` |
|---|---|---|
| **Where it executes** | In-process, inside the current workflow handler | Dispatched to Render Workflows as a separate durable task |
| **Lifecycle** | Dies if the workflow process crashes | Survives process crashes, restarts, and redeployments |
| **Replay** | Memoized by deterministic child run ID — replays return the cached result | Same memoization; additionally the task itself is durable on Render's side |
| **Concurrency** | Blocks the workflow handler (sequential) | Can be `await`ed or run in parallel via `Promise.all()` |
| **Isolation** | Shares process memory with the workflow | Separate process, separate container (on Render Workflows) |
| **Observability** | Child span nested under the workflow run | Independent run record with its own event stream |
| **HITL** | If the agent hits an approval gate, the entire workflow pauses | If the agent hits an approval gate, only that task pauses; other parallel tasks continue |
| **Compute plan** | Runs on the workflow host's plan | Runs on the agent's declared `plan` (e.g., `standard`, `pro`) — can use a bigger machine |
| **Cost** | No dispatch overhead | Small dispatch latency (~100ms cold, ~20ms warm) |

### The Decision Rule

**One sentence:** Use `run()` when the next line needs this agent's output. Use `task()` when you want durability, parallelism, or a different compute plan.

**Expanded:**

```
Is this agent call one of several that can happen at the same time?
  → task() — fan them out with Promise.all()

Does this agent need a bigger machine than the workflow host?
  → task() — it runs on its own declared plan

Must this agent's work survive a process crash independently?
  → task() — it's a separate durable run

Otherwise:
  → run() — simpler, faster, no dispatch overhead
```

### What We Don't Do

We do **not** introduce a unified `exec()` that guesses the right behavior. The semantics are genuinely different (same-process vs distributed, blocking vs parallelizable). Hiding this behind a single method would require guessing intent, which is fragile and surprising when wrong.

---

## Part 2: Dedicated Agent Instructions for Extending the Factory

### Problem

A founder who wants to add a new agent, create a custom workflow, wire up a tool, or configure an approval policy has to reverse-engineer conventions from existing code and the README. Both Vercel and Cloudflare lean into purpose-built instruction documents — Foreman ships an AGENTS.md that any coding agent reads on first contact, and triagebot-action ships fill-in-the-blank Markdown templates.

### Solution

Ship an `AGENTS.md` at the repo root that any coding agent (Cursor, Claude Code, Codex) reads automatically when working in the repository. This single file covers all four extension points:

**1. Authoring agents** — frontmatter schema, file placement, what fields are required vs optional, how agents are discovered

**2. Composing workflows** — `run()` vs `task()` vs `step()`, how threading works, how workflows are registered, replay-safety contract

**3. Adding tools** — local tools (`defineTool`), multi-tool sources (`defineToolSource`), MCP servers (`defineMcpSource`), directory convention, namespacing rules, how to grant tools to agents

**4. Configuring policies** — `permissions.requireApproval` syntax, tool ID format for approval references, budget fields

### What the AGENTS.md is NOT

- It is not a replacement for the README (which targets humans browsing GitHub)
- It is not API reference documentation (JSDoc handles that)
- It is not architecture docs (that's `docs/mvp/MVP.md`)

It is specifically **the document a coding agent reads to produce correct code when extending the factory.** It should be opinionated, direct, and complete enough that the coding agent never needs to grep the source to answer "where do I put this?" or "what's the format?"

---

## Part 3: Flatten Package Imports

### Problem

Workflows currently import from multiple packages:

```ts
import { workflow } from "@render-factory/sdk";
import { RenderSandboxProvider } from "@render-factory/sandbox-render";
import { collectExecOutput } from "@render-factory/engine";
```

A founder scanning this sees three packages and wonders what else is in `engine` vs `store` vs `gateway`. The answer for authoring is: nothing — `sdk` re-exports everything they need except these two.

### Solution (documentation-only, this spec)

Add an explicit note to the README and AGENTS.md:

> Import from `@render-factory/sdk` for all authoring. You should never need to import from `@render-factory/engine`, `@render-factory/store`, or `@render-factory/gateway` when writing agents, workflows, or tools. Those packages are internal infrastructure.

### Follow-up (code change, separate spec)

Re-export `RenderSandboxProvider` and `collectExecOutput` from `@render-factory/sdk` so workflows never import from `engine` or `sandbox` directly. Out of scope for this doc-only spec.

---

## Files to Update

### 1. `packages/sdk/src/agents.ts` — Add JSDoc to the Agent interface

**Touches:** `packages/sdk/src/agents.ts` lines 23-28
**Does not touch:** Any implementation code, `workflow.ts`, engine, store, gateway

Current:

```ts
export interface Agent {
  readonly name: string;
  readonly definition: AgentDefinition;
  run<T = unknown>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>>;
  task<T = unknown>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>>;
}
```

Updated:

```ts
export interface Agent {
  readonly name: string;
  readonly definition: AgentDefinition;

  /**
   * Run the agent in-process within the current workflow.
   *
   * Use for sequential pipeline steps where the next step depends on this
   * result. Faster than task() (no dispatch overhead), but shares the workflow
   * process — if it crashes, the workflow restarts from its last memoized step.
   *
   * Both run() and task() are replay-safe: deterministic child run IDs ensure
   * re-drives return the memoized result instead of re-running the agent.
   */
  run<T = unknown>(input: AgentInput, opts?: RunOptions): Promise<AgentOutput<T>>;

  /**
   * Dispatch the agent as a durable isolated task on Render Workflows.
   *
   * Use when:
   * - Multiple agents should run in parallel: `Promise.all([a.task(), b.task()])`
   * - The agent needs a different compute plan than the workflow host
   * - You want the agent's work to survive independently of the parent process
   *
   * Both run() and task() are replay-safe: deterministic child run IDs ensure
   * re-drives return the memoized result instead of re-dispatching.
   */
  task<T = unknown>(input: AgentInput, opts?: TaskOptions): Promise<AgentOutput<T>>;
}
```

### 2. `packages/sdk/src/workflow.ts` — Add JSDoc to the workflow-scoped Agent methods

**Touches:** `packages/sdk/src/workflow.ts` lines 440 and 472 (the `run` and `task` implementations inside `createRunScopedAgent`)
**Does not touch:** Any logic, control flow, or exports

Add matching JSDoc above each `async run<T>` and `async task<T>` in the `createRunScopedAgent` function so hover works for workflow-scoped agents too.

### 3. `app/workflows/spec-to-pr/index.ts` — Add explanatory header comment

**Touches:** Top of file (add comment after imports)
**Does not touch:** Any logic

```ts
// Pipeline: research → plan → implement (sequential, each feeds the next).
// Uses run() because each step's output is the next step's input.
// task() is used only in pr-review where reviewers fan out in parallel.
```

### 4. `app/workflows/pr-review/index.ts` — Add explanatory header comment

**Touches:** Top of file (add comment after imports)
**Does not touch:** Any logic

```ts
// Fan-out: five specialist reviewers run in parallel, then judge synthesizes.
// Uses task() because reviewers are independent and benefit from separate
// containers. Uses run() for the final judge step (sequential, needs all results).
```

### 5. `README.md` — Add run/task callout and imports note

**Touches:** `README.md` around line 139 (after the workflow code example) and in the tools section
**Does not touch:** Any other README sections

Add after the workflow example:

```markdown
> **`run()` vs `task()`:** Use `run()` for sequential steps (research, then
> plan, then implement). Use `task()` for parallel steps (fan out reviewers at
> once). When in doubt, use `run()` — it's simpler and faster.
```

Add near the tools section:

```markdown
> **Import from `@render-factory/sdk` for all authoring.** You should never need
> to import from `@render-factory/engine`, `@render-factory/store`, or
> `@render-factory/gateway` when writing agents, workflows, or tools. Those
> packages are internal infrastructure.
```

### 6. `AGENTS.md` (new file at repo root) — Full extension instructions

**Touches:** New file
**Does not touch:** Any existing files

Sections:

1. **Project structure** — what's in `app/` (you customize), what's in `packages/` (infrastructure, don't touch)
2. **Authoring agents** — frontmatter schema (required: `description`; common: `model`, `tools`, `budget`; advanced: everything else), file placement (`app/agents/<name>.md`), discovery rules
3. **Composing workflows** — `workflow()` signature, `ctx.agents.get().run()` vs `.task()` with the decision rule, `ctx.step()` for replay-safe side effects, file placement (`app/workflows/<name>/index.ts`), registration in entrypoints
4. **Adding tools** — `defineTool()` for single tools, `defineToolSource()` for multi-tool, `defineMcpSource()` for MCP, directory convention (`app/tools/<id>/index.ts`), namespacing (`<source>__<tool>`), granting to agents via `tools:` frontmatter
5. **Configuring policies** — `permissions.requireApproval` in agent frontmatter, tool ID format, budget fields and their enforcement behavior
6. **Imports** — always `@render-factory/sdk`, never engine/store/gateway

---

## Implementation Checklist

| # | File | Change type | Touches runtime? |
|---|------|-------------|-----------------|
| 1 | `packages/sdk/src/agents.ts` | JSDoc on interface | No |
| 2 | `packages/sdk/src/workflow.ts` | JSDoc on implementations | No |
| 3 | `app/workflows/spec-to-pr/index.ts` | Header comment | No |
| 4 | `app/workflows/pr-review/index.ts` | Header comment | No |
| 5 | `README.md` | Callout boxes (2) | No |
| 6 | `AGENTS.md` (new) | Full extension guide | No |

**Estimated effort:** ~2-3 hours. All documentation and comments. No tests to update. No runtime behavior changes.
