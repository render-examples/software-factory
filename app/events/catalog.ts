import { z } from "zod";
import { ThreadKey } from "../threads/index.js";

/**
 * One type of event in the log. Bump `version` whenever the payload schema changes; readers handle every version
 * still in the log. Bound every string and array, and give no schema a free-form field for keys or tokens.
 */
export interface EventSpec<S extends z.ZodType = z.ZodType> {
	readonly type: string;
	readonly version: number;
	readonly payload: S;
}

/** Every event type the factory writes is declared in this file with `defineEvent`. */
export function defineEvent<S extends z.ZodType>(type: string, version: number, payload: S): EventSpec<S> {
	return { type, version, payload };
}

/** IDs and names, such as a run ID or a tool's name, in characters. */
export const ID_MAX = 200;
const id = z.string().min(1).max(ID_MAX);

// Run coordination (plan 02)

const name = z.string().min(1).max(100);
/** Published to the thread's channel (on GitHub, the status comment), so it must be safe to publish. */
const summary = z.string().max(16_000);
const finalState = z.enum(["done", "failed", "cancelled"]);

/**
 * Stream `delivery:<channel>:<id>`: an authenticated delivery from a channel (a GitHub webhook today) and the task it
 * started or why it started none. `event` is the channel's name for the event.
 */
export const deliveryReceived = defineEvent(
	"delivery.received",
	1,
	z.strictObject({ event: name, repo: id.optional(), task: name.optional(), ignored: z.string().max(200).optional() }),
);

/**
 * Stream `thread:<thread>`: task run `run_id` started on the thread. `trace_id` is its root task run. The trace
 * whose run started last owns the thread until its runs finish; the stream's version fences starts.
 */
export const runStarted = defineEvent(
	"run.started",
	1,
	z.strictObject({ run_id: id, trace_id: id, task: name, title: name, actor: name, mode: z.enum(["replace", "continue"]) }),
);

/** Stream `run:<task_run_id>` for the rest of this block. The actor lacked the permission, so the run never started. */
export const runRejected = defineEvent("run.rejected", 1, z.strictObject({ trace_id: id, task: name, title: name, actor: name, reason: summary }));

export const runProgress = defineEvent("run.progress", 1, z.strictObject({ summary }));

export const runSandboxAttached = defineEvent("run.sandbox_attached", 1, z.strictObject({ sandbox_id: id }));

/** A run that took over the thread stopped this one; `by` is that run, and `active` whether Render still had this one's trace running. */
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
	}),
);
// Live agent events (plan 05)

/**
 * Model text in one event. The recorder clips to this many bytes of JSON-encoded UTF-8, so the schema's character
 * limit, which every byte budget implies, can never be exceeded.
 */
export const MESSAGE_MAX = 64 * 1024;
/** Tool arguments (as JSON) and output previews, clipped the same way as MESSAGE_MAX. */
export const TOOL_TEXT_MAX = 32 * 1024;

const count = z.number().int().nonnegative();
const TokenUsage = z.strictObject({
	input_tokens: count,
	output_tokens: count,
	cache_read_tokens: count,
	cache_write_tokens: count,
	cost_usd: z.number().nonnegative().optional(),
});

/** The first event on `agent_run:<id>`: what the host started, before the runner reports anything. */
export const agentRunStarted = defineEvent("agent_run.started", 1, z.strictObject({ run_id: id, agent_id: id, harness: id, model: id }));
export const assistantMessage = defineEvent("assistant.message", 1, z.strictObject({ message_id: id, text: z.string().max(MESSAGE_MAX) }));
export const toolCall = defineEvent("tool.call", 1, z.strictObject({ call_id: id, tool: id, args: z.string().max(TOOL_TEXT_MAX) }));
export const toolResult = defineEvent(
	"tool.result",
	1,
	z.strictObject({ call_id: id, tool: id, is_error: z.boolean(), output_preview: z.string().max(TOOL_TEXT_MAX) }),
);
/** One model request's usage, as the runner reported it: for display only. */
export const usage = defineEvent("usage", 1, TokenUsage);
/** Outcome, turns, usage, and cost from the host's own summary of the run, never from streamed `usage` events. */
export const agentRunFinished = defineEvent(
	"agent_run.finished",
	1,
	z.strictObject({
		outcome: z.string().min(1).max(64),
		turns: count,
		usage: TokenUsage,
		cost_usd: z.number().nonnegative(),
		harness_version: z.string().max(ID_MAX).optional(),
		/** Why the run failed. */
		message: z.string().max(2000).optional(),
		/** Runner output lines that weren't valid events. */
		invalid_lines: count.optional(),
	}),
);

/** Postgres's NOTIFY channel for what the log doesn't store: deltas of in-progress assistant messages. */
export const LIVE_CHANNEL = "live";

/** Postgres rejects NOTIFY payloads over 8,000 bytes; a delta's text is split into parts that stay under it. */
export const LiveNotice = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("delta"),
		stream: id,
		thread: ThreadKey.nullable(),
		message_id: id,
		/** Orders one message's deltas; with `part`, lets a listener drop a repeat. */
		local_seq: count,
		part: count,
		text: z.string().max(8000),
	}),
	/** The message is complete (its `assistant.message` is in the log) or will never be. */
	z.strictObject({ type: z.literal("final"), stream: id, message_id: id }),
]);
export type LiveNotice = z.infer<typeof LiveNotice>;
