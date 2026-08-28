# render-factory vs Cloudflare (Flue / triagebot-action)

Competitive analysis of Cloudflare's software factory ecosystem: the [Flue](https://github.com/withastro/flue) agent framework (8k GitHub stars) and [triagebot-action](https://github.com/withastro/triagebot-action), a GitHub Action built on Flue that drove Astro's open issue count from 200+ to ~30 in production. Published August 4, 2026 during Cloudflare Agents Week.

---

## What the Cloudflare Ecosystem Is

Two distinct but related projects:

**Flue** is an open-source TypeScript agent framework created by the Astro team (acquired by Cloudflare in January 2026). It uses a hooks-based architecture inspired by React — agents are plain exported functions with a `'use agent'` directive, and capabilities are declared via hooks (`useModel`, `useTool`, `useSubagent`, `usePersistentState`). Flue is runtime-agnostic: it deploys to Cloudflare Workers, Node.js, GitHub Actions, GitLab CI/CD, and Render.

**triagebot-action** is a GitHub Action built on Flue that automates issue triage. It runs a four-stage pipeline (reproduce, diagnose, verify, fix) as isolated subagents, with a state machine driven by GitHub issue labels. Agent behavior is defined entirely in Markdown skill files — no TypeScript required for customization.

Cloudflare's broader **Agent Development Lifecycle (ADLC)** umbrella also includes `@cloudflare/ci` for CI/CD as Workflows, agent tracing with OpenTelemetry, and Durable Objects for persistent agent sessions.

---

## Architecture Comparison

| Dimension | render-factory | Flue / triagebot-action |
|-----------|---------------|------------------------|
| **Runtime** | Gateway + Render Workflows Host + Postgres | Flue: any (Workers, Node, GH Actions). triagebot: GitHub Actions runner |
| **Database** | Postgres (event-sourced) | Flue: pluggable (Postgres adapter, Durable Objects, SQLite). triagebot: none (stateless per-run) |
| **Execution isolation** | Render Sandboxes | Flue: pluggable sandbox API. triagebot: GitHub Actions runner (no sandbox boundary) |
| **Workflow model** | Explicit TypeScript (`workflow()`, `ctx.step()`) | Flue: hooks + subagent delegation. triagebot: label-driven state machine |
| **Durability** | Event log replay + memoized steps | Flue: Durable Streams with automatic resume on crash. triagebot: GitHub labels are the only durable state |
| **Agent framework** | Custom engine (DefaultRunner) | Flue (Pi harness): sessions, tools, skills, sandbox |
| **State management** | Thread/run model in Postgres | Flue: `usePersistentState` per agent instance. triagebot: `report.md` file passed between subagents |

### Key architectural difference

render-factory is a **complete vertical stack** — it includes the agent runtime, workflow engine, persistence layer, HTTP gateway, and operator UI. Flue is a **framework** — it provides the agent harness and you bring your own deployment, persistence, and UI. triagebot-action is a **narrow application** — it solves one problem (issue triage) on one platform (GitHub Actions) with maximum simplicity.

---

## Agent Authoring Comparison

### render-factory: Markdown with YAML frontmatter

```md
---
description: Implements an approved plan and runs relevant tests
model: large
tools: [sandbox]
budget:
  maxIterations: 60
  maxCostUsd: 15
---
You are the **Implement** phase...
```

### Flue: TypeScript functions with hooks

```ts
'use agent';
import { useModel, useTool, useSubagent } from '@flue/runtime';

export function Implementer() {
  useModel('anthropic/claude-sonnet-4-6');
  useTool(sandboxTool);
  useSubagent(reviewerAgent);
  return `You are the Implement phase...`;
}
```

Agents are plain TypeScript functions. The `'use agent'` directive at the top of the file registers them. The function body calls hooks to declare capabilities, and the return value is the system prompt. Hooks re-run on every turn, enabling conditional tool/skill loading based on state.

### triagebot-action: Pure Markdown skill files

```
.agents/skills/triage/
  SKILL.md          # Orchestration: step order and early exits
  reproduce.md      # How to reproduce bugs in your project
  diagnose.md       # How to find root causes in your codebase
  verify.md         # How to distinguish bugs from intended behavior
  fix.md            # How to write and verify fixes
```

No frontmatter schema, no TypeScript, no configuration. Each file is plain Markdown instructions for the AI agent. The action's state machine owns the pipeline; the skill files teach the agent about the specific codebase. Customization is filling in `<!-- project-specific -->` placeholders in starter templates.

### Comparison

| Aspect | render-factory | Flue | triagebot-action |
|--------|---------------|------|-----------------|
| **Files per agent** | 1 (`.md`) | 1 (`.ts`) | 5 shared (`.md` skill set) |
| **Config language** | YAML frontmatter | TypeScript hooks | None |
| **Learning curve** | Frontmatter schema + workflow API | Hooks mental model + framework concepts | Copy Markdown templates, fill in blanks |
| **Flexibility** | High (any workflow shape) | Very high (conditional hooks, dynamic models) | Low (fixed 4-stage pipeline) |
| **TypeScript required** | For workflows and tools only | For everything | Not at all |
| **Model selection** | `model: large` (tier alias) | `useModel('provider/model')` | Configured in GitHub Action YAML |
| **State management** | Workflow-level via `ctx.step()` | `usePersistentState()` per agent | `report.md` file (blackboard pattern) |

---

## Deployment Comparison

| Step | render-factory | Flue | triagebot-action |
|------|---------------|------|-----------------|
| **Initial deploy** | Fork → Blueprint → manual Workflows → 12+ env vars | `vite build` → deploy to Workers / Node / etc. | Add GitHub Action YAML + create 5 skill files |
| **Credentials** | Manual env var setup | Framework-agnostic (depends on target) | `ANTHROPIC_API_KEY` + GitHub tokens in Action secrets |
| **Time to first run** | ~30 min (with Render access) | Varies by target platform | ~10 min |
| **Maintenance** | Self-managed (gateway, Postgres, crons) | Depends on target (Workers = managed, Node = self-managed) | Zero — GitHub Actions infrastructure |

**triagebot-action has the lowest barrier to entry of any software factory template.** Add a workflow YAML file, create 5 Markdown files from templates, set two secrets, and it works. The trade-off is zero flexibility — you get issue triage on GitHub, nothing else.

---

## What Cloudflare's Ecosystem Does Better

1. **Pure Markdown agent authoring (triagebot-action).** The complete separation between pipeline logic (action-owned) and agent behavior (project-owned Markdown files) is the most accessible customization model. A founder copies templates and fills in project-specific instructions without learning any framework concepts, schemas, or APIs.

2. **Hooks-based conditional capabilities (Flue).** Because hooks re-run on every turn, an agent can dynamically add or remove tools based on persistent state. For example, a triage agent starts with read-only tools and gains write tools only after classifying the issue as actionable. render-factory's tool set is static per agent definition.

3. **Report.md blackboard pattern (triagebot-action).** Each subagent writes findings to a shared `report.md` file. Because subagents run in isolated sessions with fresh contexts, the file is the sole communication channel. This is simpler than render-factory's approach of passing agent outputs through workflow code, though less structured.

4. **State machine via GitHub labels (triagebot-action).** The pipeline state is visible directly on the issue: `triage needed` → `reproducing` → `diagnosing` → `fix verified`. Anyone can audit where an issue is in the pipeline without accessing an internal dashboard. render-factory's state lives in Postgres projections, visible only through the operator UI.

5. **Runtime portability (Flue).** Flue deploys to Cloudflare Workers, Node.js, GitHub Actions, GitLab CI/CD, Daytona, and Render. render-factory is designed for Render — it uses Render Workflows and Render Sandboxes as core primitives.

6. **Production results at scale.** triagebot-action has been running in production on the Astro repository for months, reducing open issues from 200+ to ~30 (85% reduction). This is the most compelling public evidence of a software factory template delivering sustained value. render-factory has no comparable public production deployment.

---

## What render-factory Does Better

1. **Complete vertical stack.** render-factory ships everything: agent runtime, workflow engine, persistence, HTTP gateway, operator UI, streaming, HITL, thread management, multi-channel delivery. Flue is a framework — you build the surrounding infrastructure yourself. triagebot-action is a single-purpose GitHub Action.

2. **Multi-channel delivery.** Results flow to Slack, GitHub, and the operator UI through the thread/surface abstraction. triagebot-action posts only to GitHub issues. Flue supports channels (Slack, Discord, GitHub) but you wire them yourself.

3. **Persistent conversation threads.** The thread model enables multi-turn conversations where a user starts in Slack, the assistant dispatches a workflow, and results come back to the same thread. Neither Flue nor triagebot-action has an equivalent built-in concept.

4. **Durable multi-workflow orchestration.** render-factory's four workflows are interconnected — the assistant can dispatch `spec-to-pr`, PRs trigger `pr-review`, reviews trigger `pr-fix`. triagebot-action is a single pipeline. Flue supports multi-agent orchestration but doesn't ship pre-built workflow templates.

5. **Structured output and type safety.** Agents declare JSON output schemas in frontmatter, and workflows consume typed results (`ctx.agents.get("triage").run<TriageOut>(...)`). triagebot-action's agents communicate via unstructured Markdown files.

6. **Operator UI.** The React-based trace viewer, approval queue, and run inspector provide visibility into agent execution that neither Flue nor triagebot-action includes out of the box.

---

## Simplification Lessons from Cloudflare

Three ideas from the Cloudflare ecosystem that could reduce render-factory's authoring complexity:

1. **Separate pipeline logic from agent instructions (triagebot-action pattern).** The review pipeline (`pr-review`) is a strong candidate. Today, a founder who wants to customize what the security reviewer looks for must understand both the agent Markdown and the workflow TypeScript. If the workflow auto-discovered reviewer agents from a directory (e.g., `app/agents/reviewers/*.md`) and fanned them out automatically, customization would be pure Markdown — add a file, remove a file, edit instructions.

2. **Visible state via labels (triagebot-action pattern).** `spec-to-pr` already manages GitHub labels (`factory:needs-info`, `factory:working`, `factory:done`, `factory:failed`), but the label set and state machine aren't prominently documented or customizable. Making the label-driven state machine a first-class concept — with clear documentation and hooks for custom states — would give teams the same pipeline visibility that triagebot-action provides.

3. **Starter templates with fill-in-the-blank sections.** triagebot-action's `examples/skills/triage/` directory contains generic Markdown templates with `<!-- project-specific -->` comments marking where adopters inject their own context. A similar approach for render-factory's agents — shipping a `templates/` directory with annotated starter agents that a founder copies and customizes — would lower the barrier from "understand the frontmatter schema" to "fill in the blanks."
