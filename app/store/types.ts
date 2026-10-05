export type RunStatus =
	| "queued"
	| "dispatched"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type DeliveryOutcome =
	| "accepted"
	| "ignored"
	| "duplicate_active_run"
	| "invalid";

export type SubjectKind = "issue" | "pull_request";

export interface RunRecord {
	id: string;
	repo: string;
	subjectKind: SubjectKind;
	subjectNumber: number;
	workflow: string;
	status: RunStatus;
	stage: string | null;
	outcome: string | null;
	result: Record<string, unknown> | null;
	summary: string | null;
	trigger: Record<string, unknown> | null;
	input: Record<string, unknown> | null;
	previousRunId: string | null;
	cancelRequestedAt: string | null;
	dispatchAttempts: number;
	dispatchAfter: string | null;
	dispatchedAt: string | null;
	heartbeatAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	costUsd: number;
	createdAt: string;
	updatedAt: string;
}

export interface DeliveryRecord {
	deliveryId: string;
	event: string;
	action: string;
	outcome: DeliveryOutcome;
	detail: Record<string, unknown> | null;
	receivedAt: string;
}

export interface RunEventRecord {
	id: string;
	runId: string;
	type: string;
	stage: string | null;
	spanId: string | null;
	parentSpanId: string | null;
	phase: "start" | "end" | "point" | null;
	payload: Record<string, unknown> | null;
	createdAt: string;
}

export interface SandboxRecord {
	id: string;
	providerId: string | null;
	status: string;
	baseSha: string | null;
	lockfileHash: string | null;
	runId: string | null;
	createdAt: string;
	readyAt: string | null;
	expiresAt: string | null;
	leasedAt: string | null;
	releasedAt: string | null;
}

export interface ArtifactRecord {
	id: string;
	runId: string;
	kind: string;
	contentType: string;
	size: number;
	sha256: string;
	linkTokenHash: string | null;
	createdAt: string;
	expiresAt: string;
}
