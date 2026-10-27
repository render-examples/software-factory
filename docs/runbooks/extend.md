# Extension runbook

Use this runbook when adding an agent, an agent harness, a Render Workflows
task, or a GitHub trigger. It is written for coding agents working in a fork of
software-factory.

Read [Architecture](../architecture.md) first. Do not change the authority
boundary as part of an extension: agents propose typed values or file changes;
code in the Workflows service selects targets, validates results, and writes
to GitHub.

## Before editing

Inspect:

- `factory.config.ts`;
- `app/agents/`;
- `app/harness/`;
- `app/workflows/`;
- `app/schemas/`;
- `app/gateway/routes.ts`;
- `app/config/index.ts`;
- `scripts/lib/requirements.ts`; and
- the closest existing test.

Run `npm run check` before changing code. Record any existing failure and
preserve unrelated work.

Decide which change you need:

- **Agent only:** a new prompt, tool set, and typed result used by an existing
  task.
- **Agent harness:** another agent library or model client behind the runner
  contract.
- **Claiming task:** work attached to one issue or pull request that must stop
  when another run takes over.
- **Plain task:** maintenance work without an issue or pull request claim,
  such as snapshot refresh.
- **GitHub trigger:** a new authenticated event, label, or command that starts
  a task.

Do not add a task when an existing task can call the new agent and own the
result.

## Add an agent

### 1. Define the output

Add or reuse a schema in `app/schemas/`. Build every output object with
`z.strictObject`:

```typescript
export const Finding = z.strictObject({
  summary: z.string().min(1).max(4000),
  paths: z.array(z.string().min(1)).max(100),
});

export type Finding = z.infer<typeof Finding>;
```

Bound strings and arrays. The model sees this schema through the `submit`
tool, and the Workflows host validates the result again.

Export the schema from `app/schemas/index.ts`.

### 2. Add the prompt and definition

Create:

```text
app/agents/<agent-id>/
  index.ts
  prompt.md
```

Define the agent:

```typescript
import { medium } from "../models.js";

export const finder = defineAgent({
  id: "finder",
  prompt: "finder/prompt.md",
  harness: medium,
  tools: ["read", "ls", "bash"],
  output: Finding,
  maxTurns: 40,
});
```

The definition fixes the agent's authority:

- `id` must be unique and stable;
- `prompt` is relative to `app/agents/`;
- `harness` is a value from `app/agents/models.ts` or one built with an
  adapter from `app/harness/`;
- `tools` may include `read`, `ls`, `bash`, `edit`, and `write`;
- `output` is a bounded strict Zod object; and
- `maxTurns` is a positive model-call limit.

Grant `edit` or `write` only when the agent must change the checkout.
The read-only shell policy in `app/runner/tools/shell-policy.ts` guides
read-only agents; it is not a security boundary.

The prompt should explain the job, evidence requirements, limits, and when to
call `submit`. Put repository-, issue-, and run-specific data in the message
passed to `runAgent`, not in the prompt.

Export the agent from `app/agents/index.ts` and add it to `AGENTS` in
`app/agents/registry.ts`. The Sandbox runner is bundled from that list and
runs only the agents in it. Agent modules are bundled into the runner, so they
must not import host-only code.

### 3. Call the agent

Call the agent inside a Sandbox owned by the task:

```typescript
const result = await runAgent(finder, message, claim.agentRunOptions(sandbox));
```

Use the typed `result.output`. Do not parse assistant text or accept a target
chosen by the model.

### 4. Test the authority

Add the agent to `tests/agents-catalog.test.ts`. Update the expected writer
list only if write tools are intentional.

Add task-level tests for the user-visible result and meaningful failures. Use
fakes; tests must not call GitHub, Render, or a model provider.

## Add an agent harness

A harness puts an agent library behind the runner contract in
[`app/runner/core/`](../../app/runner/core/). The runner calls it inside the
Sandbox with a validated input and the key from stdin; the host reads only what
it declares.

1. Add an adapter in `app/harness/<name>.ts` that takes the library's own
   configuration and returns a `Harness` (`app/harness/types.ts`):
   - `name` and `label` name the library and model before a run;
   - `credential` is the env var on the Workflows service that holds its key;
     the host sends its value into the Sandbox; and
   - `run` and `selfTest` are the runtime (`app/runner/core/harness.ts`),
     which the runner calls inside the Sandbox.
2. Give the model only the factory's tools, through `createFactoryTools`
   (`app/runner/tools/`), and a `submit` tool checked by `Submission`
   (`app/runner/core/submit.ts`). Never offer the library's own shell, file,
   network, or subagent tools: their authority isn't the factory's.
3. Emit `started`, then exactly one `result` or `error`, and stop at
   `max_turns` and `timeout_ms`.
4. Honor `testScript` (set by `--test-stub`) by playing its turns instead of
   calling a model, if the library has a fake model; then add the harness to
   `HARNESSES` in `tests/helpers/runner.ts` so it runs the conformance suite.
5. Export the adapter from `app/harness/index.ts` and use it in an agent
   definition or `app/agents/models.ts`.

`tests/agents-catalog.test.ts` fails if the bundle imports host-only code.

## Add a GitHub task

Use `defineGitHubTask()` for work attached to one issue or pull request. It
keeps run ownership, permission checks, status updates, and cancellation out
of the task body.

### 1. Define the task contract

1. Add a name to `TASKS` in `app/config/index.ts`.
2. Add a bounded input schema to `app/schemas/tasks.ts`.
3. Export the schema from `app/schemas/index.ts`.

Task input must carry trusted routing data from the authenticated webhook:
repository, installation, actor, subject number, and any commit SHA the task
must pin. Do not accept these values from agent output.

### 2. Declare the task

Create `app/workflows/<task-name>/index.ts`:

```typescript
export const exampleWorkflow = defineGitHubTask(
  {
    name: TASKS.example,
    title: "Example",
    input: ExampleInput,
    subject: (input) => ({ kind: "issue", number: input.issue }),
    timeoutSeconds: 3600,
  },
  async (claim, input, deps): Promise<Outcome> => {
    // Code in the Workflows service owns all external writes.
    return { outcome: "completed", summary: "completed the example task." };
  },
);

export const runExample = exampleWorkflow.run;
```

`defineGitHubTask()` returns two explicit entry points:

- `exampleWorkflow.task` is the registered Render task definition. Pass it to
  `ctx.run()` from a parent workflow.
- `exampleWorkflow.run` calls the same body in-process with injectable
  dependencies for tests.

GitHub tasks do not retry automatically. A retry can repeat model spend or
durable writes; a person starts a fresh run instead.

### 3. Use the claim correctly

- Call `claim.reportProgress()` before a major step.
- Open Sandboxes only through `withSandbox`.
- Call `claim.trackSandbox(sandbox)` immediately after opening one.
- Pass `claim.agentRunOptions(sandbox)` to `runAgent`.
- Call `claim.assertCurrent()` before a durable effect that is not already
  guarded by the claim helper.
- Throw `ExpectedFailure` only for an expected message safe to show on
  GitHub.
- Return a short snake_case `outcome`, user-facing `summary`, and relevant
  links.

Only code in the Workflows service may call GitHub write methods. Format model
text through `app/format/` before publishing it.

### 4. Register the task

Import the task module from `app/workflows/index.ts`. Render registers tasks
when the module loads.

Keep task inputs and results small and JSON-serializable.

## Compose tasks

Use a GitHub-task parent to run registered child tasks in order:

```typescript
export const pipeline = defineGitHubTask(
  {
    name: "pipeline",
    title: "Pipeline",
    input: PipelineInput,
    subject: input => ({ kind: "issue", number: input.issue }),
    timeoutSeconds: 3600,
  },
  async (_claim, input, _deps, ctx) => {
    if (!ctx.run) throw new Error("pipeline requires a Workflows context");
    const first = await ctx.run(firstWorkflow.task, input);
    if (first.state !== "done" || !first.data) {
      return { state: "failed", outcome: "stopped", summary: first.summary };
    }
    const second = await ctx.run(secondWorkflow.task, first.data);
    return { outcome: "completed", summary: second.summary };
  },
);
```

Each `ctx.run()` starts a child task on separate compute and waits for its
typed result. The parent owns the subject's root claim; its children continue
that claim, update the current stage and Sandbox, and run their own permission
checks.

Keep parent retries disabled. Retrying a parent can create new child runs and
repeat model spend. Return immediately after a child is cancelled, rejected,
or fails.

[`app/workflows/autopilot/index.ts`](../../app/workflows/autopilot/index.ts)
is the complete example.

## Add a plain Workflows task

Use the Render SDK's `task()` directly only when the work has no issue or pull
request claim. `app/workflows/refresh-snapshot.ts` is the reference.

A plain task must still:

- validate raw input at entry with Zod;
- resolve repositories through trusted configuration;
- set an explicit timeout and intentional retry policy;
- bound external work;
- return a small JSON-serializable result; and
- clean up every Sandbox it creates.

Do not use a plain task to bypass permission checks or status-comment
ownership for issue or pull request work.

## Add a GitHub trigger

The gateway route is a pure mapping from an authenticated delivery to a
validated task input.

1. Add the task name and input schema first.
2. Update `route()` in `app/gateway/routes.ts`.
3. Derive repository, installation, actor, issue or pull request, and commit
   from the authenticated payload.
4. Use the GitHub delivery ID as the task idempotency key. For content-addressed
   maintenance work, use a deterministic key such as `repo@sha`.
5. Update `REQUIRED_EVENTS`, `REQUIRED_PERMISSIONS`, or `LABELS` in
   `scripts/lib/requirements.ts`.
6. Add route tests for the start case, ignored cases, and invalid input.
7. Rerun `npm run setup:github` after deployment.

Never put GitHub credentials or model calls in `app/gateway/`. The gateway
authenticates and routes; it does not perform the task.

Every GitHub write must create, update, or reuse an App-authored artifact
marker. Workflows idempotency alone expires and cannot protect a permanent
GitHub effect.

## Verify

Run:

```bash
npm run check
```

Use the additional checks in
[Contributing](../../CONTRIBUTING.md#verify-changes) when relevant.

Before handing off, confirm:

- all external and cross-process inputs are validated;
- the new agent has the minimum tools it needs;
- model output cannot select an external write target;
- the gateway still imports no GitHub auth, Sandbox, agent, or workflow code;
- the runner bundle (`app/runner/`, `app/harness/`, agent definitions, and
  schemas) still imports no host-only code;
- GitHub tasks record their Sandbox before running an agent;
- tests cover the user-visible success and important failures; and
- documentation and setup requirements changed when the App contract changed.

## Deploy the extension

- Prompt, agent, schema, or Workflows changes require a Workflows deploy.
- Gateway route changes require a gateway deploy.
- App permission, event, or label changes require `npm run setup:github`.
- A new secret, such as another provider key, goes in `ENV_GROUPS` in
  `scripts/lib/requirements.ts`. Add it to `.env`, rerun
  `npm run setup:render`, and redeploy the services that link its group. See
  [Environment groups](../configuration.md#environment-groups).
- A harness whose key is new needs the key in `.env`, `npm run setup:render`,
  and a Workflows deploy. Setup and `doctor` derive the key list from the
  agents' harnesses.
- Changes under `app/runner/`, `app/harness/`, or agent definitions reach
  Sandboxes with the Workflows deploy: each Sandbox gets the new runner bundle
  when it opens. Changes under `sandbox/` also require a snapshot refresh for
  every configured repository.

State the required deploy and refresh actions in the handoff.
