import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { config, modelFor } from "../config/index.js";
import { emit } from "../events/index.js";
import { providerApiKey } from "../runner/keys.js";
import { type RunnerErrorCode, RunnerEvent, RunnerInput, type ToolName, type Usage } from "../runner/protocol.js";
import { createEmitter, errorMessage, runSession } from "../runner/session.js";
import { outputSchemaProblem } from "../runner/submit.js";
import type { TestStub } from "../runner/test-stub.js";
import { APP_DIR, REPO_DIR, SCRATCH_DIR, type Sandbox } from "../sandbox/types.js";
import type { Agent, OutputSchema } from "./define.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Extra time the host gives run-agent.sh beyond the runner's own timeout, to flush events and exit. */
const EXEC_GRACE_MS = 60_000;

export type AgentErrorCode = RunnerErrorCode | "output_invalid" | "runner_lost";

/** Safe, redacted runner observations retained for evals and diagnostics. */
export interface AgentTrace {
	toolCalls: Array<{ tool: string; args: unknown }>;
	toolResults: Array<{ tool: string; isError: boolean; outputPreview: string }>;
	assistantText: string[];
}

export class AgentError extends Error {
	override readonly name = "AgentError";
	constructor(
		readonly code: AgentErrorCode,
		message: string,
		/** Usage up to the failure; the workflow still subtracts it from the budget. */
		readonly usage: Usage,
		readonly costUsd: number,
		readonly turns: number,
		readonly trace?: AgentTrace,
	) {
		super(message);
	}
}

export interface RunAgentInput {
	/** The task for this run. */
	message: string;
	/** Fills `{{name}}` placeholders in the agent's prompt. */
	vars?: Record<string, string>;
}

export interface BaseRunOptions {
	/** Root task run of the stage; every event this run emits carries it. */
	traceId: string;
	runId?: string;
	repo?: string;
	subject?: string;
	/** Soft dollar threshold for this call (default: `limits.perRunUsd`). Reported usage can cross it. */
	budgetUsd?: number;
	/** Default 30 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** An agent with tools must run in a sandbox (tools never run in a Workflows task); one without tools can't take one. */
export type RunAgentOptions<Tools extends readonly ToolName[]> = Tools extends readonly []
	? BaseRunOptions & { sandbox?: never }
	: BaseRunOptions & { sandbox: Sandbox };

export interface AgentRun<Output extends OutputSchema> {
	output: z.infer<Output>;
	usage: Usage;
	costUsd: number;
	turns: number;
	/** Present for real runner calls; optional so lightweight test doubles remain valid. */
	trace?: AgentTrace;
}

/** Test seam: when set, in-task runs use these deterministic responses instead of calling a model. */
export const testing: { testStub?: TestStub } = {};

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Replaces every `{{name}}` with `vars[name]` in one pass; an unknown name throws. */
export function renderPrompt(prompt: string, vars: Record<string, string> = {}): string {
	return prompt.replace(PLACEHOLDER, (_match, name: string) => {
		if (!Object.hasOwn(vars, name)) throw new Error(`prompt placeholder {{${name}}} has no value in vars`);
		return vars[name] as string;
	});
}

/**
 * Runs `agent` where it is called: in this process with no tools, or with tools in `opts.sandbox`. Returns the
 * submission parsed by the agent's Zod schema; every failure throws an AgentError that carries the usage so far.
 */
export async function runAgent<Tools extends readonly ToolName[], Output extends OutputSchema>(
	agent: Agent<Tools, Output>,
	input: RunAgentInput,
	opts: RunAgentOptions<Tools>,
): Promise<AgentRun<Output>> {
	const { sandbox, ...base } = opts as BaseRunOptions & { sandbox?: Sandbox };
	const { provider, model } = modelFor(agent.model);
	const timeoutMs = base.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const budgetUsd = base.budgetUsd ?? config.limits.perRunUsd;
	const record = (type: string, payload: Record<string, unknown>) => {
		try {
			void emit({ traceId: base.traceId, runId: base.runId, repo: base.repo, subject: base.subject, type, payload }).catch(() => {});
		} catch {
			// Events never affect a run.
		}
	};
	const finish = (outcome: string, summary: Summary, message?: string) =>
		record("agent.finished", {
			agentId: agent.id,
			model: `${provider}/${model}`,
			outcome,
			turns: summary.turns,
			usage: summary.usage,
			costUsd: summary.costUsd,
			...(summary.invalidLines ? { invalidLines: summary.invalidLines } : {}),
			...(message ? { message } : {}),
		});

	record("agent.started", { agentId: agent.id, model: `${provider}/${model}`, tools: agent.tools, where: sandbox ? "sandbox" : "task", budgetUsd });
	let summary = emptySummary();
	try {
		if (agent.tools.length > 0 && !sandbox) throw failure("invalid_input", `agent ${agent.id} has tools and needs a sandbox`, summary);
		if (agent.tools.length === 0 && sandbox) throw failure("invalid_input", `agent ${agent.id} has no tools and runs in the task, not a sandbox`, summary);
		if (!(budgetUsd > 0)) throw failure("budget_exceeded", `no budget left ($${budgetUsd})`, summary);

		let systemPrompt: string;
		try {
			systemPrompt = renderPrompt(agent.prompt, input.vars);
		} catch (err) {
			throw failure("invalid_input", `agent ${agent.id}: ${errorMessage(err)}`, summary);
		}
		const runnerInput = checkInput(
			{
				trace_id: base.traceId,
				agent_id: agent.id,
				system_prompt: systemPrompt,
				message: input.message,
				model_provider: provider,
				model,
				thinking_level: agent.thinking ?? "medium",
				tools: [...agent.tools],
				output_schema: agent.outputJsonSchema,
				max_turns: agent.maxTurns,
				timeout_ms: timeoutMs,
				budget_usd: budgetUsd,
				...(sandbox ? { cwd: REPO_DIR, scratch_dir: SCRATCH_DIR } : {}),
			},
			summary,
		);
		const testStub = sandbox ? undefined : testing.testStub;
		const apiKey = providerApiKey(provider, process.env);
		if (!apiKey && !testStub) throw failure("agent_error", `no API key for provider "${provider}" in the environment`, summary);

		const stdout = sandbox
			? await runInSandbox(sandbox, runnerInput, apiKey as string, timeoutMs, base.signal)
			: await runInTask(runnerInput, apiKey, testStub, base.signal);
		summary = summarize(stdout.text);
		const end = summary.terminal;
		if (!end) {
			throw failure("runner_lost", `the runner ended without a result or error event${stdout.detail ? ` (${stdout.detail})` : ""}`, summary);
		}
		if (end.type === "error") throw failure(end.code, end.message, summary);
		const parsed = agent.output.safeParse(end.output);
		if (!parsed.success) {
			const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
			throw failure("output_invalid", `agent ${agent.id} submitted output its schema rejects: ${issues}`, summary);
		}
		finish("ok", summary);
		return { output: parsed.data, usage: summary.usage, costUsd: summary.costUsd, turns: summary.turns, trace: summary.trace };
	} catch (err) {
		const error = err instanceof AgentError ? err : failure("agent_error", errorMessage(err), summary);
		finish(error.code, summary, error.message);
		throw error;
	}
}

function failure(code: AgentErrorCode, message: string, summary: Summary): AgentError {
	return new AgentError(code, message, summary.usage, summary.costUsd, summary.turns, summary.trace);
}

function checkInput(raw: RunnerInput, summary: Summary): RunnerInput {
	const parsed = RunnerInput.safeParse(raw);
	if (!parsed.success) {
		throw failure("invalid_input", `invalid RunnerInput: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, summary);
	}
	const problem = outputSchemaProblem(parsed.data.output_schema);
	if (problem) throw failure("invalid_input", problem, summary);
	return parsed.data;
}

interface RunnerOutput {
	/** The runner's stdout: RunnerEvent JSONL. */
	text: string;
	/** What went wrong around the runner, for a runner_lost message. */
	detail?: string;
}

/** In a Workflows task: the same session, in this process, with no tools. */
async function runInTask(input: RunnerInput, apiKey: string | undefined, testStub: TestStub | undefined, signal?: AbortSignal): Promise<RunnerOutput> {
	let text = "";
	const emitter = createEmitter(async (chunk) => {
		text += chunk;
	});
	if (apiKey) emitter.redact(apiKey);
	try {
		await runSession({ input, emit: emitter, apiKey, testStub, signal });
	} catch (err) {
		if (!emitter.terminated) emitter({ type: "error", code: "agent_error", message: errorMessage(err) });
	}
	await emitter.flush();
	return { text };
}

/**
 * In a sandbox. Contract with `${APP_DIR}/run-agent.sh <runDir> <timeoutSeconds>`: as root, it reads and deletes
 * `<runDir>/key` before handing `<runDir>` to the unprivileged user, then runs the runner as that user from
 * REPO_DIR with `--key-stdin`, feeding the key as the first line of stdin followed by `<runDir>/input.json`. It
 * writes stdout to `<runDir>.jsonl` and the exit status to `<runDir>.exit`. `<runDir>` must be root-only (mode
 * 700) when the key is uploaded, so the runner user can't reach the key file before it's deleted.
 */
async function runInSandbox(sandbox: Sandbox, input: RunnerInput, apiKey: string, timeoutMs: number, signal?: AbortSignal): Promise<RunnerOutput> {
	const runDir = `/tmp/agent-${randomUUID()}`;
	const mkdir = await sandbox.exec(`mkdir -m 700 ${runDir}`, { signal });
	if (mkdir.exitCode !== 0) return { text: "", detail: `mkdir ${runDir} exited ${mkdir.exitCode}: ${tail(mkdir.stderr)}` };
	try {
		await sandbox.upload(`${runDir}/input.json`, JSON.stringify(input));
		await sandbox.upload(`${runDir}/key`, apiKey);
		const details: string[] = [];
		try {
			const res = await sandbox.exec(`bash ${APP_DIR}/run-agent.sh ${runDir} ${Math.ceil(timeoutMs / 1000)}`, {
				timeoutMs: timeoutMs + EXEC_GRACE_MS,
				signal,
			});
			if (res.exitCode !== 0) details.push(`run-agent.sh exited ${res.exitCode}: ${tail(res.stderr)}`);
		} catch (err) {
			if (signal?.aborted) throw err;
			details.push(`run-agent.sh failed: ${errorMessage(err)}`);
		}
		let text = "";
		try {
			text = (await sandbox.download(`${runDir}.jsonl`, signal)).toString("utf8");
		} catch (err) {
			if (signal?.aborted) throw err;
			details.push(`cannot download ${runDir}.jsonl: ${errorMessage(err)}`);
		}
		return { text, detail: details.join("; ") || undefined };
	} finally {
		await sandbox.exec(`rm -rf ${runDir} ${runDir}.jsonl ${runDir}.exit`).catch(() => {});
	}
}

const tail = (s: string, max = 500) => (s.length > max ? `…${s.slice(-max)}` : s).trim();

interface Summary {
	usage: Usage;
	costUsd: number;
	turns: number;
	terminal?: Extract<RunnerEvent, { type: "result" | "error" }>;
	trace: AgentTrace;
	/** Lines that aren't valid RunnerEvents. */
	invalidLines: number;
}

function emptySummary(): Summary {
	return {
		usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 },
		costUsd: 0,
		turns: 0,
		trace: { toolCalls: [], toolResults: [], assistantText: [] },
		invalidLines: 0,
	};
}

/** Sums usage over the runner's events and finds the terminal one. Turns come from `result`, else count model calls. */
function summarize(jsonl: string): Summary {
	const summary = emptySummary();
	let calls = 0;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let event: RunnerEvent;
		try {
			event = RunnerEvent.parse(JSON.parse(line));
		} catch {
			summary.invalidLines++;
			continue;
		}
		if (summary.terminal) continue;
		if (event.type === "tool_call") {
			summary.trace.toolCalls.push({ tool: event.tool, args: event.args });
		} else if (event.type === "tool_result") {
			summary.trace.toolResults.push({ tool: event.tool, isError: event.is_error, outputPreview: event.output_preview });
		} else if (event.type === "assistant_text") {
			summary.trace.assistantText.push(event.text);
		} else if (event.type === "usage") {
			const u = summary.usage;
			u.input_tokens += event.usage.input_tokens;
			u.output_tokens += event.usage.output_tokens;
			u.cache_read_tokens += event.usage.cache_read_tokens;
			u.cache_write_tokens += event.usage.cache_write_tokens;
			u.cost_usd = (u.cost_usd ?? 0) + (event.usage.cost_usd ?? 0);
			calls++;
		} else if (event.type === "result" || event.type === "error") {
			summary.terminal = event;
		}
	}
	summary.costUsd = summary.usage.cost_usd ?? 0;
	summary.turns = summary.terminal?.type === "result" ? summary.terminal.turns : calls;
	return summary;
}
