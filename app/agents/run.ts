import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { modelFor } from "../config/index.js";
import { emit } from "../events/index.js";
import { providerApiKey } from "../runner/keys.js";
import { type RunnerErrorCode, RunnerEvent, type RunnerInput, type ToolName, type Usage } from "../runner/protocol.js";
import { errorMessage } from "../runner/session.js";
import { APP_DIR, REPO_DIR, SCRATCH_DIR, type Sandbox } from "../sandbox/types.js";
import type { Agent, OutputSchema } from "./define.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Extra time the host gives run-agent.sh beyond the runner's own timeout, to flush events and exit. */
const EXEC_GRACE_MS = 60_000;

export type AgentErrorCode = RunnerErrorCode | "output_invalid" | "runner_lost";

export class AgentError extends Error {
	override readonly name = "AgentError";
	constructor(
		readonly agentId: string,
		readonly code: AgentErrorCode,
		message: string,
	) {
		super(message);
	}
}

export interface RunAgentOptions {
	/** Tools run only here, never in a Workflows task. */
	sandbox: Sandbox;
	/** Root task run of the GitHub task; every event this run emits carries it. */
	traceId: string;
	runId?: string;
	repo?: string;
	subject?: string;
	/** Default 30 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface AgentRun<Output extends OutputSchema> {
	output: z.infer<Output>;
	usage: Usage;
	costUsd: number;
	turns: number;
}

/**
 * Runs `agent` in `opts.sandbox` on `message`, the task for this run, and returns the submission parsed by the
 * agent's Zod schema. Every failure throws an AgentError; usage and cost are recorded on `agent.finished` either way.
 */
export async function runAgent<Tools extends readonly ToolName[], Output extends OutputSchema>(
	agent: Agent<Tools, Output>,
	message: string,
	opts: RunAgentOptions,
): Promise<AgentRun<Output>> {
	const { sandbox, ...base } = opts;
	const { provider, model } = modelFor(agent.model);
	const timeoutMs = base.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const finish = (outcome: string, summary: Summary, message?: string) =>
		emit({
			traceId: base.traceId,
			runId: base.runId,
			repo: base.repo,
			subject: base.subject,
			type: "agent.finished",
			payload: {
				agentId: agent.id,
				model: `${provider}/${model}`,
				outcome,
				turns: summary.turns,
				usage: summary.usage,
				costUsd: summary.costUsd,
				...(summary.invalidLines ? { invalidLines: summary.invalidLines } : {}),
				...(message ? { message } : {}),
			},
		});

	let summary = emptySummary();
	const failure = (code: AgentErrorCode, text: string) => new AgentError(agent.id, code, text);
	try {
		const runnerInput: RunnerInput = {
			trace_id: base.traceId,
			agent_id: agent.id,
			system_prompt: agent.prompt,
			message,
			model_provider: provider,
			model,
			thinking_level: agent.thinking ?? "medium",
			tools: [...agent.tools],
			output_schema: agent.outputJsonSchema,
			max_turns: agent.maxTurns,
			timeout_ms: timeoutMs,
			cwd: REPO_DIR,
			scratch_dir: SCRATCH_DIR,
		};
		const apiKey = providerApiKey(provider, process.env);
		if (!apiKey) throw failure("agent_error", `no API key for provider "${provider}" in the environment`);

		const stdout = await runInSandbox(sandbox, runnerInput, apiKey, timeoutMs, base.signal);
		summary = summarize(stdout.text);
		const end = summary.terminal;
		if (!end) {
			throw failure("runner_lost", `the runner ended without a result or error event${stdout.detail ? ` (${stdout.detail})` : ""}`);
		}
		if (end.type === "error") throw failure(end.code, end.message);
		const parsed = agent.output.safeParse(end.output);
		if (!parsed.success) {
			const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
			throw failure("output_invalid", `agent ${agent.id} submitted output its schema rejects: ${issues}`);
		}
		finish("ok", summary);
		return { output: parsed.data, usage: summary.usage, costUsd: summary.costUsd, turns: summary.turns };
	} catch (err) {
		const error = err instanceof AgentError ? err : failure("agent_error", errorMessage(err));
		finish(error.code, summary, error.message);
		throw error;
	}
}

interface RunnerOutput {
	/** The runner's stdout: RunnerEvent JSONL. */
	text: string;
	/** What went wrong around the runner, for a runner_lost message. */
	detail?: string;
}

/**
 * Contract with `${APP_DIR}/run-agent.sh <runDir> <timeoutSeconds>`: as root, it reads and deletes
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
	/** Lines that aren't valid RunnerEvents. */
	invalidLines: number;
}

function emptySummary(): Summary {
	return {
		usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 },
		costUsd: 0,
		turns: 0,
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
		if (event.type === "usage") {
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
