/** One row in the append-only `events` table. Most are telemetry; `run.claimed` coordinates stage ownership. */
export interface FactoryEvent {
	/** The root task run of the stage (or the gateway's delivery id for deliveries that started nothing). */
	traceId: string;
	/** The task run that emitted the event, when there is one. */
	runId?: string;
	/** "owner/name" */
	repo?: string;
	/** "issue#12" or "pr#34" */
	subject?: string;
	/** Dotted name: delivery.received, run.started, run.finished, agent.started, agent.finished, cost, ... */
	type: string;
	payload?: Record<string, unknown>;
}

/** A durable, ordered claim on one issue or PR. The greatest event ID is current. */
export interface RunClaim {
	/** `events.id`, used as the fencing token. */
	id: string;
	runId: string;
	repo: string;
	subject: string;
}

export interface RunClaimInput {
	traceId: string;
	runId: string;
	repo: string;
	subject: string;
	stage: string;
	actor: string;
}
