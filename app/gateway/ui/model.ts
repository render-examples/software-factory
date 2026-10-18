import type { StoredEvent, TraceSummary } from "../../events/index.js";

/** What the trace UI reads. Injected so the gateway is testable without Postgres. */
export interface EventsReader {
	listTraces(options: { repo?: string; limit: number; before?: Date }): Promise<TraceSummary[]>;
	traceEvents(traceId: string): Promise<StoredEvent[]>;
	recentEvents(options: {
		types?: string[];
		traceIds?: string[];
		repo?: string;
		limit: number;
		before?: Date;
	}): Promise<StoredEvent[]>;
}

/** The event types the trace list summarizes. */
export const SUMMARY_TYPES = ["delivery.received", "run.started", "run.finished"];

type Payload = Record<string, unknown>;

export function str(payload: Payload | undefined, key: string): string | undefined {
	const value = payload?.[key];
	return typeof value === "string" ? value : undefined;
}

export function num(payload: Payload | undefined, key: string): number | undefined {
	const value = payload?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(payload: Payload | undefined, key: string): Payload | undefined {
	const value = payload?.[key];
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Payload) : undefined;
}

/** One row of the trace list. */
export interface TraceListItem {
	traceId: string;
	repo: string | null;
	subject: string | null;
	/** The phase, or the task a delivery tried to start. */
	phase?: string;
	/** running, done, failed, rejected; or the delivery outcome for traces that never started a run. */
	state?: string;
	outcome?: string;
	costUsd?: number;
	durationMs?: number;
	startedAt: Date;
	lastAt: Date;
	eventCount: number;
}

export function summarizeTraces(traces: TraceSummary[], events: StoredEvent[]): TraceListItem[] {
	const byTrace = new Map<string, StoredEvent[]>();
	for (const event of events) {
		const list = byTrace.get(event.traceId) ?? [];
		list.push(event);
		byTrace.set(event.traceId, list);
	}
	return traces.map((trace) => {
		const own = (byTrace.get(trace.traceId) ?? []).sort(byId);
		const started = own.find((e) => e.type === "run.started");
		const finished = [...own].reverse().find((e) => e.type === "run.finished");
		const delivery = [...own].reverse().find((e) => e.type === "delivery.received");
		const item: TraceListItem = {
			traceId: trace.traceId,
			repo: trace.repo,
			subject: trace.subject,
			startedAt: trace.firstAt,
			lastAt: trace.lastAt,
			eventCount: trace.eventCount,
		};
		if (started || finished) {
			item.phase = str(finished?.payload, "phase") ?? str(started?.payload, "phase");
			item.state = finished ? (str(finished.payload, "state") ?? "finished") : "running";
			item.outcome = str(finished?.payload, "outcome");
			item.costUsd = num(finished?.payload, "costUsd");
			item.durationMs = num(finished?.payload, "durationMs");
		} else if (delivery) {
			item.phase = str(delivery.payload, "task");
			item.state = str(delivery.payload, "outcome");
			item.outcome = str(delivery.payload, "reason");
		}
		return item;
	});
}

export interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type TimelineItem =
	| {
			kind: "delivery";
			at: Date;
			event?: string;
			action?: string;
			outcome?: string;
			reason?: string;
			task?: string;
			deliveryId?: string;
	  }
	| { kind: "run.started"; at: Date; runId?: string; phase?: string; actor?: string }
	| {
			kind: "run.finished";
			at: Date;
			runId?: string;
			phase?: string;
			state?: string;
			outcome?: string;
			costUsd?: number;
			durationMs?: number;
			error?: string;
	  }
	| {
			kind: "agent";
			at: Date;
			runId?: string;
			agentId?: string;
			model?: string;
			where?: string;
			/** Undefined while the call is still running (no agent.finished yet). */
			outcome?: string;
			turns?: number;
			tokens?: TokenCounts;
			costUsd?: number;
			durationMs?: number;
			message?: string;
	  }
	| { kind: "other"; at: Date; runId?: string; type: string };

export interface TraceView {
	traceId: string;
	repo?: string;
	subject?: string;
	items: TimelineItem[];
	totals: {
		costUsd: number;
		agentCostUsd: number;
		agentCalls: number;
		/** From run.finished when a run finished; otherwise first-to-last event. */
		durationMs: number;
		durationFromRun: boolean;
		tokens: TokenCounts;
	};
	firstAt?: Date;
	lastAt?: Date;
}

function tokensOf(payload: Payload): TokenCounts | undefined {
	const usage = obj(payload, "usage");
	if (!usage) return undefined;
	return {
		input: num(usage, "input_tokens") ?? 0,
		output: num(usage, "output_tokens") ?? 0,
		cacheRead: num(usage, "cache_read_tokens") ?? 0,
		cacheWrite: num(usage, "cache_write_tokens") ?? 0,
	};
}

function byId(a: StoredEvent, b: StoredEvent): number {
	const x = BigInt(/^\d+$/.test(a.id) ? a.id : "0");
	const y = BigInt(/^\d+$/.test(b.id) ? b.id : "0");
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Folds a trace's events into a timeline, pairing each agent.finished with its agent.started. */
export function buildTrace(traceId: string, events: StoredEvent[]): TraceView {
	const sorted = [...events].sort(byId);
	const items: TimelineItem[] = [];
	const open = new Map<string, Extract<TimelineItem, { kind: "agent" }>[]>();
	const totals: TraceView["totals"] = {
		costUsd: 0,
		agentCostUsd: 0,
		agentCalls: 0,
		durationMs: 0,
		durationFromRun: false,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let runCost: number | undefined;
	let runDuration: number | undefined;

	for (const event of sorted) {
		const p = event.payload ?? {};
		const at = event.createdAt;
		switch (event.type) {
			case "delivery.received":
				items.push({
					kind: "delivery",
					at,
					event: str(p, "event"),
					action: str(p, "action"),
					outcome: str(p, "outcome"),
					reason: str(p, "reason"),
					task: str(p, "task"),
					deliveryId: str(p, "deliveryId"),
				});
				break;
			case "run.started":
				items.push({ kind: "run.started", at, runId: event.runId, phase: str(p, "phase"), actor: str(p, "actor") });
				break;
			case "run.finished": {
				const costUsd = num(p, "costUsd");
				const durationMs = num(p, "durationMs");
				if (costUsd !== undefined) runCost = (runCost ?? 0) + costUsd;
				if (durationMs !== undefined) runDuration = (runDuration ?? 0) + durationMs;
				items.push({
					kind: "run.finished",
					at,
					runId: event.runId,
					phase: str(p, "phase"),
					state: str(p, "state"),
					outcome: str(p, "outcome"),
					costUsd,
					durationMs,
					error: str(p, "error"),
				});
				break;
			}
			case "agent.started": {
				const item: Extract<TimelineItem, { kind: "agent" }> = {
					kind: "agent",
					at,
					runId: event.runId,
					agentId: str(p, "agentId"),
					model: str(p, "model"),
					where: str(p, "where"),
				};
				items.push(item);
				const key = `${event.runId ?? ""}\u0000${item.agentId ?? ""}`;
				open.set(key, [...(open.get(key) ?? []), item]);
				totals.agentCalls++;
				break;
			}
			case "agent.finished": {
				const agentId = str(p, "agentId");
				const key = `${event.runId ?? ""}\u0000${agentId ?? ""}`;
				const pending = open.get(key) ?? [];
				let item = pending.shift();
				if (!item) {
					item = { kind: "agent", at, runId: event.runId, agentId };
					items.push(item);
					totals.agentCalls++;
				} else {
					item.durationMs = at.getTime() - item.at.getTime();
				}
				item.model = str(p, "model") ?? item.model;
				item.outcome = str(p, "outcome") ?? "finished";
				item.turns = num(p, "turns");
				item.tokens = tokensOf(p);
				item.costUsd = num(p, "costUsd");
				item.message = str(p, "message");
				totals.agentCostUsd += item.costUsd ?? 0;
				if (item.tokens) {
					totals.tokens.input += item.tokens.input;
					totals.tokens.output += item.tokens.output;
					totals.tokens.cacheRead += item.tokens.cacheRead;
					totals.tokens.cacheWrite += item.tokens.cacheWrite;
				}
				break;
			}
			default:
				items.push({ kind: "other", at, runId: event.runId, type: event.type });
		}
	}

	const firstAt = sorted[0]?.createdAt;
	const lastAt = sorted.at(-1)?.createdAt;
	totals.costUsd = runCost ?? totals.agentCostUsd;
	totals.durationFromRun = runDuration !== undefined;
	totals.durationMs = runDuration ?? (firstAt && lastAt ? lastAt.getTime() - firstAt.getTime() : 0);
	return {
		traceId,
		repo: sorted.find((e) => e.repo)?.repo,
		subject: sorted.find((e) => e.subject)?.subject,
		items,
		totals,
		firstAt,
		lastAt,
	};
}

/** "issue#12" or "pr#34" on GitHub; undefined for anything else. */
export function subjectUrl(repo: string | null | undefined, subject: string | null | undefined): string | undefined {
	if (!repo || !subject || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined;
	const match = subject.match(/^(issue|pr)#(\d+)$/);
	if (!match) return undefined;
	return `https://github.com/${repo}/${match[1] === "pr" ? "pull" : "issues"}/${match[2]}`;
}

export function formatCost(usd: number | undefined): string {
	return usd === undefined ? "—" : `$${usd.toFixed(4)}`;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatTime(date: Date | undefined): string {
	return date ? date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z") : "—";
}

export function ago(date: Date, now = Date.now()): string {
	const ms = now - date.getTime();
	if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function formatTokens(tokens: TokenCounts | undefined): string {
	if (!tokens) return "—";
	const cache = tokens.cacheRead + tokens.cacheWrite;
	return `${tokens.input.toLocaleString("en-US")} in / ${tokens.output.toLocaleString("en-US")} out${cache ? ` / ${cache.toLocaleString("en-US")} cache` : ""}`;
}
