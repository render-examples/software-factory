import { setTimeout as sleep } from "node:timers/promises";
import { type AfterToolCallContext, Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import agentCorePackage from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	isRetryableAssistantError,
	type Model,
	type MutableModels,
	type Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { type Driver, type DriverContext, InvalidInput, type Report } from "../core/driver.js";
import type { Usage } from "../core/protocol.js";
import { contentText } from "../tools/index.js";
import { piSubmitTool, piTool } from "./tools.js";

export const PI_VERSION: string = agentCorePackage.version;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface PiDriverOptions {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Default: the built-in catalog (createModels). */
	models?: () => MutableModels;
}

const MAX_OUTPUT_TOKENS = 16_384;
/** Passed to the agent so the max_tokens cap below stays in step with Pi's thinking budget. */
const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16_384 } as const;

/** Retries of a model request that failed transiently (overloaded, rate limited, dropped stream). */
const MAX_MODEL_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;

/** The built-in provider catalog with in-memory credentials: the key is passed per request, nothing is stored. */
export function createModels(): MutableModels {
	return builtinModels({ credentials: new InMemoryCredentialStore() });
}

/** Runs agents on Pi (`@earendil-works/pi-agent-core`). */
export function piDriver(opts: PiDriverOptions): Driver {
	return {
		open(ctx) {
			const models = (opts.models ?? createModels)();
			const { provider, id } = opts.model;
			const requested = models.getModel(provider, id);
			if (!requested) throw new InvalidInput(`unknown model "${provider}/${id}" (not in the Pi ${PI_VERSION} registry)`);
			const model = capMaxTokens(requested, opts.thinkingLevel);
			return {
				version: PI_VERSION,
				model: `${model.provider}/${model.id}`,
				run: () => converse(ctx, models, model, opts.thinkingLevel),
			};
		},
	};
}

async function converse(ctx: DriverContext, models: MutableModels, model: Model<Api>, thinkingLevel: ThinkingLevel): Promise<void> {
	const agent = new Agent({
		initialState: {
			systemPrompt: ctx.systemPrompt,
			model,
			thinkingLevel,
			tools: [...ctx.tools.map(piTool), piSubmitTool(ctx.submit)],
		},
		// Every provider request, retries included, passes the kernel's turn limit first.
		streamFn: (m, context, options) => (ctx.requestModel() ? models.streamSimple(m, context, options) : refused(m)),
		getApiKey: () => ctx.apiKey,
		thinkingBudgets: THINKING_BUDGETS,
		afterToolCall: async (call) => (endsBatch(call, ctx.submit.name) ? { terminate: true } : undefined),
	});
	const unsubscribe = agent.subscribe((event) => report(event, ctx.report, model));
	const abort = () => agent.abort();
	ctx.signal.addEventListener("abort", abort, { once: true });
	try {
		if (ctx.signal.aborted) return;
		await agent.prompt(ctx.message);
		// Restarts the last request while it fails with a transient model error.
		for (let attempt = 1; attempt <= MAX_MODEL_RETRIES && !ctx.signal.aborted; attempt++) {
			const last = lastAssistant(agent);
			if (last?.stopReason !== "error" || !isRetryableAssistantError(last)) break;
			agent.state.messages = agent.state.messages.slice(0, -1);
			await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), undefined, { signal: ctx.signal }).catch(() => {});
			if (ctx.signal.aborted) return;
			await agent.continue();
		}
		const last = lastAssistant(agent);
		if (last?.stopReason === "error" || last?.stopReason === "aborted") {
			throw new Error(last.errorMessage ?? agent.state.errorMessage ?? `model request ${last.stopReason}`);
		}
	} finally {
		unsubscribe();
		ctx.signal.removeEventListener("abort", abort);
	}
}

/** Applies the Anthropic thinking token budget only for anthropic-messages models; others use effort levels. */
function capMaxTokens(model: Model<Api>, level: ThinkingLevel): Model<Api> {
	if (model.api !== "anthropic-messages") return model;
	const thinking = level === "off" ? 0 : THINKING_BUDGETS[level];
	return { ...model, maxTokens: Math.min(model.maxTokens, MAX_OUTPUT_TOKENS + thinking) };
}

/** A request the kernel refused, ended the way Pi ends an aborted one. */
function refused(model: Model<Api>): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "aborted",
		errorMessage: "the run is over",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "aborted", error: message });
	stream.end(message);
	return stream;
}

function report(event: AgentEvent, out: Report, model: Model<Api>) {
	switch (event.type) {
		case "tool_execution_start":
			out.toolCall(event.toolCallId, event.toolName, event.args);
			break;
		case "tool_execution_end":
			out.toolResult(event.toolCallId, event.toolName, contentText((event.result as { content?: unknown } | undefined)?.content), event.isError);
			break;
		case "message_end": {
			const message = event.message;
			if (message.role !== "assistant") break;
			const text = message.content
				.flatMap((c) => (c.type === "text" ? [c.text] : []))
				.join("\n")
				.trim();
			if (text) out.text(text);
			const usage = toUsage(message.usage, model);
			if (usage) out.usage(usage);
			break;
		}
	}
}

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

/**
 * The loop ends only when every tool result in a batch sets `terminate`, so a submission batched with other
 * calls (e.g. `ls` + submit) would cost another LLM request. The submit tool terminates on acceptance;
 * this marks its siblings too. A rejected submission carries no `terminate`, so the model still gets to retry.
 */
function endsBatch({ toolCall, assistantMessage }: AfterToolCallContext, submit: string): boolean {
	return toolCall.name !== submit && assistantMessage.content.some((c) => c.type === "toolCall" && c.name === submit);
}

function lastAssistant(agent: Agent): AssistantMessage | undefined {
	const messages = agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") return m;
	}
	return undefined;
}
