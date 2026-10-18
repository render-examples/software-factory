/** One row in the append-only `events` table. Observability, cost, and evals read these; no workflow decision does. */
export interface FactoryEvent {
	/** The root task run of the phase (or the gateway's delivery id for deliveries that started nothing). */
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
