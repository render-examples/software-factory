import { randomUUID } from "node:crypto";
import { appendMany, type Db, type NewEvent, type Tx } from "../db/index.js";
import { errorMessage } from "../runner/core/emit.js";
import type { RunnerEvent, Usage } from "../runner/core/protocol.js";
import {
	agentRunFinished,
	agentRunStarted,
	assistantMessage,
	ID_MAX,
	LIVE_CHANNEL,
	type LiveNotice,
	MESSAGE_MAX,
	TOOL_TEXT_MAX,
	toolCall,
	toolResult,
	usage,
} from "./catalog.js";

const FLUSH_MS = 250;
/** Log events kept while the database is unreachable; later ones are dropped. */
const MAX_QUEUED = 1000;
/** A delta part's text, in bytes once JSON-encoded, leaving room in the 8,000-byte NOTIFY payload for the envelope. */
const MAX_PART_BYTES = 6000;
const TRUNCATED = "…[truncated]";

export interface RecorderOptions {
	db: Db;
	/** The Workflows task run the agent runs in. */
	runId: string;
	/** "owner/name#issue-12", when the run is about an issue or pull request. */
	subject?: string;
}

export interface AgentRunSummary {
	outcome: string;
	turns: number;
	usage: Usage;
	costUsd: number;
	harnessVersion?: string;
	message?: string;
	invalidLines?: number;
}

type Pending = Omit<NewEvent, "stream">;

/**
 * Records one agent run in the log as `agent_run:<id>`, its only writer. Runner output is untrusted: it becomes
 * display events on this stream and nothing else. Writes are batched every 250 ms; deltas go out over NOTIFY in
 * the same transaction and are never stored. A database error is logged and never reaches the agent run.
 */
export class AgentRunRecorder {
	readonly id = `ar_${randomUUID()}`;
	readonly stream = `agent_run:${this.id}`;
	readonly #db: Db;
	readonly #subject?: string;
	readonly #source: string;
	readonly #runId: string;
	#queue: Pending[] = [];
	#deltas = new Map<string, string>();
	/** Messages with deltas sent but no final text yet. */
	readonly #open = new Set<string>();
	#finals: string[] = [];
	#localSeq = 0;
	#dropped = 0;
	#timer?: NodeJS.Timeout;
	#writing = Promise.resolve(true);
	#finished = false;

	constructor(opts: RecorderOptions) {
		this.#db = opts.db;
		this.#runId = opts.runId;
		this.#subject = opts.subject;
		this.#source = `workflow:${opts.runId}`;
	}

	start(agent: { agentId: string; harness: string; model: string }): void {
		this.#push(agentRunStarted, { run_id: this.#runId, agent_id: agent.agentId, harness: agent.harness, model: agent.model });
	}

	onRunnerEvent(event: RunnerEvent): void {
		switch (event.type) {
			case "assistant_delta": {
				const messageId = clip(event.message_id, ID_MAX);
				this.#deltas.set(messageId, (this.#deltas.get(messageId) ?? "") + event.text);
				this.#open.add(messageId);
				this.#schedule();
				break;
			}
			case "assistant_text": {
				const messageId = clip(event.message_id, ID_MAX);
				this.#push(assistantMessage, { message_id: messageId, text: clip(event.text, MESSAGE_MAX) });
				if (this.#open.delete(messageId)) this.#finals.push(messageId);
				break;
			}
			case "tool_call":
				this.#push(toolCall, {
					call_id: clip(event.tool_call_id, ID_MAX),
					tool: clip(event.tool, ID_MAX),
					args: clip(JSON.stringify(event.args) ?? "null", TOOL_TEXT_MAX),
				});
				break;
			case "tool_result":
				this.#push(toolResult, {
					call_id: clip(event.tool_call_id, ID_MAX),
					tool: clip(event.tool, ID_MAX),
					is_error: event.is_error,
					output_preview: clip(event.output_preview, TOOL_TEXT_MAX),
				});
				break;
			case "usage":
				this.#push(usage, event.usage);
				break;
		}
	}

	/** Flushes, then appends `agent_run.finished` from the host's summary. Never throws. */
	async finish(summary: AgentRunSummary): Promise<void> {
		this.#finished = true;
		this.#finals.push(...this.#open);
		this.#open.clear();
		this.#push(agentRunFinished, {
			outcome: summary.outcome,
			turns: summary.turns,
			usage: summary.usage,
			cost_usd: summary.costUsd,
			...(summary.harnessVersion ? { harness_version: clip(summary.harnessVersion, ID_MAX) } : {}),
			...(summary.message ? { message: clip(summary.message, 2000) } : {}),
			...(summary.invalidLines ? { invalid_lines: summary.invalidLines } : {}),
		});
		if (await this.#flush()) return;
		// Whatever kept the stream from being written, the run's outcome and cost still belong in the log.
		this.#queue = this.#queue.filter(lifecycle);
		await this.#flush();
	}

	#push(type: Pending["type"], payload: unknown): void {
		const parsed = type.payload.safeParse(payload);
		if (!parsed.success) {
			warn("agent run event dropped: invalid payload", { agentRunId: this.id, type: type.type });
			return;
		}
		const event = { type, subject: this.#subject, source: this.#source, payload: parsed.data };
		if (this.#queue.length >= MAX_QUEUED && !lifecycle(event)) {
			this.#dropped++;
			return;
		}
		this.#queue.push(event);
		this.#schedule();
	}

	/** After `finish`, nothing retries: its own flushes are the last. */
	#schedule(): void {
		if (this.#finished) return;
		this.#timer ??= setTimeout(() => void this.#flush(), FLUSH_MS).unref();
	}

	#flush(): Promise<boolean> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#writing = this.#writing.then(() => this.#write());
		return this.#writing;
	}

	/** One transaction: deltas, then log events, then finals, so a message's final follows its last delta. */
	async #write(): Promise<boolean> {
		const events = this.#queue;
		const deltas = this.#deltas;
		const finals = this.#finals;
		if (!events.length && !deltas.size && !finals.length) return true;
		this.#queue = [];
		this.#deltas = new Map();
		this.#finals = [];
		try {
			await this.#db.withTx(async (tx) => {
				for (const [messageId, text] of deltas) {
					const localSeq = ++this.#localSeq;
					for (const [part, chunk] of chunks(clean(text)).entries()) {
						await notify(tx, {
							type: "delta",
							stream: this.stream,
							subject: this.#subject ?? null,
							message_id: messageId,
							local_seq: localSeq,
							part,
							text: chunk,
						});
					}
				}
				await appendMany(tx, this.stream, events);
				for (const messageId of finals) await notify(tx, { type: "final", stream: this.stream, message_id: messageId });
			});
		} catch (error) {
			// Deltas are only worth sending live; the log events wait for the next write.
			const requeued = [...events, ...this.#queue];
			this.#queue = requeued.filter((event, index) => index < MAX_QUEUED || lifecycle(event));
			this.#dropped += requeued.length - this.#queue.length;
			this.#finals = [...finals, ...this.#finals];
			warn("agent run events not recorded", { agentRunId: this.id, queued: this.#queue.length, error: errorMessage(error) });
			this.#schedule();
			return false;
		}
		if (this.#dropped) {
			warn("agent run events dropped while the database was unreachable", { agentRunId: this.id, dropped: this.#dropped });
			this.#dropped = 0;
		}
		return true;
	}
}

/** The run's first and last events, which the bounded queue never drops. */
const lifecycle = (event: Pending) => event.type === agentRunStarted || event.type === agentRunFinished;

async function notify(tx: Tx, notice: LiveNotice): Promise<void> {
	await tx.query("select pg_notify($1, $2)", [LIVE_CHANNEL, JSON.stringify(notice)]);
}

/** Splits text into parts whose JSON encoding fits MAX_PART_BYTES, never inside a character. */
function chunks(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	let bytes = 0;
	for (const char of text) {
		const size = Buffer.byteLength(JSON.stringify(char)) - 2;
		if (bytes + size > MAX_PART_BYTES) {
			parts.push(current);
			current = "";
			bytes = 0;
		}
		current += char;
		bytes += size;
	}
	if (current) parts.push(current);
	return parts;
}

/** Postgres text and JSON reject NUL characters and unpaired surrogates, which model and tool output can contain. */
function clean(text: string): string {
	return text.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\ufffd");
}
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function clip(text: string, max: number): string {
	const safe = clean(text);
	if (safe.length <= max) return safe;
	let end = max - TRUNCATED.length;
	if (/[\ud800-\udbff]/.test(safe.charAt(end - 1))) end--;
	return safe.slice(0, end) + TRUNCATED;
}

function warn(msg: string, fields: Record<string, unknown>): void {
	console.error(JSON.stringify({ level: "warn", msg, ...fields }));
}
