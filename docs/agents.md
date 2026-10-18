# Agents, phases, and evals

This page is for changing what the factory does: editing an agent, adding one, adding a phase, and checking agent behavior with evals. [architecture.md](architecture.md) explains how the pieces fit together.

## What an agent is

An agent is two files in `app/agents/`: a markdown prompt and a few typed lines.

```text
app/agents/
  implementer.md
  implementer.ts
```

```ts
export const implementerVars = ["repo", "verifyCommands"] as const;

export const implementer = defineAgent({
	id: "implementer",
	prompt: "implementer.md",
	model: "large",
	tools: ["read", "ls", "bash", "edit", "write"],
	output: Implementation,
	maxTurns: 150,
});
```

| Field | Meaning |
|---|---|
| `id` | Unique name, used in events and the trace UI. The prompt file is conventionally `<id>.md` |
| `prompt` | The prompt's file name, relative to `app/agents/`. Read once, verbatim: no frontmatter, no parsing |
| `model` | A tier, `small`, `medium`, or `large`, resolved through `models` in `factory.config.ts` |
| `tools` | Any of `read`, `ls`, `bash`, `edit`, `write`. Empty means the agent runs in the Workflows task; any tool means it runs in a sandbox |
| `output` | A Zod object schema, usually from `app/contracts/`. It becomes the JSON Schema of the agent's `submit` tool |
| `maxTurns` | The most model calls the agent may make |
| `thinking` | Optional reasoning level: `off`, `minimal`, `low`, `medium` (the default), or `high` |

`defineAgent` (`app/agents/define.ts`) reads the prompt and converts the output schema when the module loads, so a missing prompt or an unusable schema fails at startup, not mid-run.

### Prompts and placeholders

The prompt is the agent's system prompt. `{{name}}` placeholders are filled from the `vars` passed to `runAgent`; a placeholder without a value throws before anything runs. Each agent module exports the names it uses (`implementerVars`, `triageVars`, and so on), and a test checks that they match the prompt exactly.

The task itself goes in the call's `message`, not the prompt. Prompts follow a few rules the catalog test enforces:

- Ask the model to call `submit` exactly once. Don't ask for JSON-only replies: the `submit` tool carries the output.
- Agents with tools work in the sandbox's checkout, so refer to "the working directory", never a hardcoded path.

Prompts travel to the runner in its input, so changing one takes a redeploy of `factory-workflows`, not a snapshot rebuild.

### Tools

| Tool | What it does |
|---|---|
| `read` | Reads a file in the checkout |
| `ls` | Lists a directory |
| `bash` | Runs a shell command as the `factory` user, from the checkout, with a minimal environment |
| `edit` | Replaces text in a file |
| `write` | Writes a file |

An agent without `edit` or `write` also gets a read-only shell policy that rejects obviously mutating or networked commands, so it doesn't waste turns. That policy is a guard, not a boundary; the sandbox is the boundary. Only the implementer has write tools today.

### Output

The model ends its run by calling `submit` with an object matching the output schema. The runner checks the submission against the JSON Schema and lets the model fix a rejected one; then `runAgent` parses it again with the Zod schema, which is authoritative. Keep schemas strict and bounded (`max()` on strings and arrays): their output ends up in GitHub comments.

## Running an agent

`runAgent(agent, input, options)` (`app/agents/run.ts`) runs an agent where you call it:

```ts
// In the sandbox you pass: the tools act on its checkout.
const call = (budgetUsd: number) =>
	runAgent(implementer, { message, vars }, { sandbox, traceId: run.traceId, runId: run.runId, repo: repo.fullName, subject, budgetUsd });
const { output } = await run.budget.track(call);

// No tools, no sandbox: runs in the Workflows task.
const review = await run.budget.track((budgetUsd) => runAgent(synthesizer, { message, vars: { repo } }, { traceId, budgetUsd }));
```

- An agent with tools needs `sandbox`, and an agent without tools can't take one. Both are type errors, and both are checked at runtime: tools never run in a Workflows task, which holds the factory's secrets.
- `runAgent` is a function, not a task. Call it inline, or wrap it in its own `task()` if you want a separate retry, timeout, and Dashboard entry for it.
- It returns `{ output, usage, costUsd, turns }` and emits `agent.started` and `agent.finished` events.
- Every failure throws an `AgentError` with a `code` (`timeout`, `max_turns`, `budget_exceeded`, `output_invalid`, and others) and the usage up to that point.
- **Budget is passed down, not looked up.** `run.budget.track(call)` gives the call what the run has left and adds what it spent, failed calls included. For calls in parallel, pass `{ shareOf: n }` so each gets an equal share, as PR Reviewer does for its specialists.
- The default timeout is 30 minutes; pass `timeoutMs` to change it.

## Adding or changing an agent

1. Write `app/agents/<id>.md` and `app/agents/<id>.ts` with `defineAgent`, and export the agent and its `<id>Vars` from `app/agents/index.ts`.
2. If it needs a new output shape, add a Zod schema to `app/contracts/` and export it from `app/contracts/index.ts`.
3. Call it from a phase with `runAgent`, passing a sandbox only if it has tools.
4. Add it to the catalog in `tests/agents-catalog.test.ts`, with its vars, model, tools, turn limit, and a sample output. The catalog pins every agent's model and tools, so widening an agent's tools or changing its model is always a deliberate diff in that test, and it checks that only the implementer can write and only the synthesizer runs without a sandbox. Update those assertions only on purpose.
5. Run `npm run check`.

Changes to the runner itself (`app/runner/`) or to `sandbox-runtime/` are different: they're baked into each repository's snapshot. They reach sandboxes when the snapshot is rebuilt, on the next push to each base branch. To rebuild sooner, start `refresh-snapshot` with `{ "repo": "owner/name", "installationId": <id>, "sha": "<base branch head>" }`.

## Adding a phase

A phase is one Workflows task that wraps its work in `withPhase`.

1. **Name it.** Add the task name to `TASKS` in `app/config/index.ts`, and to the `Phase` type and its title in `app/phases/status.ts`.
2. **Define its input.** Add a Zod schema to `app/contracts/tasks.ts` that extends `RepoInput`, and register it in `INPUTS` in `app/gateway/index.ts`.
3. **Write the task** in `app/workflows/<name>/index.ts`, with the steps in sibling files:

   ```ts
   export async function runMyPhase(ctx: Pick<TaskContext, "metadata">, raw: unknown, deps: MyPhaseDeps = {}): Promise<PhaseOutcome> {
   	const input = MyPhaseInput.parse(raw);
   	const repo = requireRepo(input.repo, input.installationId);
   	const subject = { kind: "issue", number: input.issue } as const;
   	return withPhase(ctx, { repo, subject, phase: TASKS.myPhase, actor: input.actor, gh: deps.gh, runs: deps.runs }, async (run) => {
   		const sandbox = await openSandbox(repo, { kind: "branch", name: repo.config.baseBranch });
   		try {
   			await run.progress("doing the work");
   			const { output } = await run.budget.track((budgetUsd) => runAgent(myAgent, { message }, { sandbox, traceId: run.traceId, budgetUsd }));
   			// Write to GitHub through the format helpers, with a marker, after looking for an existing one.
   			return { outcome: "done", summary: "did the work.", links: [] };
   		} finally {
   			await sandbox.close().catch(() => {});
   		}
   	});
   }

   export const myPhase = task(
   	{ name: TASKS.myPhase, timeoutSeconds: 3600, retry: { maxRetries: 0, waitDurationMs: 5_000, backoffScaling: 1 } },
   	(ctx, raw: unknown) => runMyPhase(ctx, raw),
   );
   ```

   `withPhase` handles the permission check, latest-wins takeover, the status comment, the budget, and the events. Throw `PhaseError` for an expected failure whose message is safe to show on GitHub; anything else fails the task with a generic message. Take GitHub, sandboxes, and `runAgent` as injectable dependencies so tests can fake them.
4. **Register it** by exporting it from `app/workflows/index.ts`. `app/src/workflows.ts` imports that module, which registers every task with the SDK. `npm run doctor` checks that every name in `TASKS` is registered.
5. **Route to it** in `route()` (`app/gateway/routes.ts`) and test the route in `tests/routes.test.ts`. If it needs a new label, add it to `labels` in `factory.config.ts` and to `LABELS` in `scripts/lib/requirements.ts`. If it needs a new webhook event, add it to `REQUIRED_EVENTS` there too, so `setup:app` subscribes to it and `doctor` checks for it.
6. **Budget and time.** The run's budget is `limits.perRunUsd`. Set `timeoutSeconds` for the longest the phase can take, and keep `sandbox.timeoutSeconds` at least that long.
7. Add tests next to the existing ones (`tests/<name>.test.ts`) using the fakes in `tests/helpers/`, and run `npm run check`.

## Evals

Evals check agent behavior against real models. Today they cover Triage: each case replays an issue through the real triage agent and, when it decides to draft, the spec writer, in a sandbox restored from the target repository's snapshot (`scripts/eval/`).

A case is one JSON file in `evals/cases/`, named after its `id`:

```json
{
	"id": "underspecified-search",
	"description": "A vague request ('search') gets a few clarifying questions, not a spec.",
	"phase": "triage",
	"issue": { "title": "Search", "body": "It would be nice to be able to search.", "labels": ["factory:triage"] },
	"expect": { "decision": "ask", "questionsMax": 3, "maxCostUsd": 2 }
}
```

| `expect` key | Passes when |
|---|---|
| `decision` | Triage decides `ask`, `draft`, or `decline` |
| `questionsMax` | Triage asks at most this many questions |
| `specMustMention` | The rendered spec contains each term (case-insensitive). Implies a draft |
| `mustNotContain` | No agent output or rendered spec contains any of these strings (case-insensitive). The `injection-*` cases use this to catch leaked secrets and obeyed injections |
| `maxCostUsd` | The case spent at most this much |

`comments` (oldest first) replays a conversation; mark a comment `"bot": true` to make it come from another App, which Triage leaves out of the thread.

`npm run eval -- --validate` checks every case file against the schema without calling anything, and CI runs it. A live run (`npm run eval -- --installation <id>`) needs the Workflows service's environment and costs real money; [getting-started.md](getting-started.md#evals) shows the options. With `DATABASE_URL` set, a live run records its `eval.*` events and every agent's events under one trace, which you can open in the trace UI.
