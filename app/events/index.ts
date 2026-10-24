/** One telemetry event: how a task run or an agent run ended. Nothing reads these back to decide what a run does. */
export interface FactoryEvent {
	/** The root task run of the task. */
	traceId: string;
	/** The task run the event describes. */
	runId?: string;
	/** "owner/name" */
	repo?: string;
	/** "issue#12" or "pr#34" */
	subject?: string;
	type: "run.finished" | "agent.finished";
	payload: Record<string, unknown>;
}

/** Writes the event to stdout as one JSON line, where Render logs and log streams pick it up. Never throws. */
export function emit(event: FactoryEvent): void {
	const { type, payload, ...ids } = event;
	try {
		console.log(JSON.stringify({ level: "info", event: type, ...ids, ...payload }));
	} catch (error) {
		console.error(
			JSON.stringify({ level: "warn", msg: "event dropped", event: type, error: error instanceof Error ? error.message : String(error) }),
		);
	}
}
