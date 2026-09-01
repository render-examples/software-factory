export type RunKind = "workflow" | "agent" | "task";

export type RunStatus =
	| "pending"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export interface NewRun {
	id: string;
	kind: RunKind;
	name: string;
	rootRunId: string;
	parentRunId?: string;
	parentStepKey?: string;
	triggerType?: string;
	triggerRef?: string;
	definitionVersion?: string;
	input?: unknown;
}

export interface RunRecord extends NewRun {
	status: RunStatus;
	result?: unknown;
	errorCode?: string;
	failureCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalModelCalls: number;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	updatedAt: string;
}

export interface ExecutionHandle {
	id: string;
	runId: string;
	attempt: number;
	token: string;
	fence: number;
	leaseExpiresAt: string;
}

export type BeginExecutionResult =
	| { kind: "acquired"; execution: ExecutionHandle }
	| { kind: "busy" };

export type ReplayPolicy = "safe" | "guarded";
export type StepStatus = "started" | "completed" | "failed" | "invalidated";

export interface RunStep<T = unknown> {
	runId: string;
	key: string;
	generation: number;
	status: StepStatus;
	replayPolicy: ReplayPolicy;
	executionId?: string;
	value?: T;
	errorCode?: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
}

export type BeginStepResult<T> =
	| { kind: "execute"; generation: number }
	| { kind: "reuse"; value: T; generation: number }
	| { kind: "blocked"; reason: "interrupted_guarded_step" }
	| { kind: "busy" };

export type RunEventCategory =
	| "lifecycle"
	| "execution"
	| "step"
	| "agent"
	| "external";

export interface NewRunEvent {
	runId: string;
	category: RunEventCategory;
	type: string;
	executionId?: string;
	stepKey?: string;
	agentName?: string;
	payload?: Record<string, unknown>;
	version?: number;
	idempotencyKey?: string;
	correlationId?: string;
	causationId?: string;
}

export interface StoredRunEvent extends NewRunEvent {
	id: string;
	position: number;
	seq: number;
	ts: string;
	payload: Record<string, unknown>;
	version: number;
	payloadDigest: string;
}

export type AppendEventResult =
	| { kind: "appended"; event: StoredRunEvent }
	| { kind: "duplicate"; event: StoredRunEvent };

export interface RunLink {
	runId: string;
	kind: string;
	externalId: string;
	url?: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

export interface RunQuery {
	kind?: RunKind;
	name?: string;
	status?: RunStatus;
	rootRunId?: string;
	parentRunId?: string;
	triggerType?: string;
	triggerRef?: string;
	limit?: number;
	before?: string;
}

export interface RunStore {
	ensureRun(run: NewRun): Promise<RunRecord>;
	getRun(runId: string): Promise<RunRecord | null>;
	listRuns(query?: RunQuery): Promise<RunRecord[]>;
	getTerminal<T>(
		runId: string,
	): Promise<{ found: true; value: T | undefined } | { found: false }>;
	getStep<T>(runId: string, key: string): Promise<RunStep<T> | null>;
	beginExecution(
		runId: string,
		executionId: string,
		ttlSeconds: number,
	): Promise<BeginExecutionResult>;
	refreshExecution(
		execution: ExecutionHandle,
		ttlSeconds: number,
	): Promise<ExecutionHandle>;
	releaseExecution(execution: ExecutionHandle): Promise<void>;
	beginStep<T>(
		runId: string,
		key: string,
		replayPolicy: ReplayPolicy,
		execution: ExecutionHandle,
	): Promise<BeginStepResult<T>>;
	completeStep<T>(
		runId: string,
		key: string,
		value: T,
		execution: ExecutionHandle,
	): Promise<T>;
	failStep(
		runId: string,
		key: string,
		errorCode: string,
		execution: ExecutionHandle,
	): Promise<void>;
	invalidateSteps(
		runId: string,
		keys: readonly string[],
		reason: string,
		execution: ExecutionHandle,
	): Promise<void>;
	incrementFailureCount(
		runId: string,
		execution: ExecutionHandle,
	): Promise<number>;
	recordUsage(
		runId: string,
		inputTokens: number,
		outputTokens: number,
		model: string,
		execution?: ExecutionHandle,
	): Promise<void>;
	addLink(link: Omit<RunLink, "createdAt">): Promise<RunLink>;
	listLinks(runId: string): Promise<RunLink[]>;
	findRunsByLink(
		kind: string,
		externalId: string,
		limit?: number,
	): Promise<RunRecord[]>;
}

export interface RunEventStore {
	append(event: NewRunEvent): Promise<AppendEventResult>;
	readRun(
		runId: string,
		options?: { afterSeq?: number; limit?: number },
	): Promise<StoredRunEvent[]>;
	scan(options?: {
		afterPosition?: number;
		limit?: number;
	}): Promise<StoredRunEvent[]>;
}

/** Optional downstream sink for search, analytics, or alternate viewers. */
export interface RunEventExporter {
	export(events: readonly StoredRunEvent[]): Promise<void>;
}

export type InboxState = "pending" | "dispatched" | "completed";

export type AcceptDeliveryResult =
	| { kind: "accepted"; runId: string }
	| { kind: "pending"; runId: string }
	| { kind: "dispatched"; runId: string }
	| { kind: "completed"; runId: string }
	| { kind: "subject_busy"; activeRunId?: string };

export interface AcceptDeliveryInput {
	provider: string;
	deliveryId: string;
	payloadDigest: string;
	subjectKey?: string;
	run: NewRun;
	deliveryTtlSeconds: number;
	subjectLeaseTtlSeconds?: number;
}

export interface InboxStore {
	accept(input: AcceptDeliveryInput): Promise<AcceptDeliveryResult>;
	markDispatched(provider: string, deliveryId: string): Promise<void>;
	abandon(provider: string, deliveryId: string): Promise<void>;
	getRunId(provider: string, deliveryId: string): Promise<string | null>;
}

export interface LeaseStore {
	tryAcquire(
		resourceKey: string,
		ownerId: string,
		ttlSeconds: number,
	): Promise<LeaseHandle | null>;
	refresh(
		lease: LeaseHandle,
		ttlSeconds: number,
	): Promise<LeaseHandle>;
	release(lease: LeaseHandle): Promise<void>;
}

export interface LeaseHandle {
	resourceKey: string;
	ownerId: string;
	token: string;
	fence: number;
	expiresAt: string;
}

export interface ArtifactRecord {
	ref: string;
	runId: string;
	namespace: string;
	content: string;
	mediaType: string;
	sizeBytes: number;
	sha256: string;
	expiresAt: string;
}

export interface ArtifactStore {
	put(input: {
		runId: string;
		namespace: string;
		content: string;
		mediaType?: string;
		ttlSeconds: number;
	}): Promise<string>;
	get(ref: string, refreshTtlSeconds?: number): Promise<ArtifactRecord | null>;
	delete(ref: string): Promise<void>;
}

export interface ConversationMessage {
	id: string;
	conversationId: string;
	runId?: string;
	role: "user" | "assistant" | "system";
	content: string;
	occurredAt: string;
}

export interface ConversationStore {
	appendOnce(
		provider: string,
		externalConversationId: string,
		message: Omit<ConversationMessage, "conversationId">,
		options: { ttlSeconds: number; maxMessages: number },
	): Promise<boolean>;
	list(
		provider: string,
		externalConversationId: string,
		limit: number,
		refreshTtlSeconds?: number,
	): Promise<ConversationMessage[]>;
	putReply(
		provider: string,
		operationId: string,
		runId: string,
		content: string,
		ttlSeconds: number,
	): Promise<void>;
	getReply(
		provider: string,
		operationId: string,
		refreshTtlSeconds?: number,
	): Promise<string | null>;
	markDelivered(
		provider: string,
		operationId: string,
		providerRef?: string,
	): Promise<void>;
	wasDelivered(provider: string, operationId: string): Promise<boolean>;
}

export interface KnowledgeStore {
	get(
		namespace: string,
		key: string,
		refreshTtlSeconds?: number,
	): Promise<string | null>;
	put(
		namespace: string,
		key: string,
		content: string,
		ttlSeconds?: number,
	): Promise<void>;
	appendLines(
		namespace: string,
		key: string,
		lines: readonly string[],
		options: { maxChars: number; ttlSeconds?: number },
	): Promise<void>;
}

export interface CompleteRunInput {
	runId: string;
	execution: ExecutionHandle;
	status: "completed" | "failed" | "cancelled";
	result?: unknown;
	errorCode?: string;
}

export interface RetentionOptions {
	now?: Date;
	eventRetentionDays: number;
	runRetentionDays: number;
	batchSize?: number;
}

export interface RetentionResult {
	eventsDeleted: number;
	runsDeleted: number;
	expiredRowsDeleted: number;
}

export interface FactoryStore {
	readonly runs: RunStore;
	readonly events: RunEventStore;
	readonly inbox: InboxStore;
	readonly leases: LeaseStore;
	readonly artifacts: ArtifactStore;
	readonly conversations: ConversationStore;
	readonly knowledge: KnowledgeStore;
	health(): Promise<void>;
	verifySchema(): Promise<void>;
	completeRun(input: CompleteRunInput): Promise<void>;
	cleanup(options: RetentionOptions): Promise<RetentionResult>;
	close(): Promise<void>;
}

export interface FactoryStoreOptions {
	now?: () => Date;
	randomId?: () => string;
}

export class StoreConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreConflictError";
	}
}

export class LeaseLostError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseLostError";
	}
}

export class InterruptedStepError extends Error {
	constructor(readonly stepKey: string) {
		super(`Step "${stepKey}" was interrupted and cannot be replayed safely`);
		this.name = "InterruptedStepError";
	}
}
