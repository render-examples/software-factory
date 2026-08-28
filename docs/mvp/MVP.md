# render-factory — MVP Reference

This document walks through every component of the render-factory MVP, how they fit together, what the system offers today, and where gaps remain for production use.

---

## System Overview

render-factory is an open-source, self-hosted template for building autonomous coding agent workflows on Render. You define agents in Markdown, compose them into durable multi-step workflows, and deploy them as two services (gateway + workflows host) backed by Postgres. Agents receive work from Slack and GitHub, execute code in isolated Render Sandboxes, and deliver results back to those surfaces automatically.

The MVP ships four connected workflows, twelve agents, six tool sources, and a React operator UI — enough to run an interactive assistant, generate PRs from specs, review PRs with parallel reviewers, and fix review feedback autonomously.

---

## Architecture

Two services share a Postgres database:

```
Slack / GitHub / HTTP API
            │
            ▼
         Gateway                      (app/src/server.ts)
  authentication, webhooks,
  threads, streaming, operator UI
            │
            ▼
      Render Workflows Host           (app/src/workflows.ts)
  chat turns, issue-to-PR,
  PR review, review follow-up
       │             │
       ▼             ▼
   Postgres     Render Sandboxes
 event log,      isolated code
 projections,      execution
 thread state
```

Both entrypoints call `createRuntime()` with identical configuration so they share the same store, agents, tools, and dispatch logic. The gateway handles HTTP traffic and webhook ingestion; the workflows host runs all agent compute via Render Workflows tasks.

---

## Package Map

The monorepo has five packages with an enforced acyclic dependency graph:

```
store ← engine ← sdk
              ↑
           gateway → {sdk, store}
```

CI validates that `engine` and `store` never import `sdk`, and `store` never imports `engine`.

| Package | Role | Key Exports |
|---------|------|-------------|
| **store** | Persistence layer | Event log (memory + Postgres), projections, threads, surfaces, items, OAuth, approvals, schedules, job/command/inbound queues, retention, delta bus |
| **engine** | Execution core | Agent loop (`DefaultRunner`), tool system (`defineTool`, `defineToolSource`, `defineMcpSource`), model clients (Anthropic, OpenAI), context management, HITL suspender, policy stubs, SSRF-guarded fetch, sandbox interface |
| **sdk** | Public API / composition root | `createRuntime()`, `workflow()`, `loadProject()`, agent/tool/channel loading, dispatch (in-process + Render Workflows), Slack channel, webhook verification, testing helpers |
| **gateway** | HTTP service + operator UI | Hono routes (runs, threads, streaming, HITL, OAuth, schedules, channels, admin), auth (Bearer + JWT + cookie session), React 19 + Tailwind 4 operator UI |
| **sandbox/render** | Sandbox provider | `RenderSandboxProvider` via `@renderinc/sdk` |

A sixth package, `app/`, is the deployable application that wires everything together.

---

## Data Model

The keystone design is **event sourcing**: an append-only `run_events` table is the single source of truth. Everything else is a projection folded from that log.

| Entity | Storage | Purpose |
|--------|---------|---------|
| **RunEvent** | `run_events` (append-only) | Canonical execution log. Gap-free `seq` per run via advisory locks. |
| **Run** | `runs` (projection) | Unit of execution — interactive (chat turn) or background (spec-to-pr). |
| **Span** | `spans` (projection) | Observability tree for tracing. |
| **ToolCall** | `tool_calls` (projection) | Idempotency index for replay. |
| **RunMessage** | `run_messages` (projection) | Per-agent LLM conversation history. |
| **WorkflowStep** | `workflow_steps` (projection) | Memoized `ctx.step()` results for deterministic workflow replay. |
| **InputRequest** | `input_requests` (projection) | HITL pause/resume state. |
| **Thread** | `threads` | Persistent conversation container. |
| **ThreadSurface** | `thread_surfaces` | Notification delivery targets (Slack channel:ts, GitHub issue). |
| **ThreadItem** | `thread_items` | User-facing timeline (messages, workflow results, status updates). |
| **OAuthConnection** | `oauth_connections` | AES-256-GCM encrypted OAuth tokens. |
| **InboundMessage** | `inbound_messages` | Durable inbound webhook queue. |
| **Command** | `commands` | Command queue with lease-based processing. |
| **Schedule** | `schedules` | Cron schedule definitions. |

Postgres migrations are managed by 18 SQL files in `packages/store/src/pg/sql/`. A memory store provides behavioral parity for local dev and tests (validated by a dedicated parity test suite).

---

## Agents

Agents are defined as Markdown files in `app/agents/`. Frontmatter declares the model tier, tools, budget, and permissions; the body is the system prompt.

```yaml
---
description: Implements an approved plan and runs relevant tests
model: large
tools: [sandbox]
budget:
  maxIterations: 60
  maxCostUsd: 15
  maxWallSeconds: 1800
---
You are an implementation agent...
```

The MVP ships twelve agents:

| Agent | Used By | Role |
|-------|---------|------|
| `assistant` | `chat-turn` | Interactive conversational agent with Render MCP and workflow dispatch |
| `triage` | `spec-to-pr` | Classifies issues, extracts requirements |
| `researcher` | `spec-to-pr` | Explores the codebase in a sandbox to gather context |
| `planner` | `spec-to-pr` | Produces an implementation plan from research |
| `implementer` | `spec-to-pr`, `pr-fix` | Writes code and runs tests in a sandbox |
| `security` | `pr-review` | Reviews for security vulnerabilities |
| `performance` | `pr-review` | Reviews for performance issues |
| `correctness` | `pr-review` | Reviews for logic and correctness bugs |
| `tests` | `pr-review` | Reviews test coverage and quality |
| `lint` | `pr-review` | Reviews code style and lint compliance |
| `judge` | `pr-review` | Combines reviewer findings into a single GitHub review |
| `deployer` | (demo) | Demonstrates approval-gated deployment |

**Agent execution model:**
- `agent.run()` — in-process child span, shares the parent run's event log
- `agent.task()` — isolated durable child run via Render Workflows, survives process crashes

---

## Workflows

Workflows are durable multi-step orchestrations defined in `app/workflows/`. They use `ctx.step()` for replay-safe side effects and `ctx.agents` to invoke agents.

### chat-turn

| Field | Value |
|-------|-------|
| Trigger | Slack message, API thread message |
| Agents | `assistant` |
| Flow | Drive one agent turn → append reply to thread → notify all surfaces |

The simplest workflow. It receives a message, runs the assistant agent, and posts the response back to wherever the conversation lives (Slack, operator UI, API).

### spec-to-pr

| Field | Value |
|-------|-------|
| Trigger | `start_workflow` tool (from assistant), GitHub issue |
| Agents | `triage`, `researcher`, `planner`, `implementer` |
| Flow | Triage → create sandbox → research → plan → implement → run tests → create branch + PR → notify surfaces |

The most complex workflow. It takes a spec or GitHub issue through the full pipeline from understanding to a pull request. The implementer runs in an isolated Render Sandbox with its own filesystem and process space.

### pr-review

| Field | Value |
|-------|-------|
| Trigger | GitHub `pull_request` webhook (opened, synchronized) |
| Agents | `security`, `performance`, `correctness`, `tests`, `lint`, `judge` |
| Flow | Fan out five reviewers in parallel → judge combines findings → post one GitHub review |

Five specialist reviewers analyze the PR diff concurrently, then the judge agent synthesizes their findings into a single coherent review submitted to GitHub.

### pr-fix

| Field | Value |
|-------|-------|
| Trigger | GitHub `pull_request_review` on `agent/*` branches |
| Agents | `implementer` |
| Flow | Reopen sandbox on the agent branch → implementer applies fixes → push changes → notify PR and thread |

When a human reviews an agent-created PR and requests changes, this workflow picks up the feedback and attempts to address it.

---

## Tools

Tools are the boundary between model reasoning and side effects. They share schema validation, approval gates, tracing, and structured error handling regardless of whether they're local TypeScript functions, sandbox operations, or remote MCP servers.

Tool sources are discovered by convention from `app/tools/<source-id>/index.ts`. The directory name is the source ID that agents reference in their frontmatter.

### Built-in tool sources

| Source | Type | Description |
|--------|------|-------------|
| `sandbox` | Local multi-tool source | Execute commands and read, write, patch, or search files in Render Sandboxes. |
| `github_repos` | Local tool | List or search repositories available to the configured GitHub token. |
| `start_workflow` | Local tool | Dispatch a durable background workflow while preserving the calling thread. |
| `get_activity` | Local tool | Read a bounded recent activity window for a run or thread. |
| `render` | HTTP MCP source | Mount tools from the Render MCP server under `render__*`. |
| `deploy` | Local demo tool | Demonstrates approval, pause, and resume. Returns a synthetic release — does not actually deploy. |

### Tool mounting and namespacing

- A single local tool is exposed as `<source-id>`
- A multi-tool source is exposed as `<source-id>__<tool-name>`
- MCP tools are always `<source-id>__<server-tool-name>`
- Agents only see tools they declare in `tools:` — this is an enforced allowlist, not prompt guidance

### Adding tools

Local tools use `defineTool()`, multi-tool sources use `defineToolSource()`, and MCP servers use `defineMcpSource()` with either HTTP or stdio transport. All three follow the same directory convention and agent allowlist.

---

## Channels

Channels are inbound webhook adapters that bridge external platforms to the runtime.

### Slack (`app/channels/slack.ts`)

Receives Slack Events API payloads at `POST /channels/slack`. Verifies the Slack signing secret, parses message events, creates or reuses threads with a Slack surface binding, and dispatches `chat-turn` workflows. Replies are delivered back via `chat.postMessage` to the originating Slack thread.

### GitHub (`app/channels/github.ts`)

Receives GitHub webhook payloads at `POST /channels/github`. Verifies the webhook secret and routes events to workflows:
- `issues.opened` / `issues.labeled` → `spec-to-pr`
- `pull_request.opened` / `pull_request.synchronize` → `pr-review`
- `pull_request_review.submitted` on `agent/*` branches → `pr-fix`

---

## Gateway

The gateway (`packages/gateway/`) is a Hono HTTP service that serves as the thin front door. It handles authentication, webhook ingestion, thread management, run dispatch, SSE streaming, and the operator UI. No agent execution happens here.

### Authentication

Three auth mechanisms serve different consumers:
- **Bearer token** — API clients authenticate with `RENDER_FACTORY_API_KEY`
- **JWT** — optional, for integration with external identity providers
- **Cookie session** — the operator UI uses a login form backed by the same API key

### Key route groups

| Route Group | Purpose |
|-------------|---------|
| `POST /channels/:id` | Inbound webhooks (Slack, GitHub) with per-channel signature verification |
| `POST /workflows/:name` | Dispatch a workflow run |
| `GET/POST /threads`, `/threads/:id/messages` | Thread CRUD and message delivery |
| `GET /runs`, `/runs/:id`, `/runs/:id/stream` | Run listing, detail, and SSE event streaming |
| `POST /runs/:id/cancel` | Run cancellation |
| `GET /inputs`, `POST /inputs/:id/provide` | HITL approval listing and resolution |
| `GET/POST /schedules` | Cron schedule CRUD |
| `GET /oauth/:provider/authorize`, `/callback`, `DELETE` | OAuth connect/callback/revoke |
| `POST /admin/retention`, `/admin/runs/reap`, `/admin/schedules/tick` | Maintenance endpoints called by cron services |
| `GET /ui/*` | Serves the React operator UI SPA |

### Operator UI

A React 19 + Tailwind 4 single-page application served at `/ui`. Views include:

- **Runs** — list with status filtering, cost, and duration
- **Run Detail** — full trace tree with spans, tool calls, model interactions, and streaming tokens
- **Chat** — interactive thread view for testing the assistant
- **Approvals** — pending HITL input requests
- **Schedules** — cron schedule management
- **Workflows** — available workflow listing
- **Connections** — OAuth connection status
- **Ops** — operational controls
- **Event Log** — raw event log viewer

The UI uses SSE for live streaming of run progress and token deltas.

---

## Dispatch and Execution

### Dispatch model

The SDK provides two dispatcher implementations:

| Dispatcher | When | How |
|-----------|------|-----|
| `InProcessDispatcher` | Local dev, tests | Runs workflows and agents in the same process |
| `RenderWorkflowsDispatcher` | Production | Dispatches to Render Workflows via `startTask()` for durable, crash-resilient execution |

Both implement the same interface. The runtime selects based on the presence of `RENDER_WORKFLOW_SLUG`.

### Workflow execution

Workflows use `ctx.step()` for memoized, replay-safe side effects. If a workflow crashes and restarts, completed steps are skipped via `workflow_steps` lookup. This gives at-least-once execution with idempotent replay.

### Agent execution loop

The `DefaultRunner` in the engine implements the core LLM agent loop:
1. Build conversation from event history
2. Call the model client (Anthropic or OpenAI)
3. Parse tool use blocks from the response
4. Check idempotency (skip already-applied tool calls on replay)
5. Check approval gates (pause if tool requires human approval)
6. Execute the tool with SSRF-guarded fetch
7. Emit events to the store
8. Loop until the model produces a final response or a budget limit is hit

### Context management

The engine includes automatic context compaction. When the conversation exceeds the model's context window, older messages are summarized to make room while preserving key information.

### Budget enforcement

Each agent declares iteration, cost, time, and token budgets in its frontmatter. The runner enforces these limits during execution and terminates the run if any are exceeded.

---

## HITL (Human-in-the-Loop)

The HITL system supports two patterns:

### Tool approval gates

Agents declare `permissions.requireApproval: [tool_name]` in their frontmatter. When a matching tool is called, the run emits `input.requested` and `run.paused` events, then suspends. An operator resolves the request via `POST /inputs/:id/provide` in the gateway or the operator UI. The run resumes by replaying from the event log.

### Native pause/resume

On Render Workflows, suspension uses the native `waitForInput()` mechanism instead of polling. The workflow task suspends at the platform level and is woken by the gateway when input arrives.

---

## Streaming

Real-time streaming operates in two layers:

1. **Delta bus** — Postgres `NOTIFY`/`LISTEN` broadcasts live token deltas from the workflows host
2. **SSE endpoints** — `GET /runs/:id/stream` and `GET /events/stream` merge durable event tails with live deltas for gap-free streaming

The operator UI and API clients consume SSE for live run progress, token-by-token output, and status changes.

---

## Observability

### Event log

Every execution action is recorded as a typed event in `run_events`. Event types include `llm.call`, `llm.result`, `tool.called`, `tool.result`, `run.started`, `run.completed`, `span.started`, `span.ended`, `input.requested`, `input.provided`, and more.

### Span tracing

Events fold into a span tree (stored in the `spans` projection) that provides hierarchical tracing of agent execution — model calls nest inside tool calls, which nest inside agent runs, which nest inside workflow steps.

### Cost tracking

The engine estimates cost per model call using a built-in pricing table. Costs aggregate at the run and span level, visible in the operator UI.

---

## Deployment

### Render Blueprint (`render.yaml`)

The Blueprint provisions:
- **render-factory-gateway** — Docker web service (standard plan), health check at `/health`
- **render-factory-db** — Managed Postgres (basic-256mb)
- **render-factory-retention** — Daily cron (4 AM UTC) calling `POST /admin/retention`
- **render-factory-reaper** — 5-minute cron calling `POST /admin/runs/reap`

### Manual step: Workflows service

Render Blueprints cannot yet create Render Workflows services. The Workflows service must be created manually with the same repository and Dockerfile. Start command: `node app/dist/src/workflows.js`.

### Docker

The Dockerfile uses Node 22.13-slim, installs pnpm, builds all packages, and defaults to running the gateway. `docker-compose.yaml` provides a local stack with Postgres, gateway, and workflows on a shared network.

### Required environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `RENDER_FACTORY_API_KEY` | Gateway bearer auth |
| `RENDER_FACTORY_ENCRYPTION_KEY` | OAuth encryption + session signing |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | LLM provider |
| `RENDER_API_KEY` | Render platform API |
| `RENDER_WORKSPACE_ID` | Render workspace |
| `RENDER_WORKFLOW_SLUG` | Render Workflows service slug |
| `GITHUB_TOKEN` | GitHub API access (fine-grained PAT) |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook verification |
| `GITHUB_BOT_LOGIN` | Bot username for PR attribution |
| `SLACK_BOT_TOKEN` | Slack Bot (optional) |
| `SLACK_SIGNING_SECRET` | Slack webhook verification (optional) |

---

## Security Model

### What the MVP provides

- **Webhook verification** — Slack signing secret and GitHub HMAC validation on inbound webhooks
- **API authentication** — Bearer token for all gateway endpoints
- **OAuth encryption** — AES-256-GCM for stored OAuth tokens
- **Sandbox isolation** — Code execution in ephemeral Render Sandboxes, separate from gateway and developer machines
- **Budget limits** — Per-agent caps on iterations, tokens, cost, and wall time
- **Approval gates** — Opt-in HITL approval for configured tools
- **Audit trail** — Append-only event log records every model call, tool invocation, and state change
- **Sandbox cleanup** — Automatic termination after workflow completion
- **SSRF protection** — Tools use a guarded fetch that prevents requests to internal networks
- **Credential isolation for MCP** — Stdio MCP servers receive only explicitly declared env vars, not the full process environment

### Important boundaries and caveats

- A sandbox isolates execution from the gateway, but does not limit what an injected credential (e.g., `GITHUB_TOKEN`) can access within its scope
- The GitHub token can push branches and create/review PRs on any repo it has access to — scope it narrowly
- Tool approval is opt-in, not default-deny — unapproved tools execute without human review
- No per-user identity or RBAC — the system uses a single shared API key
- No network egress control beyond SSRF protection on `ctx.fetch`

---

## Testing

### Infrastructure

- **Runner:** Vitest 2 with `forks` pool
- **CI:** GitHub Actions with Node 22/24/26 matrix, Postgres service container
- **CI gates:** Build → typecheck → lint → bundle-size (SDK < 100KB) → test → dependency graph check

### Test coverage by package

| Package | Areas covered |
|---------|---------------|
| **engine** | Agent loop, tool dispatch, MCP client, streaming, HITL/budget enforcement, SSRF guard, model clients, suspender, context management |
| **store** | Memory store, cron parsing, job queue, delta bus, Postgres parity suite (proves memory ↔ Postgres behavioral equivalence) |
| **sdk** | Dispatch, delegation, resume, cancel cascade, project loader, channels, OAuth flows |
| **gateway** | Auth, HITL routes, OAuth routes, schedules, threads, webhooks, UI endpoints, JWT |
| **app** | `get_activity` tool |

### Testing helpers

`@render-factory/sdk/testing` exports `createTestRuntime` and `mockModel` for writing tests against the full runtime without real LLM calls or external services.

---

## Production Gaps

The following areas are not addressed by the MVP and would need attention before using render-factory for production-sensitive workloads.

### Policy and permissions (not implemented)

The MVP has a minimal approval gate (`requireApproval` list) and hook-based event interception, but no real policy system. Production needs include:

- **Default-deny posture** — today unapproved tools auto-execute; a production system should require explicit grants
- **Scoped authority** — agents should only access what their task requires, not everything their credentials allow
- **Dual identity** — policy should evaluate both the acting agent and the initiating user, using the intersection
- **Runtime narrowing (trust ratchet)** — once an agent reads sensitive data, its remaining capabilities should shrink
- **Deterministic enforcement** — policy checked in the runtime, not the prompt

A detailed design exists in `docs/future-work/permissions-and-policy.md` with a phased migration path. The engine already has `PolicyEngine` interface stubs and a `policy.json` in the app, but the enforcement is not wired into tool dispatch.

### Object storage for artifacts (not implemented)

Large tool results (file contents, diffs, build logs) are stored inline in Postgres event rows. This bloats the database at scale. The event schema already declares an `artifactRefs` field for external storage references, but no `BlobStore` implementation exists.

A design in `docs/future-work/object-storage.md` covers S3-compatible blob storage with auto-externalization of results exceeding 8KB, a `read_artifact` tool for agents, and integration with Render Object Store.

### LLM gateway (not implemented)

The engine talks directly to Anthropic and OpenAI APIs. A production deployment would benefit from an LLM gateway (LiteLLM, Portkey, etc.) for unified routing, fallbacks, rate limiting, semantic caching, and per-agent observability.

The existing `OpenAIClient` already works with any OpenAI-compatible endpoint via `baseURL`, so Tier 0 integration (config-only) works today. Higher tiers (metadata enrichment, cost passthrough, project-level defaults) are designed in `docs/future-work/llm-gateway.md`.

### E2E live testing (not implemented)

`spec-to-pr` runs tests in the sandbox but never against a deployed preview. A live testing workflow would deploy the PR branch to a Render preview environment, run agent-driven tests against it, and report results to the PR. Designed in `docs/future-work/e2e-live-testing.md`.

### Identity and multi-tenancy

- **No per-user identity** — the gateway uses a single shared API key; there is no concept of individual users, roles, or permissions
- **No RBAC** — all authenticated requests have the same access level (operator)
- **Tenant isolation is structural** — multi-tenancy support exists at the database level (tenant-scoped tables) but is not exposed through the auth layer

### Operational concerns

- **No rate limiting** — the gateway has no request rate limiting; a misbehaving client can saturate the service
- **No cost controls beyond per-run budgets** — there are no daily or monthly spending caps, no per-user cost limits, no alerting on spend
- **Retention is basic** — two-domain cleanup (events 30 days, runs 90 days) via cron, but no configurable retention policies or data export
- **No health dashboard** — the operator UI shows individual runs but has no aggregate health metrics, error rate tracking, or operational alerts
- **Monitoring relies on Render platform metrics** — no application-level metrics export (Prometheus, Datadog, etc.)

### Workflow gaps

- **`deploy` tool is demo-only** — it returns a synthetic release rather than performing a real deployment
- **`spec-to-pr` test failures don't block** — the workflow creates the PR even if tests fail
- **`pr-fix` review comment ingestion is incomplete** — not all review comment formats are parsed
- **No workflow versioning** — changing a workflow definition affects in-flight runs
- **No workflow timeout enforcement at the orchestration level** — individual agents have budgets, but the overall workflow duration is bounded only by Render Workflows platform limits

### Sandbox limitations

- **Render Sandboxes require product access** — not available on all Render plans
- **No sandbox resource limits beyond platform defaults** — agents can consume arbitrary CPU/memory within a sandbox
- **Sandbox artifacts don't survive termination** — files are lost when the sandbox is cleaned up (blocked on object storage)

### Reliability

- **No dead-letter queue** — failed inbound messages are retried but can be lost if retries are exhausted
- **No circuit breakers** — a failing LLM provider causes cascading failures rather than graceful degradation
- **Idempotency covers tool calls but not all side effects** — GitHub API calls within tool implementations may not be idempotent on replay

---

## Summary

The MVP delivers a complete vertical slice: agents defined in Markdown, composed into durable workflows, deployed as two services on Render, receiving work from Slack and GitHub, executing code in sandboxes, and delivering results back automatically. The event-sourced data model, memoized workflow steps, and HITL suspension provide a solid foundation for reliability.

The primary gaps cluster around **authorization** (no policy engine, no per-user identity, no default-deny), **operational maturity** (no rate limiting, no cost controls, no metrics export), and **scale** (inline artifact storage, no LLM gateway, no live testing). Each gap has a designed solution in `docs/future-work/` with estimated effort ranging from half a day to three days.

---

## Open Questions

### 1. How does this relate to a Render Agent SDK?

render-factory is a self-hosted template — you fork it, customize agents and workflows, and deploy it yourself. A Render Agent SDK would be a published library that extracts the reusable primitives (agent loop, tool system, event-sourced store, workflow dispatch, HITL) into packages customers install and compose in their own applications without forking a monorepo. The question is where the boundary falls: does render-factory remain the opinionated reference deployment while the SDK becomes the building block layer, or does the factory itself become a thin skin over the SDK? Related tensions include how much of the runtime (model clients, context management, sandbox provider) belongs in an SDK vs. stays as factory-level opinion, and whether the SDK should be Render-specific or platform-agnostic with Render as one provider.

### 2. How can we best leverage the Render MCP to provide more autonomous debugging on deploys?

The assistant agent already mounts the Render MCP as a tool source, but it's passive — the agent only uses it when a user asks. A more autonomous integration could wire the Render MCP into deploy-triggered workflows: when a deploy fails, automatically pull logs via `list_logs`, check metrics via `get_metrics`, inspect environment variables, query the database for migration state, and surface a root-cause analysis without human prompting. This could take the form of a `deploy-debug` workflow triggered by deploy failure webhooks, or deeper integration into `spec-to-pr` and `pr-fix` where the agent verifies its own changes deploy successfully before marking the PR ready. The open question is how far to push autonomy — should the agent attempt automated remediation (rollback, env var fix, restart) or only diagnose and report?

### 3. Is the agent authoring abstraction too heavy?

Defining an agent requires a Markdown file with YAML frontmatter (model, tools, budget, permissions) plus a system prompt body, then referencing it from a workflow that manages orchestration, step memoization, and dispatch. For simple use cases — "call an LLM with these tools and return the result" — this is a lot of ceremony compared to a plain function call. The question is whether the abstraction earns its weight. The frontmatter-driven approach pays off when you need budget enforcement, approval gates, tracing, and durable execution, but it may discourage adoption if the getting-started path feels over-engineered. Possible simplifications include a lightweight inline agent API (`ctx.llm.call(prompt, { tools })`) for one-off calls that don't need the full agent machinery, or reducing the number of required frontmatter fields by providing stronger defaults.

### 4. How much should we prioritize legibility vs production-readiness?

render-factory serves two audiences with competing needs: people learning how to build agent systems (who need clear, readable code they can follow end-to-end) and teams running real workloads (who need rate limiting, policy enforcement, cost controls, and operational tooling). Many of the production gaps listed above — default-deny policy, RBAC, circuit breakers, metrics export — add complexity that makes the codebase harder to read and the getting-started path steeper. The question is which concerns are hard requirements before shipping (security boundaries that protect users from credential leaks or runaway spend) vs. nice-to-haves that can ship as opt-in layers later (LLM gateway integration, object storage, live testing). A possible frame: anything that could cause irreversible damage if misconfigured (credential scope, cost caps, sandbox isolation) is a hard requirement; anything that improves efficiency or observability at scale is a nice-to-have that shouldn't compromise the legibility of the core path.

### 5. Should we make the authoring SDK a standalone repo?

Today the authoring surface — `defineTool`, `defineToolSource`, `defineMcpSource`, `workflow()`, agent Markdown loading, and `createRuntime()` — lives inside the monorepo as `@render-factory/sdk` alongside the engine, store, and gateway. Extracting it into a standalone repo would let customers `npm install @render-factory/sdk` and build agent applications without cloning or forking the factory. It would also decouple the SDK's release cadence from the reference app's. The tradeoff is that a standalone repo introduces cross-repo coordination for breaking changes between the SDK and the packages it depends on (engine, store), and the current monorepo structure makes it easy to evolve all layers together during early development. The question is timing: extract now to signal that the SDK is a first-class product, or wait until the API surface stabilizes and extract when the cost of cross-repo churn is lower?
