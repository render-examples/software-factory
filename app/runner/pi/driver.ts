import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import agentCorePackage from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type Model,
	type MutableModels,
	type Usage as PiUsage,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Driver, type DriverContext, InvalidInput, type Report } from "../core/driver.js";
import type { Usage } from "../core/protocol.js";
import { contentText } from "../tools/index.js";
import { piSubmitTool, piTool } from "./tools.js";

export const PI_VERSION: string = agentCorePackage.version;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface PiDriverOptions {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Providers added to Pi's built-in catalog, each replacing a built-in provider with the same ID. */
	models?: () => MutableModels;
}

const MAX_OUTPUT_TOKENS = 16_384;
/** Passed to Pi so the max_tokens cap below stays in step with Pi's thinking budget. */
const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16_384 } as const;

/**
 * Pi restarts a model request that failed transiently (overloaded, rate limited, dropped stream) with this backoff.
 * Cache warming re-sends requests on a timer, which would spend the run's turns, so it's off.
 */
const SETTINGS = {
	thinkingBudgets: THINKING_BUDGETS,
	retry: { enabled: true, maxRetries: 2, baseDelayMs: 2_000 },
	cacheWarming: "off",
} as const;

/** Runs agents on Pi (`@earendil-works/pi-coding-agent`). */
export function piDriver(opts: PiDriverOptions): Driver {
	return {
		async open(ctx) {
			const runtime = await createRuntime(opts.models?.());
			const { provider, id } = opts.model;
			const requested = runtime.getModel(provider, id);
			if (!requested) throw new InvalidInput(`unknown model "${provider}/${id}" (not in the Pi ${PI_VERSION} registry)`);
			await runtime.setRuntimeApiKey(provider, ctx.apiKey);
			const model = capMaxTokens(requested, opts.thinkingLevel);
			return {
				version: PI_VERSION,
				model: `${model.provider}/${model.id}`,
				run: () => converse(ctx, runtime, model, opts.thinkingLevel),
			};
		},
	};
}

/** Pi's catalog with in-memory credentials: the key is set per run, and nothing is read from or written to disk. */
async function createRuntime(custom: MutableModels | undefined): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	for (const provider of custom?.getProviders() ?? []) runtime.registerNativeProvider(provider);
	return runtime;
}

async function converse(ctx: DriverContext, runtime: ModelRuntime, model: Model<Api>, thinkingLevel: ThinkingLevel): Promise<void> {
	/**
	 * The loop ends only when every tool result in a batch sets `terminate`, so a submission batched with other
	 * calls (e.g. `ls` + submit) would cost another LLM request. The submit tool terminates on acceptance; its
	 * siblings terminate whenever the batch submits. A rejected submission carries no `terminate`, so the model still
	 * gets to retry. Listeners see each assistant message before its tools run.
	 */
	let submitting = false;
	const tools = [...ctx.tools.map((tool) => piTool(tool, () => submitting)), piSubmitTool(ctx.submit)];
	const session = await openSession(ctx, runtime, model, thinkingLevel, tools);
	const report = reporter(ctx.report, model);
	session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") submitting = callsTool(event.message, ctx.submit.name);
		report(event);
	});
	const abort = () => void session.abort();
	ctx.signal.addEventListener("abort", abort, { once: true });
	try {
		if (ctx.signal.aborted) return;
		await session.prompt(ctx.message, { expandPromptTemplates: false });
		const last = lastAssistant(session);
		if (last?.stopReason === "error" || last?.stopReason === "aborted") {
			throw new Error(last.errorMessage ?? `model request ${last.stopReason}`);
		}
	} finally {
		ctx.signal.removeEventListener("abort", abort);
		session.dispose();
	}
}

/**
 * A session that loads nothing from `cwd`, the untrusted checkout, or from `agentDir`: no context files such as
 * AGENTS.md, skills, prompt templates, themes, or extensions. An extension would run repository code in this
 * process, next to the key. The system prompt is the agent's alone, and the tools are exactly `tools`.
 */
async function openSession(
	ctx: DriverContext,
	runtime: ModelRuntime,
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
	tools: ToolDefinition[],
): Promise<AgentSession> {
	const agentDir = await mkdtemp(join(ctx.scratchDir, "pi-agent-"));
	const settingsManager = SettingsManager.inMemory(SETTINGS);
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: ctx.systemPrompt,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		agentDir,
		modelRuntime: limited(runtime, ctx.requestModel),
		model,
		thinkingLevel,
		noTools: "all",
		tools: tools.map((tool) => tool.name),
		customTools: tools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		settingsManager,
	});
	return session;
}

/**
 * `runtime`, with every model request (retries, compaction, and summaries included) passing the kernel's turn limit
 * first: the session sends them all through `streamSimple`.
 */
function limited(runtime: ModelRuntime, requestModel: () => boolean): ModelRuntime {
	return new Proxy(runtime, {
		get(target, prop) {
			if (prop === "streamSimple") {
				const streamSimple: ModelRuntime["streamSimple"] = (model, context, options) =>
					requestModel() ? target.streamSimple(model, context, options) : refused(model);
				return streamSimple;
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
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

/** Translates Pi's events, naming each assistant message at its start so its deltas and final text share an ID. */
function reporter(out: Report, model: Model<Api>): (event: AgentSessionEvent) => void {
	let messages = 0;
	let messageId = "";
	return (event) => {
		switch (event.type) {
			case "tool_execution_start":
				out.toolCall(event.toolCallId, event.toolName, event.args);
				break;
			case "tool_execution_end":
				out.toolResult(event.toolCallId, event.toolName, contentText((event.result as { content?: unknown } | undefined)?.content), event.isError);
				break;
			case "message_start":
				if (event.message.role === "assistant") messageId = `m${++messages}`;
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") out.delta(messageId, event.assistantMessageEvent.delta);
				break;
			case "message_end": {
				const message = event.message;
				if (message.role !== "assistant") break;
				const text = message.content
					.flatMap((c) => (c.type === "text" ? [c.text] : []))
					.join("\n")
					.trim();
				if (text) out.text(messageId, text);
				const usage = toUsage(message.usage, model);
				if (usage) out.usage(usage);
				break;
			}
		}
	};
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

function callsTool(message: AssistantMessage, name: string): boolean {
	return message.content.some((c) => c.type === "toolCall" && c.name === name);
}

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") return m;
	}
	return undefined;
}
