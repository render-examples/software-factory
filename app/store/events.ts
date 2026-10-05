import { db } from "./pool.js";
import type { RunEventRecord } from "./types.js";

export async function appendEvent(input: {
	runId: string;
	type: string;
	stage?: string;
	spanId?: string;
	parentSpanId?: string;
	phase?: "start" | "end" | "point";
	payload?: Record<string, unknown>;
}): Promise<string> {
	const { rows } = await db().query(
		`INSERT INTO run_events (run_id, type, stage, span_id, parent_span_id, phase, payload)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		[
			input.runId,
			input.type,
			input.stage ?? null,
			input.spanId ?? null,
			input.parentSpanId ?? null,
			input.phase ?? null,
			input.payload ? JSON.stringify(input.payload) : null,
		],
	);
	return String(rows[0].id);
}

export async function listEventsByRun(runId: string): Promise<RunEventRecord[]> {
	const { rows } = await db().query(
		`SELECT id, run_id, type, stage, span_id, parent_span_id, phase, payload, created_at
		 FROM run_events WHERE run_id = $1 ORDER BY id`,
		[runId],
	);
	return rows.map((row: Record<string, unknown>) => ({
		id: String(row.id),
		runId: row.run_id as string,
		type: row.type as string,
		stage: (row.stage as string) ?? null,
		spanId: (row.span_id as string) ?? null,
		parentSpanId: (row.parent_span_id as string) ?? null,
		phase: (row.phase as "start" | "end" | "point") ?? null,
		payload: (row.payload as Record<string, unknown>) ?? null,
		createdAt: (row.created_at as Date).toISOString(),
	}));
}
