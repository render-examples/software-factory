import { randomUUID } from "node:crypto";
import { appendEvent } from "../store/index.js";

export interface SpanHandle {
	spanId: string;
	end(payload?: Record<string, unknown>): Promise<void>;
}

/**
 * Open a span. The returned handle's `end()` closes it.
 * Telemetry failures are swallowed so they never fail a run.
 */
export async function startSpan(
	runId: string,
	type: string,
	opts: {
		stage?: string;
		parentSpanId?: string;
		payload?: Record<string, unknown>;
	} = {},
): Promise<SpanHandle> {
	const spanId = randomUUID();
	try {
		await appendEvent({
			runId,
			type,
			stage: opts.stage,
			spanId,
			parentSpanId: opts.parentSpanId,
			phase: "start",
			payload: opts.payload,
		});
	} catch (err) {
		console.error(`telemetry: failed to start span ${type}:`, err);
	}
	return {
		spanId,
		async end(payload?: Record<string, unknown>): Promise<void> {
			try {
				await appendEvent({
					runId,
					type,
					stage: opts.stage,
					spanId,
					parentSpanId: opts.parentSpanId,
					phase: "end",
					payload,
				});
			} catch (err) {
				console.error(`telemetry: failed to end span ${type}:`, err);
			}
		},
	};
}

/** Emit a single point event. Never throws. */
export async function point(
	runId: string,
	type: string,
	payload?: Record<string, unknown>,
	opts: { parentSpanId?: string; stage?: string } = {},
): Promise<void> {
	try {
		await appendEvent({
			runId,
			type,
			stage: opts.stage,
			spanId: randomUUID(),
			parentSpanId: opts.parentSpanId,
			phase: "point",
			payload,
		});
	} catch (err) {
		console.error(`telemetry: failed to emit point ${type}:`, err);
	}
}
