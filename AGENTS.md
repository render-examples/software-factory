# Repository guide for agents

This file applies to the entire repository. If a nested `AGENTS.md` is added
later, the more specific file takes precedence for that subtree.

## What this repository is

`render-factory` is a self-hosted, single-repository software factory built on
Render Web Services, Workflows, Sandboxes, and Postgres.

The normal path is:

1. An allowed maintainer labels a GitHub issue.
2. The gateway validates the webhook and dispatches only the issue number.
3. A workflow triages the issue, creates an isolated sandbox, analyzes and
   implements the change, and stages the result.
4. Three review agents inspect the diff in parallel and a judge synthesizes
   their findings.
5. Workflow-owned code pushes a branch and opens a draft pull request.

There are two independently deployed processes:

- `app/src/server.ts`: Hono gateway web service.
- `app/src/workflows.ts`: Render Workflows host and task registration entrypoint.

The gateway does not run models or hold the repository token. Agents do not
write to GitHub directly. Repository execution happens in a Render Sandbox.

## Quick start

### Prerequisites

- Node.js 22 or newer.
- npm; `package-lock.json` is authoritative.
- Docker for the local Postgres service.
- Render CLI for `npm run dev:workflows`.
- Render, GitHub, and Anthropic credentials for a full end-to-end run.

### Install and configure

```bash
npm ci
cp .env.example .env
```

Fill in `.env`. The checked-in example intentionally contains no secrets.

### Run locally

Run each command from the repository root in a separate terminal:

```bash
npm run dev:postgres
npm run db:migrate
npm run dev:gateway
npm run dev:workflows
```

- Postgres listens on `localhost:55432`; `.env.example` sets `DATABASE_URL`.
- The gateway listens on `0.0.0.0:${PORT:-3000}`.
- `GET /health` is liveness; `GET /ready` checks Postgres readiness and is
  the Render health-check target.
- GitHub issues webhooks are accepted at `POST /channels/github`.
- `dev:workflows` requires an installed and authenticated Render CLI.
- Local workflow runs still create real Render Sandboxes; the sandbox provider
  explicitly disables local-dev mode.

Production uses `npm run start:gateway` and `npm run start:workflows`. These
commands do not load `.env`; supply the process environment explicitly.

### Verify a change

```bash
npm run check
```

For a focused test:

```bash
npx vitest run app/tests/github.test.ts
```

If `render.yaml` changed and the Render CLI is available:

```bash
render blueprints validate
```

`npm run check` runs Biome lint, TypeScript, and the unit suite. Use
`npm run test:integration` with local Postgres running for the live store
conformance and cross-process probes.

## Environment contract

Gateway:

- `FACTORY_REPO` (required): exact `owner/repo` the factory may operate on.
- `FACTORY_LABEL` (optional): intake label; defaults to `factory`.
- `FACTORY_GITHUB_ACTORS` (required): comma-separated allowed GitHub logins.
- `GITHUB_WEBHOOK_SECRET` (required for requests): webhook HMAC secret.
- `RENDER_WORKFLOW_SLUG` (required to dispatch): deployed Workflows service
  slug, without the task name.
- `DATABASE_URL` (required): shared Postgres RunStore.
- `PORT` (optional): gateway port; defaults to `3000`.

Workflows host:

- `FACTORY_REPO` (required): same fixed repository as the gateway.
- `FACTORY_LABEL` (optional): same intake label as the gateway.
- `ANTHROPIC_API_KEY` (required for Claude-backed agent tasks).
- `GITHUB_TOKEN` (required): fine-grained token scoped to `FACTORY_REPO`.
- `RENDER_API_KEY` (required by the Render SDK).
- `RENDER_WORKSPACE_ID` (required for Sandboxes).
- `DATABASE_URL` (required): same shared Postgres RunStore as the gateway.
- `GITHUB_API_URL` (optional): GitHub API base URL override.

Keep the GitHub token to the minimum Contents, Issues, and Pull Requests
permissions needed to clone, push, comment, and open a draft PR. Never put a
token in a Git remote URL or agent prompt.

## Repository map

```text
app/
  agents/index.ts          Agent definitions and prompts
  tasks/index.ts           Agent definitions wrapped with agentTask()
  workflows/index.ts       Orchestration workflow registration manifest
  workflows/spec-to-pr/    Issue-to-PR pipeline and helpers
  gateway/                 HTTP intake, validation, and workflow dispatch
  hooks/                   Audit, cost tracking, destructive-action block, secret redaction
  lib/                     GitHub, config, model JSON, convention memory, sandbox Git
  src/server.ts            Gateway process entrypoint
  src/workflows.ts         Workflow process entrypoint and registrations
  tests/                   App, gateway, and integration tests
sdk/
  agent.ts                 Agent(), configure(), and agentTask()
  runner.ts                Provider-neutral AgentRunner interface
  runners/                 Runner implementations
  tools.ts                 Tool, ToolSource, and ToolRegistry
  sandbox/                 Provider-neutral interfaces and implementations
  sandbox-tool-source.ts   sandbox__* tools exposed to agents
  hooks.ts                 Agent event interception
  models.ts                Model tier resolution
  blobs.ts                 Oversized result handoff through ArtifactStore
  tests/                   SDK unit tests
store/
  contracts.ts             Backend-neutral store interfaces
  values.ts                Key validation, JSON normalization, artifact refs
  memory.ts                Executable test reference
  runtime.ts               Global FactoryStore singleton
  postgres/                Production Postgres adapter, pool, and migrations
  sql/                     Immutable schema migrations
  tests/                   Backend conformance suites
scripts/
  doctor.ts                Pre-deploy configuration validator
  migrate.ts               Schema migration runner
  cleanup-store.ts         Retention cron entry point
  run-status.ts            CLI run introspection
factory.config.ts          Verification commands for the target repository
render.yaml                Gateway + Postgres + retention cron Blueprint
Dockerfile                 Gateway image only
docker-compose.yml         Local Postgres
```

`#factory/sdk` maps to `sdk/index.ts`. Use this alias from app code for public
SDK APIs. Add a barrel export when a new SDK capability is meant to be public.

`tmp/` is ignored scratch space and may contain stale design notes. Runtime
source, tests, this file, and `README.md` are authoritative.

## Code conventions

- This is strict TypeScript using ESM and NodeNext resolution.
- Include `.js` in relative TypeScript import specifiers.
- Use `#factory/sdk` rather than reaching into SDK internals from app code.
- Use kebab-case workflow filenames and task names; use camelCase exports.
- Validate external and workflow input with Zod before using it.
- Use `md` for dedented multi-line agent prompts.
- Keep dispatch payloads small and JSON-serializable. Fetch large or trusted
  state inside the workflow.
- Escape interpolated shell arguments with `shellEscape`; prefer argument
  arrays with `execGitWithToken` for authenticated Git operations.
- Keep provider-specific code behind `AgentRunner`, `ToolSource`, or
  `SandboxProvider` interfaces.
- Keep persistence consumers behind `FactoryStore` capability interfaces.
  Postgres is the production adapter; unit tests use `MemoryFactoryStore`.
- Persist only bounded event metadata. Prompts, diffs, issue bodies, model
  output, tool payloads, command output, API bodies, and credentials do not
  belong in `run_events`.
- Add or update tests with behavior changes. Do not call live Render, GitHub,
  Postgres, or model APIs from unit tests.

## Core invariants

Preserve these boundaries unless the requested change explicitly redesigns
the security model:

- One deployment is bound to one validated `FACTORY_REPO`.
- Only an `issues.labeled` event from an allowed human actor starts factory
  implementation.
- The webhook signature is checked before JSON parsing or dispatch.
- Pull request conversations, bots, wrong repositories, wrong labels, and
  unsupported events are skipped.
- The gateway maps each authenticated delivery to a logical run and dispatches
  the minimum identifier: `{ issueNumber, runId }`.
- Delivery IDs, logical run IDs, child agent/task run IDs, and execution retry
  IDs are distinct.
- Agents receive only explicitly registered tools.
- Analysis uses read-only sandbox tools; only implementation receives sandbox
  write and exec tools.
- Do not give app agents Claude's built-in `Bash`, `Read`, `Write`, or `Edit`;
  those bypass the workflow-owned sandbox binding.
- `sandboxId` is supplied by workflow code through `AgentTaskInput`; it is not
  model-selected or accepted from public input.
- Git pushes, labels, sandbox lifecycle, and pull request creation stay in
  orchestration code. Agents have no direct GitHub write capability.
- Preserve a sandbox across automatic task retries; terminate it in `finally`
  only after a terminal workflow result or final failed attempt.
- Automation stops at a draft PR. It does not mark ready or merge.
- Render filesystems are ephemeral. Use the configured `FactoryStore` for
  cross-step data, never local disk on a deployed service.

## Tasks: the two meanings

There are two kinds of Render Workflows tasks in this codebase:

1. **Agent tasks** are created by `agentTask(Agent(...))`. They accept
   `{ message: string, sandboxId?: string }` and return a string or blob ref.
2. **Orchestration workflows** are created directly with `task(...)`. They
   compose agents and own external side effects.

Task registration is module side-effect based. `app/src/workflows.ts` imports
`app/tasks/index.ts` and every orchestration workflow module. There is no
separate registry manifest.

## Add an agent task

Use this path when adding another model-backed agent to a pipeline.

### 1. Define the agent

Add the definition to `app/agents/index.ts`:

```ts
export const docsReviewer = Agent({
  id: "docs-reviewer",
  description: "Reviews a staged diff for documentation gaps",
  model: "small",
  tools: [],
  prompt: md`
    Review the supplied staged diff for missing or stale documentation.
    Report only concrete, actionable findings.
  `,
});
```

Agent requirements and conventions:

- `id` and `prompt` are required.
- The `id` is also the registered Render task name. Keep it unique and stable.
- `model` may be `small`, `medium`, `large`, or a literal model identifier.
- `budget.maxIterations` maps to the runner's maximum turns.
- `plan` maps to Render Workflows task metadata.
- `tools` must exactly match names available in the configured registry.
- Use `tools: []` for host-side decisions and reviews that only inspect input.

### 2. Wrap and export it

Update `app/tasks/index.ts`:

```ts
import { docsReviewer } from "../agents/index.js";

export const docsReviewTask = agentTask(docsReviewer);
```

Because `app/tasks/index.ts` is already imported by the workflow entrypoint,
no additional registration import is needed for an agent added there.

### 3. Call it from orchestration

Import the task into the relevant workflow and pass only the agent's input:

```ts
const rawReview = await docsReviewTask({ message: stagedDiff });
const review = isBlobRef(rawReview)
  ? await requireBlob(rawReview)
  : rawReview;
```

Pass `sandboxId: sandbox.id` only when the agent declares `sandbox__*` tools
and a workflow-owned sandbox already exists.

`agentTask()` requires exactly one terminal runner result. It propagates runner
errors, rejects missing or multiple results, and stores results larger than
50,000 characters through the configured `ArtifactStore`. Each invocation is
recorded as a generic child agent run when workflow run context is supplied.

### 4. Test the agent

- Update `app/tests/agents.test.ts` for tool-access boundaries.
- Update `sdk/tests/agent.test.ts` if task/runner wiring changed.
- Add structured-output cases to `app/tests/model-json.test.ts` when relevant.
- Run typecheck and tests.

For an agent that must emit JSON, define a Zod schema in workflow code and use
`parseModelJson`. Treat `null` as a failure and choose a fail-closed fallback;
do not trust model JSON without validation.

## Add an orchestration workflow

Use this path for a new externally dispatchable pipeline or a new composition
of existing agent tasks.

### 1. Create the workflow directory

Create `app/workflows/<workflow-name>/`. Keep task registration and
high-level control flow in `index.ts`; move schemas and domain operations into
focused sibling modules that never import `index.ts`.

```ts
import { task } from "@renderinc/sdk/workflows";
import { inputSchema } from "./contracts.js";

export const issueSummary = task(
  { name: "issue-summary", plan: "standard" },
  async function issueSummary(rawInput: unknown) {
    const input = inputSchema.parse(rawInput);
    // Fetch authoritative state and orchestrate agent tasks here.
    return { status: "done", issueNumber: input.issueNumber };
  },
);
```

Workflow handlers should:

- Accept `unknown` and parse it immediately.
- Return JSON-serializable values.
- Fetch issue bodies, comments, repository state, and other large data inside
  the workflow rather than carrying it through gateway dispatch.
- Resolve possible agent blob refs before using agent output.
- Keep GitHub and Git side effects in workflow-owned code.
- Use `try/finally` around sandbox lifecycle.
- Truncate unbounded model context explicitly.
- Handle malformed structured model output and partial external failures.
- Design repeated execution deliberately; do not assume exactly-once effects.

### 2. Register it

Export the workflow from the central manifest in `app/workflows/index.ts`:

```ts
export { issueSummary } from "./issue-summary/index.js";
```

`app/src/workflows.ts` imports this manifest after the agent task imports.
Exporting a workflow evaluates its `task(...)` definition and registers it.
Keep task names stable. Renaming a registered task also changes its dispatch
address.

### 3. Expose it to a trigger

For GitHub intake, add or extend a handler under `app/gateway/` and dispatch:

```ts
await dispatchWorkflowTask("issue-summary", {
  issueNumber: payload.issue.number,
  runId,
});
```

The string passed to `dispatchWorkflowTask` must exactly match `task({ name })`.
The Render SDK receives:

```text
${RENDER_WORKFLOW_SLUG}/${taskName}
```

with `[payload]` as the task argument list.

Do not weaken the existing HMAC, repository, label, actor, bot, or pull-request
filters when adding GitHub event support. A new public route needs equivalent
authentication, body limits, schema validation, and focused tests.

If a workflow is internal-only, register it but do not add a gateway route.

### 4. Test dispatch and intake

- `app/tests/dispatch.test.ts`: task path and argument shape.
- `app/tests/github.test.ts`: signature, event filters, payload, and statuses.
- `app/tests/server.test.ts`: route mounting and health behavior.
- Add isolated workflow tests by mocking GitHub, sandbox, and agent
  boundaries. `app/tests/spec-to-pr.test.ts` is the reference.

## Existing `spec-to-pr` workflow behavior

`app/workflows/spec-to-pr/index.ts` is the reference orchestration entrypoint;
its sibling modules contain contracts, checkpointing, model stages, sandbox
lifecycle, Git operations, and terminal handling. It parses and re-fetches the
issue, checks the label, runs triage, and then removes the label as
acknowledgment. The RunStore records each stage and event under a logical run
ID, and the issue lease prevents overlapping runs. It reconnects to the same
sandbox and deterministic `factory/` branch on retry.

When `factory.config.ts` defines `verify` commands, the workflow runs them
deterministically in the sandbox after each implementation round. If any
command fails, the output is fed back to the implementer for up to three fix
rounds. The implementer itself does not run verification commands.

The workflow runs analysis, implementation, verification, then performs a lightweight
self-review for obvious issues (debug artifacts, broken imports, missing
exports), applies self-review fixes if needed, fans out three complete-diff
reviews (security, correctness, tests) in parallel, and permits one
implementation/review revision. Workflow-owned code verifies the pushed SHA,
opens a draft PR only after approval, and uses marker-backed idempotent issue
comments. The sandbox terminates after a terminal result.

Issue comments never retrigger work. A maintainer retries by reapplying the
configured label.

## Serialization and size limits

- Gateway request body: 256 KiB (`app/gateway/body.ts`).
- Issue plus comments context: 12,000 characters.
- Complete diff sent to reviewers: at most 200,000 characters; larger and
  binary diffs fail closed.
- Agent task inline result: 50,000 characters; larger values become blob refs.
- Artifact TTL: 7 days, refreshed on explicit read.
- Run-event detail retention: 30 days by default; run summaries: 90 days.
- Most sandbox tool output: 50,000 characters.
- Sandbox file reads through the tool: 100,000 characters.
- Collected sandbox exec output: 1,000,000 characters.

Only resolve a value as a blob when `isBlobRef(value)` returns true. Use
`requireBlob` for trusted task output and let expired or invalid refs fail.
Do not scan arbitrary user text for embedded references.

## Retry and idempotency

- One Postgres transaction atomically deduplicates `x-github-delivery`, creates
  the logical run, and leases the issue.
- Delivery state moves from `pending` to `dispatched` only after Render accepts
  the task; a redelivery recovers a gateway crash from the pending state.
- One execution lock with a 10-second heartbeat prevents duplicate Workflow
  tasks for the same delivery from running concurrently.
- Dispatch failure abandons the claim so GitHub can redeliver.
- The task retries twice with exponential backoff.
- Stage outputs, sandbox identity, commits, reviews, push verification, PR URL,
  and terminal result are checkpointed under the delivery ID.
- Non-deterministic model stages write a started marker first; a process crash
  fails closed rather than silently invoking the model again.
- Branch names are deterministic for one delivery.
- Issue comments carry stable hidden operation IDs.
- Push is verified against the reviewed local SHA.
- Terminal completion releases the issue lease while retaining delivery
  deduplication.

New side effects must join this protocol rather than adding an uncheckpointed
write between stages.

## Extend tools

Custom tools implement `ToolSource` from `sdk/tools.ts`.

1. Define tools with names, descriptions, Zod input shapes, and `invoke`.
2. Give the source a unique `id`; duplicate source IDs throw.
3. Register it in the registry built by `app/src/workflows.ts`.
4. Add the exact tool names to only the agents that need them.
5. Add registry, validation, permission, and failure tests.

Use the `source__tool` naming convention. The production registry contains the
sandbox tool source. Agent declarations still determine the exact per-agent
surface;
unknown tool names fail during task execution.

Do not register Claude built-in filesystem or shell tools for app agents
without an explicit security-model change. Custom sandbox tools are bridged
through the Claude SDK as MCP tools while retaining workflow-owned
`sandboxId`.

## Extend runners and models

A runner implements `run(ctx: RunContext): AsyncIterable<AgentEvent>`. Put
provider implementations under `sdk/runners/` and export public ones from both
barrels. Configure one globally with `configure({ runner })` or pass one to a
specific `agentTask`. Forward cancellation, enforce `interceptToolCall` before
execution, keep unattended permissions fail closed, and emit exactly one
successful `result` or an `error`.

Model tiers are resolved in `sdk/models.ts`. Prefer tier names in app agents so
deployments can change concrete models centrally. If extending model routing,
verify that every field on `ResolvedModel` is consumed by the runner;
`ClaudeRunner` maps `baseUrl` to its minimal subprocess environment.

## Extend sandbox providers

Implement `SandboxProvider` and `Sandbox` from `sdk/sandbox/types.ts`, normally
using `BaseSandbox`; the Render implementation is the reference. Keep provider
API code under `sdk/sandbox/`, preserve streaming exec and cancellation, and bind
`connect(id)` only to the requested workflow-owned sandbox. Register it through
`createSandboxToolSource({ provider })`; orchestration must still own creation
and termination.

## Extend hooks

Hooks implement `Hook` from `sdk/hooks.ts` and are registered with
`configure({ hooks })`. Current hooks: audit logging, cost tracking
(per-agent usage summaries), destructive-action blocking (force push,
recursive delete, secret exfiltration, evasion patterns), and secret
redaction in agent output.

Only `tool_call` is a gating event. Rejecting text, result, or tool-result
events does not veto execution. A runner must call `interceptToolCall` before
the underlying tool runs for a security hook to enforce policy.

Add focused tests in `sdk/tests/hooks.test.ts` and runner tests when changing
hook enforcement.

## Test ownership

Use the closest suite: `app/tests/agents.test.ts` for agent permissions;
`dispatch.test.ts`, `github.test.ts`, and `server.test.ts` for gateway behavior;
the other `app/tests/` files for config, GitHub, model JSON, and Git
credentials. In `sdk/tests/`, use `agent` and `claude-runner` for execution,
`tools` and `hooks` for policy, and `blobs` and `models` for their named
subsystems. Store adapter parity lives under `store/tests/`.

Tests use Vitest. Preserve environment cleanup and mock external SDKs before
importing modules that initialize clients or read configuration.

## Deployment notes

`render.yaml` creates the Docker gateway, Postgres, and a retention cron. It
does not create the Workflows service; create that separately with
`npm run start:workflows`, supply its environment, and use the same Postgres
internal URL for `DATABASE_URL`. The gateway pre-deploy command applies schema
migrations. Run `npm run doctor` before deploying to validate configuration,
GitHub access, Postgres connectivity/schema, and task registration. The
`Dockerfile` starts only the gateway; do not combine both processes into one
service.

## Change checklist

Before finishing:

1. Confirm the change preserves the gateway/workflow/agent trust boundaries.
2. Register every new agent or workflow through the existing imports.
3. Keep task names consistent between definitions, dispatch, and tests.
4. Validate all new external input and keep task values JSON-serializable.
5. Resolve oversized agent outputs and bound model context.
6. Make sandbox cleanup and repeated side effects safe.
7. Update `.env.example`, `render.yaml`, and `README.md` when configuration or
   deployment behavior changes.
8. Run `npm run check`.
9. Run `npm run test:integration` when store behavior changed.
10. Validate the Blueprint when `render.yaml` changes.
