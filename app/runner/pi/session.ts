import { setTimeout as sleep } from "node:timers/promises";
import { type AfterToolCallContext, Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import agentCorePackage from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import {
	type Api,
	type AssistantMessage,
	calculateCost,
	InMemoryCredentialStore,
	isRetryableAssistantError,
	type Model,
	type MutableModels,
	type Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Emitter, errorMessage, previewText } from "../core/emit.js";
import type { HarnessRun } from "../core/harness.js";
import { RUNNER_EXIT, type RunnerErrorCode, type Usage } from "../core/protocol.js";
import { SUBMIT_TOOL, Submission } from "../core/submit.js";
import { contentText, createTools } from "../tools/index.js";
import { createSubmitTool } from "./submit-tool.js";
import { registerTestStubModel } from "./test-stub.js";

export const PI_VERSION: string = agentCorePackage.version;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface PiSessionOptions {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
}

const MAX_OUTPUT_TOKENS = 16_384;
/** Passed to the agent so the max_tokens cap below stays in step with Pi's thinking budget. */
const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16_384 } as const;

/** Time kept back from `timeout_ms` so the runner reports its own timeout before the host kills it. */
const SAFETY_MARGIN_MS = 10_000;
/** How long an abort may take to settle before the runner reports the stop anyway. */
const ABORT_GRACE_MS = 5_000;
/** Retries of a model request that failed transiently (overloaded, rate limited, dropped stream). */
const MAX_MODEL_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;

const SUBMIT_REMINDER = `You stopped without calling ${SUBMIT_TOOL}. Call it now, exactly once, with your final output built from what you have found so far.`;

/**
 * Undefined for all-zero usage (e.g. a request aborted before it was sent). When the provider reports no cost
 * (the test stub never does), the cost is computed from the model's prices.
 */
function toUsage(u: PiUsage, model: Model<Api>): Usage | undefined {
	const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
	const usage: Usage = {
		input_tokens: count(u.input),
		output_tokens: count(u.output),
		cache_read_tokens: count(u.cacheRead),
		cache_write_tokens: count(u.cacheWrite),
	};
	if (usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens === 0) return undefined;
	let cost = u.cost?.total;
	if (!cost) cost = calculateCost(model, { ...u, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }).total;
	return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { ...usage, cost_usd: cost } : usage;
}

/** The built-in provider catalog with in-memory credentials: the key is passed per request, nothing is stored. */
export function createModels(): MutableModels {
	return builtinModels({ credentials: new InMemoryCredentialStore() });
}

/** Applies the Anthropic thinking token budget only for anthropic-messages models; others use effort levels. */
function capMaxTokens(model: Model<Api>, level: ThinkingLevel): Model<Api> {
	if (model.api !== "anthropic-messages") return model;
	const thinking = level === "off" ? 0 : THINKING_BUDGETS[level];
	return { ...model, maxTokens: Math.min(model.maxTokens, MAX_OUTPUT_TOKENS + thinking) };
}

type Failure = { code: RunnerErrorCode; message: string };

/** Runs one agent on Pi and emits `started` … then exactly one `result` or `error`. Returns the exit code. */
export async function runPiSession(run: HarnessRun, opts: PiSessionOptions): Promise<number> {
	const { input, emit, startedAt } = run;
	const fail = (code: RunnerErrorCode, message: string) => {
		emit({ type: "error", code, message });
		return code === "invalid_input" ? RUNNER_EXIT.invalid_input : RUNNER_EXIT.error;
	};

	const models = createModels();
	const requested = models.getModel(opts.model.provider, opts.model.id);
	if (!requested) {
		return fail("invalid_input", `unknown model "${opts.model.provider}/${opts.model.id}" (not in the Pi ${PI_VERSION} registry)`);
	}
	if (!run.testScript && !run.apiKey) {
		return fail("agent_error", `no API key for provider "${opts.model.provider}": pass it with --key-stdin`);
	}
	const model = capMaxTokens(run.testScript ? registerTestStubModel(models, run.testScript, requested) : requested, opts.thinkingLevel);

	const submission = new Submission(input.output_schema);
	let failure: Failure | undefined;
	const stopped = new AbortController();
	const tools =
		input.tools.length > 0 && input.cwd && input.scratch_dir
			? createTools({ tools: input.tools, cwd: input.cwd, scratchDir: input.scratch_dir })
			: [];

	const agent = new Agent({
		initialState: {
			systemPrompt: input.system_prompt,
			model,
			thinkingLevel: opts.thinkingLevel,
			tools: [...tools, createSubmitTool(input.output_schema, submission, (message) => stop({ code: "invalid_submission", message }))],
		},
		streamFn: (m, context, options) => models.streamSimple(m, context, options),
		getApiKey: () => run.apiKey,
		thinkingBudgets: THINKING_BUDGETS,
		afterToolCall: async (ctx) => (endsBatch(ctx) || failure !== undefined ? { terminate: true } : undefined),
	});

	emit({ type: "started", agent_id: input.agent_id, harness: "pi", harness_version: PI_VERSION, model: `${model.provider}/${model.id}` });

	function stop(reason?: Failure) {
		if (reason) failure ??= reason;
		stopped.abort();
		if (agent.state.isStreaming) agent.abort();
	}
	/** Sends `text`, then restarts the last turn while it fails with a transient model error. */
	const prompt = async (text: string) => {
		await agent.prompt(text);
		for (let attempt = 1; attempt <= MAX_MODEL_RETRIES && !stopped.signal.aborted; attempt++) {
			const last = lastAssistant(agent);
			if (last?.stopReason !== "error" || !isRetryableAssistantError(last)) return;
			agent.state.messages = agent.state.messages.slice(0, -1);
			await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), undefined, { signal: stopped.signal }).catch(() => {});
			if (stopped.signal.aborted) return;
			await agent.continue();
		}
	};
	let turns = 0;
	const unsubscribe = agent.subscribe((event) => {
		forward(event, emit, model);
		if (event.type !== "turn_end") return;
		turns++;
		// Backstop for batches that still continue after a submission (e.g. a sibling call failed validation).
		if (submission.accepted || failure) stop();
		else if (turns >= input.max_turns) stop({ code: "max_turns", message: `turn limit (${input.max_turns}) reached without a submission` });
	});

	const onAbort = () => stop({ code: "agent_error", message: "the run was cancelled" });
	if (run.signal?.aborted) onAbort();
	run.signal?.addEventListener("abort", onAbort, { once: true });

	const budgetMs = input.timeout_ms - Math.min(SAFETY_MARGIN_MS, Math.floor(input.timeout_ms / 10));
	let deadline: NodeJS.Timeout | undefined;
	let grace: NodeJS.Timeout | undefined;
	const settled = new Promise<void>((resolve) => {
		const giveUp = () => {
			grace ??= setTimeout(resolve, ABORT_GRACE_MS);
		};
		stopped.signal.addEventListener("abort", giveUp, { once: true });
		deadline = setTimeout(
			() => stop({ code: "timeout", message: `the run exceeded its ${budgetMs} ms budget` }),
			Math.max(0, startedAt + budgetMs - Date.now()),
		);
	});

	const conversation = (async () => {
		if (stopped.signal.aborted) return;
		await prompt(input.message);
		if (!submission.accepted && !failure && stoppedOnItsOwn(agent)) await prompt(SUBMIT_REMINDER);
	})();
	let thrown: unknown;
	await Promise.race([
		conversation.catch((err) => {
			thrown = err;
		}),
		settled,
	]);
	clearTimeout(deadline);
	clearTimeout(grace);
	unsubscribe();
	run.signal?.removeEventListener("abort", onAbort);

	if (submission.accepted) {
		emit({ type: "result", output: submission.accepted.output, turns });
		return RUNNER_EXIT.ok;
	}
	failure ??= diagnose(agent, thrown);
	emit({ type: "error", ...failure });
	return failure.code === "timeout" ? RUNNER_EXIT.timeout : RUNNER_EXIT.error;
}

function forward(event: AgentEvent, emit: Emitter, model: Model<Api>) {
	switch (event.type) {
		case "tool_execution_start":
			emit({ type: "tool_call", tool_call_id: event.toolCallId, tool: event.toolName, args: event.args });
			break;
		case "tool_execution_end":
			emit({
				type: "tool_result",
				tool_call_id: event.toolCallId,
				tool: event.toolName,
				is_error: event.isError,
				output_preview: previewText(contentText((event.result as { content?: unknown } | undefined)?.content)),
			});
			break;
		case "message_end": {
			const message = event.message;
			if (message.role !== "assistant") break;
			const text = message.content
				.flatMap((c) => (c.type === "text" ? [c.text] : []))
				.join("\n")
				.trim();
			if (text) emit({ type: "assistant_text", text });
			const usage = toUsage(message.usage, model);
			if (usage) emit({ type: "usage", usage });
			break;
		}
	}
}

function callsSubmit(message: { role: string; content?: unknown }): boolean {
	return (
		message.role === "assistant" && Array.isArray(message.content) && message.content.some((c) => c?.type === "toolCall" && c.name === SUBMIT_TOOL)
	);
}

/**
 * The loop ends only when every tool result in a batch sets `terminate`, so a submission batched with other
 * calls (e.g. `ls` + submit) would cost another LLM request. The submit tool terminates on acceptance;
 * this marks its siblings too. A rejected submission carries no `terminate`, so the model still gets to retry.
 */
function endsBatch({ toolCall, assistantMessage }: AfterToolCallContext): boolean {
	return toolCall.name !== SUBMIT_TOOL && callsSubmit(assistantMessage);
}

function lastAssistant(agent: Agent): AssistantMessage | undefined {
	const messages = agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") return m;
	}
	return undefined;
}

/** The model ended its turn without being stopped or failing (so a reminder may help). */
function stoppedOnItsOwn(agent: Agent): boolean {
	const last = lastAssistant(agent);
	return last?.stopReason === "stop" || last?.stopReason === "length";
}

function diagnose(agent: Agent, thrown: unknown): Failure {
	if (thrown !== undefined) return { code: "agent_error", message: errorMessage(thrown) };
	const last = lastAssistant(agent);
	if (last?.stopReason === "error" || last?.stopReason === "aborted") {
		return { code: "agent_error", message: last.errorMessage ?? agent.state.errorMessage ?? `model request ${last.stopReason}` };
	}
	return { code: "no_submission", message: `the model stopped without calling ${SUBMIT_TOOL}, even after a reminder` };
}
