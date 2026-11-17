import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { type Db, workflowsDb } from "../db/index.js";
import { AgentRunRecorder } from "../events/index.js";
import { PROTOCOL_VERSION, type RunnerErrorCode, RunnerEvent, type RunnerInput, type ToolName, type Usage } from "../runner/index.js";
import { APP_DIR, type ExecStreamOptions, REPO_DIR, SCRATCH_DIR, type Sandbox } from "../sandbox/index.js";
import type { ThreadKey } from "../threads/index.js";
import { errorMessage } from "../util/index.js";
import type { Agent, OutputSchema } from "./define.js";
import { followRun, LineRelay } from "./relay.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Extra time the host gives run-agent.sh beyond the runner's own timeout, to flush events and exit. */
const EXEC_GRACE_MS = 60_000;
/** run-agent.sh's stderr kept for a runner_lost message. */
const STDERR_KEPT = 2000;

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
	/** The thread the run works on, if any; its events carry it. */
	thread?: ThreadKey;
	/** Default 30 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** The event log the run is recorded in. Default: the Workflows process's pool. */
	db?: Db;
}

export interface AgentRun<Output extends OutputSchema> {
	output: z.infer<Output>;
	usage: Usage;
	costUsd: number;
	turns: number;
}

/**
 * Runs `agent` in `opts.sandbox` on `message`, the task for this run, and returns the submission parsed by the
 * agent's Zod schema. Every failure throws an AgentError. Either way, the run is recorded in the event log as an
 * agent run, ending with `agent_run.finished` and its usage and cost.
 */
export async function runAgent<Tools extends readonly ToolName[], Output extends OutputSchema>(
	agent: Agent<Tools, Output>,
	message: string,
	opts: RunAgentOptions,
): Promise<AgentRun<Output>> {
	const { sandbox, ...base } = opts;
	const { harness } = agent;
	const timeoutMs = base.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const recorder = new AgentRunRecorder({
		db: base.db ?? workflowsDb(),
		runId: base.runId ?? base.traceId,
		thread: base.thread,
	});
	recorder.start({ agentId: agent.id, harness: harness.name, model: harness.label });
	const finish = (outcome: string, summary: Summary, message?: string) =>
		recorder.finish({
			outcome,
			turns: summary.turns,
			usage: summary.usage,
			costUsd: summary.costUsd,
			harnessVersion: summary.harnessVersion,
			message,
			invalidLines: summary.invalidLines,
		});

	let summary = emptySummary();
	const failure = (code: AgentErrorCode, text: string) => new AgentError(agent.id, code, text);
	try {
		const runnerInput: RunnerInput = {
			protocol_version: PROTOCOL_VERSION,
			trace_id: base.traceId,
			agent_id: agent.id,
			system_prompt: agent.prompt,
			message,
			tools: [...agent.tools],
			output_schema: agent.outputJsonSchema,
			max_turns: agent.maxTurns,
			timeout_ms: timeoutMs,
			cwd: REPO_DIR,
			scratch_dir: SCRATCH_DIR,
		};
		const apiKey = process.env[harness.credential]?.trim();
		if (!apiKey) throw failure("agent_error", `${harness.credential} is not set: the ${harness.name} harness needs it`);

		const relay = new LineRelay((line) => {
			const event = parseLine(line);
			if (event) recorder.onRunnerEvent(event);
		});
		const stdout = await runInSandbox(sandbox, runnerInput, apiKey, timeoutMs, relay, base.signal);
		const { events, invalidLines } = parseEvents(stdout.text);
		summary = summarize(events, invalidLines);
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
		await finish("ok", summary);
		return { output: parsed.data, usage: summary.usage, costUsd: summary.costUsd, turns: summary.turns };
	} catch (err) {
		const error = err instanceof AgentError ? err : failure("agent_error", errorMessage(err));
		await finish(error.code, summary, error.message);
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
 * Contract with `${APP_DIR}/run-agent.sh <runDir> <timeoutSeconds>`: as root, it writes its PID to `<runDir>.pid`,
 * reads and deletes `<runDir>/key` before handing `<runDir>` to the unprivileged user, then runs the runner as that
 * user from REPO_DIR with `--key-stdin`, feeding the key as the first line of stdin followed by
 * `<runDir>/input.json`. It writes the runner's stdout both to its own stdout and to `<runDir>.jsonl`, and the exit
 * status to `<runDir>.exit`. `<runDir>` must be root-only (mode 700) when the key is uploaded, so the runner user
 * can't reach the key file before it's deleted.
 *
 * The live copy reaches `relay` as the runner writes it; the downloaded `<runDir>.jsonl` is the result.
 */
async function runInSandbox(
	sandbox: Sandbox,
	input: RunnerInput,
	apiKey: string,
	timeoutMs: number,
	relay: LineRelay,
	signal?: AbortSignal,
): Promise<RunnerOutput> {
	const runDir = `/tmp/agent-${randomUUID()}`;
	const mkdir = await sandbox.exec(`mkdir -m 700 ${runDir}`, { signal });
	if (mkdir.exitCode !== 0) return { text: "", detail: `mkdir ${runDir} exited ${mkdir.exitCode}: ${tail(mkdir.stderr)}` };
	try {
		await sandbox.upload(`${runDir}/input.json`, JSON.stringify(input));
		await sandbox.upload(`${runDir}/key`, apiKey);
		const details: string[] = [];
		const deadline = Date.now() + timeoutMs + EXEC_GRACE_MS;
		let stderr = "";
		const onData: ExecStreamOptions["onData"] = (stream, data) => {
			if (stream === "stdout") relay.push(data);
			else stderr = (stderr + data).slice(-STDERR_KEPT);
		};
		try {
			const exitCode = await sandbox.execStream(`bash ${APP_DIR}/run-agent.sh ${runDir} ${Math.ceil(timeoutMs / 1000)}`, {
				onData,
				timeoutMs: deadline - Date.now(),
				signal,
			});
			if (exitCode !== 0) details.push(`run-agent.sh exited ${exitCode}: ${tail(stderr)}`);
		} catch (err) {
			if (signal?.aborted) throw err;
			details.push(`run-agent.sh failed: ${errorMessage(err)}`);
			const stopped = await followRun(sandbox, runDir, relay, deadline, signal);
			if (stopped) details.push(stopped);
		}
		let text = "";
		try {
			const file = await sandbox.download(`${runDir}.jsonl`, signal);
			relay.finish(file);
			text = file.toString("utf8");
		} catch (err) {
			if (signal?.aborted) throw err;
			details.push(`cannot download ${runDir}.jsonl: ${errorMessage(err)}`);
		}
		return { text, detail: details.join("; ") || undefined };
	} finally {
		await sandbox.exec(`rm -rf ${runDir} ${runDir}.jsonl ${runDir}.exit ${runDir}.pid`).catch(() => {});
	}
}

const tail = (s: string, max = 500) => (s.length > max ? `…${s.slice(-max)}` : s).trim();

interface Summary {
	usage: Usage;
	costUsd: number;
	turns: number;
	terminal?: Extract<RunnerEvent, { type: "result" | "error" }>;
	/** From the runner's `started` event: what actually ran, which the host can't always know. */
	harnessVersion?: string;
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

function parseEvents(jsonl: string): { events: RunnerEvent[]; invalidLines: number } {
	const events: RunnerEvent[] = [];
	let invalidLines = 0;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		const event = parseLine(line);
		if (event) events.push(event);
		else invalidLines++;
	}
	return { events, invalidLines };
}

function parseLine(line: string): RunnerEvent | undefined {
	try {
		return RunnerEvent.parse(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/** Sums usage up to the terminal event. Turns come from `result`, else count model calls. */
function summarize(events: readonly RunnerEvent[], invalidLines: number): Summary {
	const summary = { ...emptySummary(), invalidLines };
	let calls = 0;
	for (const event of events) {
		if (summary.terminal) break;
		if (event.type === "started") {
			summary.harnessVersion = event.harness_version;
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
