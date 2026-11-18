import { z } from "zod";
import { ThreadKey } from "../threads/index.js";

export interface EventSpec<S extends z.ZodType = z.ZodType> {
	readonly type: string;
	readonly version: number;
	readonly payload: S;
}

export function defineEvent<S extends z.ZodType>(type: string, version: number, payload: S): EventSpec<S> {
	return { type, version, payload };
}

export const ID_MAX = 200;
const id = z.string().min(1).max(ID_MAX);

const name = z.string().min(1).max(100);
const summary = z.string().max(16_000);
const finalState = z.enum(["done", "failed", "cancelled"]);

export const deliveryReceived = defineEvent(
	"delivery.received",
	1,
	z.strictObject({ event: name, repo: id.optional(), task: name.optional(), ignored: z.string().max(200).optional() }),
);

export const runStarted = defineEvent(
	"run.started",
	1,
	z.strictObject({ run_id: id, trace_id: id, task: name, title: name, actor: name, mode: z.enum(["replace", "continue"]) }),
);

export const runRejected = defineEvent("run.rejected", 1, z.strictObject({ trace_id: id, task: name, title: name, actor: name, reason: summary }));

export const runProgress = defineEvent("run.progress", 1, z.strictObject({ summary }));

export const runSandboxAttached = defineEvent("run.sandbox_attached", 1, z.strictObject({ sandbox_id: id }));

export const runStopped = defineEvent("run.stopped", 1, z.strictObject({ by: id, active: z.boolean(), summary }));

export const runFinished = defineEvent(
	"run.finished",
	1,
	z.strictObject({
		state: finalState,
		outcome: name,
		summary,
		links: z.array(z.strictObject({ label: z.string().max(200), url: z.string().max(2000) })).max(20),
		duration_ms: z.number().int().nonnegative(),
		waiting: z.literal("reply").optional(),
	}),
);

export const MESSAGE_MAX = 64 * 1024;
export const TOOL_TEXT_MAX = 32 * 1024;

const count = z.number().int().nonnegative();
const TokenUsage = z.strictObject({
	input_tokens: count,
	output_tokens: count,
	cache_read_tokens: count,
	cache_write_tokens: count,
	cost_usd: z.number().nonnegative().optional(),
});

export const agentRunStarted = defineEvent("agent_run.started", 1, z.strictObject({ run_id: id, agent_id: id, harness: id, model: id }));
export const assistantMessage = defineEvent("assistant.message", 1, z.strictObject({ message_id: id, text: z.string().max(MESSAGE_MAX) }));
export const toolCall = defineEvent("tool.call", 1, z.strictObject({ call_id: id, tool: id, args: z.string().max(TOOL_TEXT_MAX) }));
export const toolResult = defineEvent(
	"tool.result",
	1,
	z.strictObject({ call_id: id, tool: id, is_error: z.boolean(), output_preview: z.string().max(TOOL_TEXT_MAX) }),
);
export const usage = defineEvent("usage", 1, TokenUsage);
export const agentRunFinished = defineEvent(
	"agent_run.finished",
	1,
	z.strictObject({
		outcome: z.string().min(1).max(64),
		turns: count,
		usage: TokenUsage,
		cost_usd: z.number().nonnegative(),
		harness_version: z.string().max(ID_MAX).optional(),
		message: z.string().max(2000).optional(),
		invalid_lines: count.optional(),
	}),
);

export const LIVE_CHANNEL = "live";

export const LiveNotice = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("delta"),
		stream: id,
		thread: ThreadKey.nullable(),
		message_id: id,
		local_seq: count,
		part: count,
		text: z.string().max(8000),
	}),
	z.strictObject({ type: z.literal("final"), stream: id, message_id: id }),
]);
export type LiveNotice = z.infer<typeof LiveNotice>;
