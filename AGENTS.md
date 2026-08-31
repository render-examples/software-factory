# Repository guide for agents

This file applies to the entire repository. If a nested `AGENTS.md` is added
later, the more specific file takes precedence for that subtree.

## What this repository is

`render-factory` is a self-hosted, single-repository software factory built on
Render Web Services, Workflows, Sandboxes, and Key Value.

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
- Docker for the local Redis-compatible Key Value service.
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
npm run dev:redis
npm run dev:gateway
npm run dev:workflows
```

- Redis listens on `localhost:6379`; `.env.example` sets `REDIS_URL` to it.
- The gateway listens on `0.0.0.0:${PORT:-3000}`.
- `GET /health` is liveness; `GET /ready` checks Key Value readiness and is
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
`npm run test:integration` with local Redis running for the opt-in live Key
Value probe.

## Environment contract

Gateway:

- `FACTORY_REPO` (required): exact `owner/repo` the factory may operate on.
- `FACTORY_LABEL` (optional): intake label; defaults to `factory`.
- `FACTORY_GITHUB_ACTORS` (required): comma-separated allowed GitHub logins.
- `GITHUB_WEBHOOK_SECRET` (required for requests): webhook HMAC secret.
- `RENDER_WORKFLOW_SLUG` (required to dispatch): deployed Workflows service
  slug, without the task name.
- `REDIS_URL` (required): delivery deduplication and per-issue leases.
- `SLACK_SIGNING_SECRET` (optional): enables signed Slack intake. Any member
  who can reach the installed app may use the bounded assistant.
- `PORT` (optional): gateway port; defaults to `3000`.

Workflows host:

- `FACTORY_REPO` (required): same fixed repository as the gateway.
- `FACTORY_LABEL` (optional): same intake label as the gateway.
- `ANTHROPIC_API_KEY` (required for Claude-backed agent tasks).
- `GITHUB_TOKEN` (required): fine-grained token scoped to `FACTORY_REPO`.
- `RENDER_API_KEY` (required by the Render SDK).
- `RENDER_WORKSPACE_ID` (required for Sandboxes).
- `REDIS_URL` (required): replay checkpoints and oversized agent artifacts.
- `SLACK_BOT_TOKEN` (required only when Slack intake is enabled): posts replies.
- `GITHUB_API_URL` (optional): GitHub API base URL override.

Keep the GitHub token to the minimum Contents, Issues, and Pull Requests
permissions needed to clone, push, comment, and open a draft PR. Never put a
token in a Git remote URL or agent prompt.

## Repository map

```text
app/
  agents/index.ts          Agent definitions and prompts
  tasks/index.ts           Agent definitions wrapped with agentTask()
  workflows/               Multi-step orchestration workflows
  gateway/                 HTTP intake, validation, and workflow dispatch
  hooks/                   Audit, destructive-action block, secret redaction
  lib/                     GitHub, config, model JSON, and sandbox Git helpers
  tools/                   Bounded Slack-assistant GitHub/Render integrations
  src/server.ts            Gateway process entrypoint
  src/workflows.ts         Workflow process entrypoint and registrations
  tests/                   App, gateway, and integration tests
sdk/
  agent.ts                 Agent(), configure(), and agentTask()
  runner.ts                Provider-neutral AgentRunner interface
  runners/                 Runner implementations
  tools.ts                 Tool, ToolSource, and ToolRegistry
  sandbox.ts               Provider-neutral sandbox interfaces
  sandbox/                 Sandbox provider implementations
  sandbox-tool-source.ts   sandbox__* tools exposed to agents
  hooks.ts                 Agent event interception
  models.ts                Model tier resolution
  blobs.ts, redis.ts       Oversized result handoff
  tests/                   SDK unit tests
render.yaml                Gateway + Key Value Blueprint
Dockerfile                 Gateway image only
docker-compose.yml         Local Redis
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
- Add or update tests with behavior changes. Do not call live Render, GitHub,
  Redis, or model APIs from unit tests.

## Core invariants

Preserve these boundaries unless the requested change explicitly redesigns
the security model:

- One deployment is bound to one validated `FACTORY_REPO`.
- Only an `issues.labeled` event from an allowed human actor starts factory
  implementation; Slack can draft an unlabeled issue but cannot start work.
- The webhook signature is checked before JSON parsing or dispatch.
- Pull request conversations, bots, wrong repositories, wrong labels, and
  unsupported events are skipped.
- The gateway dispatches the minimum identifier:
  `{ issueNumber, attemptId }`, where `attemptId` is GitHub's delivery ID.
- Agents receive only explicitly registered tools.
- Analysis uses read-only sandbox tools; only implementation receives sandbox
  write and exec tools.
- Do not give app agents Claude's built-in `Bash`, `Read`, `Write`, or `Edit`;
  those bypass the workflow-owned sandbox binding.
- `sandboxId` is supplied by workflow code through `AgentTaskInput`; it is not
  model-selected or accepted from public input.
- Git pushes, labels, sandbox lifecycle, and pull request creation stay in
  orchestration code. The sole model-callable GitHub write creates an
  unlabeled issue in `FACTORY_REPO`.
- Slack is disabled unless its signing secret is present. The signing secret
  authenticates Slack rather than an individual user; the assistant therefore
  has no deploy, environment-value, label, merge, or workflow-dispatch tool.
- Preserve a sandbox across automatic task retries; terminate it in `finally`
  only after a terminal workflow result or final failed attempt.
- Automation stops at a draft PR. It does not mark ready or merge.
- Render filesystems are ephemeral. Use Key Value or another durable service
  for cross-step data, never local disk on a deployed service.

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
50,000 characters in Key Value.

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

### 1. Create the workflow module

Create `app/workflows/<workflow-name>.ts`:

```ts
import { task } from "@renderinc/sdk/workflows";
import { z } from "zod";

const inputSchema = z.object({
  issueNumber: z.number().int().positive(),
  attemptId: z.string(),
});

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

Add a side-effect import to `app/src/workflows.ts`:

```ts
import "../workflows/issue-summary.js";
```

Keep task names stable. Renaming a registered task also changes its dispatch
address.

### 3. Expose it to a trigger

For GitHub intake, add or extend a handler under `app/gateway/` and dispatch:

```ts
await dispatchWorkflowTask("issue-summary", {
  issueNumber: payload.issue.number,
  attemptId: deliveryId,
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

`app/workflows/spec-to-pr.ts` is the reference implementation. It parses and
re-fetches the issue, checks the label, runs triage, and then removes the label
as acknowledgment. Redis checkpoints each stage under the GitHub delivery ID,
and the issue lease prevents overlapping attempts. It reconnects to the same
sandbox and deterministic `factory/` branch on retry, runs analysis and
implementation, commits, fans out three complete-diff reviews, and permits one
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
- Blob and run-checkpoint TTL: 7 days, refreshed on read.
- Most sandbox tool output: 50,000 characters.
- Sandbox file reads through the tool: 100,000 characters.
- Collected sandbox exec output: 1,000,000 characters.

Only resolve a value as a blob when `isBlobRef(value)` returns true. Use
`requireBlob` for trusted task output and let expired or invalid refs fail.
Do not scan arbitrary user text for embedded references.

## Retry and idempotency

- A Lua claim atomically deduplicates `x-github-delivery` and leases the issue.
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
sandbox source plus bounded Slack-assistant GitHub and read-only Render
sources. Agent declarations still determine the exact per-agent surface;
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

Implement `SandboxProvider` and `Sandbox` from `sdk/sandbox.ts`, normally using
`BaseSandbox`; the Render implementation is the reference. Keep provider API
code under `sdk/sandbox/`, preserve streaming exec and cancellation, and bind
`connect(id)` only to the requested workflow-owned sandbox. Register it through
`createSandboxToolSource({ provider })`; orchestration must still own creation
and termination.

## Extend hooks

Hooks implement `Hook` from `sdk/hooks.ts` and are registered with
`configure({ hooks })`. Current hooks audit events, block destructive tool
calls, and redact likely secrets.

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
`tools` and `hooks` for policy, and `blobs`, `redis`, and `models` for their
named subsystems.

Tests use Vitest. Preserve environment cleanup and mock external SDKs before
importing modules that initialize clients or read configuration.

## Deployment notes

`render.yaml` creates the Docker gateway and an internal-only, `noeviction` Key
Value instance. It does not create the Workflows service; create that
separately with `npm run start:workflows`, supply its environment, and use the
Key Value internal URL for `REDIS_URL`. Run `npm run doctor` before deploying
to validate configuration, GitHub access, and Key Value connectivity. The
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
9. Run `npm run test:integration` when Redis behavior changed.
10. Validate the Blueprint when `render.yaml` changes.
