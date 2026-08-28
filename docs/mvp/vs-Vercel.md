# render-factory vs Vercel (eve / Foreman)

Competitive analysis of [Foreman](https://github.com/vercel-labs/eve-software-factory-template), Vercel's software factory template built on the [eve](https://eve.dev/) framework. Published August 12, 2026. ~1.1k GitHub stars at time of writing.

---

## What Foreman Is

Foreman is an open-source template that turns GitHub issues and Linear work items into reviewed draft pull requests. It runs four agent stations in a fixed order — classifier, analyst, implementer, reviewer — plus a researcher subagent for web lookups. An orchestrator routes work through the stations; it never writes code or performs analysis itself.

Work arrives six ways: labeling a GitHub issue `factory`, @mentioning the bot on an issue or PR, delegating in Linear, the local dev TUI, red CI on a factory branch, or someone opening a PR (gets a summary comment).

---

## Architecture Comparison

| Dimension | render-factory | Foreman (eve) |
|-----------|---------------|---------------|
| **Runtime** | Two services: Gateway (Hono) + Render Workflows Host | Single eve deployment on Vercel |
| **Database** | Self-managed Postgres (event-sourced) | Vercel Blob (key-value) |
| **Execution isolation** | Render Sandboxes | Vercel Sandbox |
| **Workflow model** | Explicit TypeScript (`workflow()`, `ctx.step()`, `ctx.agents.get()`) | Model-driven routing via orchestrator instructions |
| **Durability** | Event log replay + memoized workflow steps | eve's durable sessions with automatic resume |
| **Auth integrations** | GitHub fine-grained PAT, Slack signing | Vercel Connect (GitHub App, Linear), OIDC for all services |
| **LLM routing** | Direct provider SDKs (Anthropic, OpenAI) | Vercel AI Gateway with OIDC auth (zero API keys) |
| **Channels** | Slack, GitHub webhooks | GitHub App, Linear Agent Sessions, dev TUI |

### Key architectural difference

render-factory uses **explicit workflow composition** — you read `spec-to-pr/index.ts` and see every step as TypeScript code. Foreman uses **model-driven orchestration** — the orchestrator's `instructions.ts` tells the LLM to route through stations in order, and the model decides when to delegate. This makes Foreman's pipeline harder to reason about and debug, but more flexible for ad-hoc routing.

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

One file per agent. Frontmatter declares model, tools, budget, output schema, and permissions. Body is the system prompt. Agents are referenced by name from workflows.

### Foreman (eve): Directory per subagent

```
agent/subagents/reviewer/
├── agent.ts            # defineAgent() — description, model, outputSchema
├── instructions.md     # System prompt
├── sandbox.ts          # Sandbox configuration
└── tools/              # Station-specific tools
```

Each station is a directory under `agent/subagents/` containing multiple files. The `agent.ts` uses `defineAgent()` to declare the model, description, and output schema. Instructions live in a separate `instructions.md`. Stations can have their own sandbox configuration and tools. Subagents inherit nothing from the root — they must be self-contained.

Skills are directories with a `SKILL.md` whose frontmatter `description` controls when the skill loads. Models are centralized in `agent/lib/models.ts`.

### Comparison

| Aspect | render-factory | Foreman (eve) |
|--------|---------------|---------------|
| **Files per agent** | 1 (`.md`) | 2–5 (directory with `agent.ts` + `instructions.md` + optional `sandbox.ts`, `tools/`) |
| **Config language** | YAML frontmatter | TypeScript (`defineAgent()`) |
| **Prompt location** | Same file as config | Separate `instructions.md` |
| **Tool declaration** | `tools: [sandbox]` in frontmatter | Own `tools/` directory per station |
| **Output schema** | YAML `output:` in frontmatter | TypeScript `outputSchema` in `agent.ts` |
| **Model selection** | `model: large` (tier alias) | Centralized `MODELS.reviewer` constant |
| **Composition** | Explicit in workflow TypeScript | Implicit via orchestrator instructions |

**render-factory is more approachable for authoring individual agents.** One markdown file vs a multi-file directory structure. The trade-off is that eve's approach gives each station full filesystem autonomy (own sandbox, own tools), which matters for complex stations with custom tooling.

---

## Deployment Comparison

| Step | render-factory | Foreman (eve) |
|------|---------------|---------------|
| **Initial deploy** | Fork repo → create Blueprint → manually create Workflows service → set 12+ env vars → configure GitHub webhook | One-click Vercel deploy → auto-provisions GitHub App, Linear connector, Blob store, env vars |
| **GitHub integration** | Fine-grained PAT + manual webhook setup | Vercel Connect provisions a GitHub App automatically |
| **LLM credentials** | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` manually | Zero API keys — OIDC + AI Gateway handles authentication |
| **Linear** | Not supported | Auto-provisioned via Vercel Connect |
| **Local dev** | Docker Compose + `render workflows dev` + `tsx` | `vercel link && vercel env pull && pnpm dev` (TUI) |

**Vercel's one-click deploy is the single biggest UX gap.** A founder deploying Foreman sets one env var (`FACTORY_REPO`); a founder deploying render-factory sets 12+ and manually creates a Workflows service. The credential-free model (OIDC + AI Gateway) eliminates an entire class of setup friction.

---

## Security Model Comparison

| Feature | render-factory | Foreman (eve) |
|---------|---------------|---------------|
| **Tool approval** | Opt-in via `permissions.requireApproval` list | Explicit `requireApproval` map with per-tool predicates |
| **Default posture** | Unapproved tools auto-execute | Write tools without a listed policy use SDK's approval-by-default |
| **Trust model** | Single shared API key | Three trust levels: autonomous (labeled issue), trusted (owner/member mention), untrusted (dev TUI) |
| **Git credential handling** | Token injected via `git credential.helper store` inside sandbox | Token injected at sandbox firewall as egress header transform; never enters sandbox |
| **Protected branches** | Branch naming convention (`agent/*`) | `validateBranch()` rejects `main`, `master`, `refs/*`, `HEAD` + conservative charset |
| **Merge capability** | Agent can push and create PRs | Merge is absent from the tool surface entirely |

**Foreman's security model is more mature.** The three-tier trust system, firewall-brokered git credentials, absence of merge from the tool surface, and per-tool approval predicates (not just names) represent a more production-ready authorization model. render-factory's opt-in approval and single shared API key are gaps documented in `docs/mvp/MVP.md`.

---

## What Foreman Does Better

1. **Zero-config deployment.** One-click deploy provisions everything. No API keys, no manual webhook setup, no manual service creation.

2. **Credential brokering.** Git tokens never enter the sandbox — they're injected at the sandbox firewall as egress header transforms. This is structurally stronger than storing tokens inside the sandbox via `git credential.helper`.

3. **Independent review by construction.** The reviewer runs on a different model vendor than the implementer, sees only the pushed branch (never the implementer's reasoning), and returns structured verdicts. This is a deliberate design constraint, not just prompt guidance.

4. **Factory brain (durable memory).** Between runs, Foreman accumulates notes about the target repository — build quirks, recurring review findings, verification gotchas. Every future run starts from this shared context. render-factory has no equivalent cross-run memory.

5. **Handoff artifacts.** Long documents travel between stations by Blob ID rather than being pasted into the orchestrator's context. This keeps context windows manageable for large analyses.

6. **Eval suite.** Ships routing, safety, and full-pipeline evals that test real agent behavior. render-factory has unit/integration tests but no agent-level behavioral evals.

---

## What render-factory Does Better

1. **Explicit workflow composition.** Workflows are readable TypeScript. You can see every step, every agent call, every conditional branch. Foreman's pipeline is model-driven — the orchestrator's prompt says "delegate to the analyst," and the model decides when and how. This makes debugging harder and behavior less predictable.

2. **Simpler agent authoring.** One markdown file vs a multi-file directory. A founder reads `implementer.md` and understands the agent immediately. In eve, understanding a station requires reading `agent.ts`, `instructions.md`, possibly `sandbox.ts`, and the `tools/` directory.

3. **Parallel review fan-out.** `pr-review` runs five specialist reviewers concurrently via `Promise.all()`, then a judge synthesizes. Foreman routes through a single reviewer station.

4. **Self-hosted by design.** render-factory runs on Render but the architecture is portable — Postgres, Docker, standard Node. Foreman requires Vercel (Connect, Blob, Sandbox, AI Gateway, OIDC).

5. **Event-sourced observability.** The append-only event log provides a complete audit trail with span tracing, cost tracking, and replay. Foreman's observability relies on eve's session model and Vercel's platform telemetry.

6. **PR follow-up workflow.** `pr-fix` automatically picks up review feedback on agent branches and pushes fixes. Foreman's CI fix loop is bounded to its own branches but doesn't respond to review comments.

---

## Simplification Lessons from Foreman

Three things Foreman does that would reduce render-factory's authoring complexity without requiring a framework rewrite:

1. **Centralize model assignments.** Foreman's `agent/lib/models.ts` has one object mapping station names to model IDs. render-factory's per-agent `model: large` tier system is good, but a centralized mapping would make "swap all agents to GPT-5.6" a one-line change instead of editing twelve files.

2. **Durable cross-run memory.** A simple key-value store for per-repo notes (build commands, test frameworks, recurring issues) that every run reads at startup. This reduces re-discovery work and improves agent performance over time.

3. **Reduce deployment steps.** The gap between "fork and deploy" and "working factory" is too wide. Even if Render Blueprints can't create Workflows services today, a CLI scaffolder (`render-factory init`) or a more complete setup guide with copy-pasteable commands would close the distance.
