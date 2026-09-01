import { createHash } from "node:crypto";
import type {
	AcceptDeliveryInput,
	AcceptDeliveryResult,
	AppendEventResult,
	ArtifactRecord,
	ArtifactStore,
	BeginExecutionResult,
	BeginStepResult,
	CompleteRunInput,
	ConversationMessage,
	ConversationStore,
	ExecutionHandle,
	FactoryStore,
	FactoryStoreOptions,
	InboxState,
	InboxStore,
	KnowledgeStore,
	LeaseHandle,
	LeaseStore,
	NewRun,
	NewRunEvent,
	ReplayPolicy,
	RetentionOptions,
	RetentionResult,
	RunEventStore,
	RunLink,
	RunQuery,
	RunRecord,
	RunStep,
	RunStore,
	StoredRunEvent,
} from "./contracts.js";
import {
	LeaseLostError,
	StoreConflictError,
} from "./contracts.js";
import {
	artifactRef,
	assertEventPayload,
	assertPositiveInteger,
	assertStoreKey,
	cloneValue,
	defaultRandomId,
	expiresAt,
	normalizeJsonValue,
	valueDigest,
} from "./values.js";

interface InternalRun extends RunRecord {
	nextEventSeq: number;
	nextExecutionFence: number;
	hasResult: boolean;
}

interface InternalExecution extends ExecutionHandle {
	status: "running" | "completed" | "failed" | "lost";
	heartbeatAt: string;
	finishedAt?: string;
	failureCounted: boolean;
	errorCode?: string;
}

interface InternalInbox {
	provider: string;
	deliveryId: string;
	runId: string;
	subjectKey?: string;
	payloadDigest: string;
	status: InboxState;
	expiresAt: string;
}

interface InternalLease extends LeaseHandle {}

interface InternalConversation {
	id: string;
	provider: string;
	externalId: string;
	expiresAt: string;
	messages: ConversationMessage[];
}

interface InternalReply {
	runId?: string;
	content: string;
	status: "pending" | "delivered";
	providerRef?: string;
	expiresAt: string;
}

interface InternalKnowledge {
	content: string;
	version: number;
	expiresAt?: string;
}

export class MemoryFactoryStore implements FactoryStore {
	private readonly now: () => Date;
	private readonly randomId: () => string;
	private readonly runRecords = new Map<string, InternalRun>();
	private readonly runEvents = new Map<string, StoredRunEvent[]>();
	private readonly eventIdempotency = new Map<string, StoredRunEvent>();
	private readonly executions = new Map<string, InternalExecution[]>();
	private readonly steps = new Map<string, RunStep>();
	private readonly links = new Map<string, RunLink[]>();
	private readonly inboxRecords = new Map<string, InternalInbox>();
	private readonly leaseRecords = new Map<string, InternalLease>();
	private readonly artifactRecords = new Map<string, ArtifactRecord>();
	private readonly conversationRecords = new Map<string, InternalConversation>();
	private readonly replies = new Map<string, InternalReply>();
	private readonly knowledgeRecords = new Map<string, InternalKnowledge>();
	private readonly trimmedRunEvents = new Set<string>();
	private nextEventPosition = 0;
	private nextLeaseFence = 0;

	readonly events: RunEventStore = {
		append: async (event) => this.appendEvent(event),
		readRun: async (runId, options) => {
			assertStoreKey(runId, "run ID");
			const afterSeq = options?.afterSeq ?? 0;
			const limit = boundedLimit(options?.limit);
			return (this.runEvents.get(runId) ?? [])
				.filter((event) => event.seq > afterSeq)
				.slice(0, limit)
				.map(cloneValue);
		},
		scan: async (options) => {
			const afterPosition = options?.afterPosition ?? 0;
			const limit = boundedLimit(options?.limit);
			return [...this.runEvents.values()]
				.flat()
				.filter((event) => event.position > afterPosition)
				.sort((a, b) => a.position - b.position)
				.slice(0, limit)
				.map(cloneValue);
		},
	};

	readonly runs: RunStore = {
		ensureRun: async (run) => clonePublicRun(this.ensureRun(run)),
		getRun: async (runId) => {
			assertStoreKey(runId, "run ID");
			const run = this.runRecords.get(runId);
			return run ? clonePublicRun(run) : null;
		},
		listRuns: async (query) => this.listRuns(query),
		getTerminal: async <T>(runId: string) => {
			assertStoreKey(runId, "run ID");
			const run = this.runRecords.get(runId);
			if (!run || !isTerminal(run.status)) return { found: false };
			return {
				found: true,
				value: run.hasResult
					? (cloneValue(run.result) as T)
					: undefined,
			};
		},
		getStep: async <T>(runId: string, key: string) => {
			assertStoreKey(runId, "run ID");
			assertStoreKey(key, "step key");
			const step = this.steps.get(stepMapKey(runId, key));
			return step ? (cloneValue(step) as RunStep<T>) : null;
		},
		beginExecution: async (runId, executionId, ttlSeconds) =>
			this.beginExecution(runId, executionId, ttlSeconds),
		refreshExecution: async (execution, ttlSeconds) =>
			this.refreshExecution(execution, ttlSeconds),
		releaseExecution: async (execution) => this.releaseExecution(execution),
		beginStep: async <T>(
			runId: string,
			key: string,
			replayPolicy: ReplayPolicy,
			execution: ExecutionHandle,
		) => this.beginStep<T>(runId, key, replayPolicy, execution),
		completeStep: async <T>(
			runId: string,
			key: string,
			value: T,
			execution: ExecutionHandle,
		) => this.completeStep(runId, key, value, execution),
		failStep: async (runId, key, errorCode, execution) =>
			this.failStep(runId, key, errorCode, execution),
		invalidateSteps: async (runId, keys, reason, execution) =>
			this.invalidateSteps(runId, keys, reason, execution),
		incrementFailureCount: async (runId, execution) =>
			this.incrementFailureCount(runId, execution),
		recordUsage: async (
			runId,
			inputTokens,
			outputTokens,
			model,
			execution,
		) =>
			this.recordUsage(
				runId,
				inputTokens,
				outputTokens,
				model,
				execution,
			),
		addLink: async (link) => this.addLink(link),
		listLinks: async (runId) => {
			assertStoreKey(runId, "run ID");
			return (this.links.get(runId) ?? []).map(cloneValue);
		},
		findRunsByLink: async (kind, externalId, limit) => {
			assertStoreKey(kind, "run link kind");
			assertStoreKey(externalId, "run link external ID");
			const runIds = [...this.links.entries()]
				.filter(([, links]) =>
					links.some(
						(link) =>
							link.kind === kind && link.externalId === externalId,
					),
				)
				.map(([runId]) => runId);
			return [...this.runRecords.values()]
				.filter((run) => runIds.includes(run.id))
				.sort((a, b) =>
					a.createdAt === b.createdAt
						? b.id.localeCompare(a.id)
						: b.createdAt.localeCompare(a.createdAt),
				)
				.slice(0, boundedLimit(limit))
				.map(clonePublicRun);
		},
	};

	readonly inbox: InboxStore = {
		accept: async (input) => this.acceptDelivery(input),
		markDispatched: async (provider, deliveryId) =>
			this.markDispatched(provider, deliveryId),
		abandon: async (provider, deliveryId) =>
			this.abandonDelivery(provider, deliveryId),
		getRunId: async (provider, deliveryId) => {
			assertStoreKey(provider, "delivery provider");
			assertStoreKey(deliveryId, "delivery ID");
			const key = inboxMapKey(provider, deliveryId);
			const record = this.inboxRecords.get(key);
			if (!record) return null;
			if (Date.parse(record.expiresAt) <= this.now().getTime()) return null;
			return record.runId;
		},
	};

	readonly leases: LeaseStore = {
		tryAcquire: async (resourceKey, ownerId, ttlSeconds) =>
			this.acquireLease(resourceKey, ownerId, ttlSeconds),
		refresh: async (lease, ttlSeconds) =>
			this.refreshLease(lease, ttlSeconds),
		release: async (lease) => this.releaseLease(lease),
	};

	readonly artifacts: ArtifactStore = {
		put: async (input) => {
			this.requireRun(input.runId);
			const now = this.now();
			const ref = artifactRef(input.runId, input.namespace);
			const content = input.content;
			const record: ArtifactRecord = {
				ref,
				runId: input.runId,
				namespace: input.namespace,
				content,
				mediaType: input.mediaType ?? "text/plain; charset=utf-8",
				sizeBytes: Buffer.byteLength(content, "utf8"),
				sha256: createHash("sha256").update(content).digest("hex"),
				expiresAt: expiresAt(now, input.ttlSeconds).toISOString(),
			};
			this.artifactRecords.set(ref, record);
			return ref;
		},
		get: async (ref, refreshTtlSeconds) => {
			const record = this.artifactRecords.get(ref);
			if (!record) return null;
			const now = this.now();
			if (Date.parse(record.expiresAt) <= now.getTime()) {
				this.artifactRecords.delete(ref);
				return null;
			}
			if (refreshTtlSeconds !== undefined) {
				record.expiresAt = expiresAt(now, refreshTtlSeconds).toISOString();
			}
			return cloneValue(record);
		},
		delete: async (ref) => {
			this.artifactRecords.delete(ref);
		},
	};

	readonly conversations: ConversationStore = {
		appendOnce: async (
			provider,
			externalConversationId,
			message,
			options,
		) =>
			this.appendConversationMessage(
				provider,
				externalConversationId,
				message,
				options,
			),
		list: async (
			provider,
			externalConversationId,
			limit,
			refreshTtlSeconds,
		) =>
			this.listConversationMessages(
				provider,
				externalConversationId,
				limit,
				refreshTtlSeconds,
			),
		putReply: async (provider, operationId, runId, content, ttlSeconds) =>
			this.putReply(provider, operationId, runId, content, ttlSeconds),
		getReply: async (provider, operationId, refreshTtlSeconds) =>
			this.getReply(provider, operationId, refreshTtlSeconds),
		markDelivered: async (provider, operationId, providerRef) =>
			this.markReplyDelivered(provider, operationId, providerRef),
		wasDelivered: async (provider, operationId) =>
			this.replyDelivered(provider, operationId),
	};

	readonly knowledge: KnowledgeStore = {
		get: async (namespace, key, refreshTtlSeconds) =>
			this.getKnowledge(namespace, key, refreshTtlSeconds),
		put: async (namespace, key, content, ttlSeconds) =>
			this.putKnowledge(namespace, key, content, ttlSeconds),
		appendLines: async (namespace, key, lines, options) =>
			this.appendKnowledgeLines(namespace, key, lines, options),
	};

	constructor(options: FactoryStoreOptions = {}) {
		this.now = options.now ?? (() => new Date());
		this.randomId = options.randomId ?? defaultRandomId;
	}

	async health(): Promise<void> {}

	async verifySchema(): Promise<void> {}

	async close(): Promise<void> {}

	async completeRun(input: CompleteRunInput): Promise<void> {
		assertExecutionRun(input.runId, input.execution);
		const run = this.requireRun(input.runId);
		const execution = this.requireExecution(input.execution);
		if (run.status !== "running") {
			throw new StoreConflictError(
				`Run "${input.runId}" is already terminal`,
			);
		}
		const now = this.now().toISOString();
		const result =
			input.result === undefined
				? undefined
				: normalizeJsonValue(input.result);

		this.appendEvent({
			runId: run.id,
			category: "lifecycle",
			type:
				input.status === "completed"
					? "run.completed"
					: input.status === "cancelled"
						? "run.cancelled"
						: "run.failed",
			executionId: execution.id,
			payload: {
				...(input.errorCode ? { errorCode: input.errorCode } : {}),
			},
			idempotencyKey: `run:${run.id}:terminal`,
		});
		run.status = input.status;
		run.hasResult = input.result !== undefined;
		if (input.result === undefined) {
			delete run.result;
		} else {
			run.result = result;
		}
		run.errorCode = input.errorCode;
		run.finishedAt = now;
		run.updatedAt = now;
		execution.status =
			input.status === "completed" ? "completed" : "failed";
		execution.finishedAt = now;

		for (const record of this.inboxRecords.values()) {
			if (record.runId === run.id) record.status = "completed";
		}
		for (const [key, lease] of this.leaseRecords) {
			if (lease.ownerId === run.id || lease.ownerId === execution.id) {
				this.leaseRecords.delete(key);
			}
		}
	}

	async cleanup(options: RetentionOptions): Promise<RetentionResult> {
		assertPositiveInteger(options.eventRetentionDays, "event retention days");
		assertPositiveInteger(options.runRetentionDays, "run retention days");
		if (
			options.batchSize !== undefined &&
			(!Number.isSafeInteger(options.batchSize) || options.batchSize < 1)
		) {
			throw new StoreConflictError("Retention batch size must be positive");
		}
		const now = (options.now ?? this.now()).getTime();
		const eventHorizon =
			now - options.eventRetentionDays * 24 * 60 * 60 * 1_000;
		const runHorizon =
			now - options.runRetentionDays * 24 * 60 * 60 * 1_000;
		let eventsDeleted = 0;
		let runsDeleted = 0;
		let expiredRowsDeleted = 0;

		for (const executions of this.executions.values()) {
			for (const execution of executions) {
				if (
					execution.status !== "running" ||
					Date.parse(execution.leaseExpiresAt) >= now - 60 * 60 * 1_000
				) {
					continue;
				}
				const run = this.runRecords.get(execution.runId);
				if (run?.status !== "running") continue;
				this.appendEvent({
					runId: run.id,
					category: "lifecycle",
					type: "run.failed",
					executionId: execution.id,
					payload: { errorCode: "execution_lease_expired" },
					idempotencyKey: `run:${run.id}:stale-execution`,
				});
				execution.status = "lost";
				execution.errorCode = "execution_lease_expired";
				execution.finishedAt = new Date(now).toISOString();
				run.status = "failed";
				run.errorCode = "execution_lease_expired";
				run.finishedAt = new Date(now).toISOString();
				run.updatedAt = run.finishedAt;
				for (const inbox of this.inboxRecords.values()) {
					if (inbox.runId === run.id) inbox.status = "completed";
				}
				for (const [key, lease] of this.leaseRecords) {
					if (
						lease.ownerId === run.id ||
						lease.ownerId === execution.id
					) {
						this.leaseRecords.delete(key);
					}
				}
			}
		}

		for (const [key, record] of this.inboxRecords) {
			if (Date.parse(record.expiresAt) <= now) {
				const activeExecution = this.executions
					.get(record.runId)
					?.some(
						(execution) =>
							execution.status === "running" &&
							Date.parse(execution.leaseExpiresAt) > now,
					);
				if (activeExecution) continue;
				const run = this.runRecords.get(record.runId);
				if (run && !isTerminal(run.status)) {
					this.appendEvent({
						runId: run.id,
						category: "lifecycle",
						type: "run.cancelled",
						payload: { reason: "delivery_expired" },
						idempotencyKey: `run:${run.id}:delivery-expired`,
					});
					run.status = "cancelled";
					run.errorCode = "delivery_expired";
					run.finishedAt = new Date(now).toISOString();
					run.updatedAt = run.finishedAt;
				}
				if (record.subjectKey) {
					const lease = this.getLiveLease(record.subjectKey);
					if (lease?.ownerId === record.runId) this.releaseLease(lease);
				}
				this.inboxRecords.delete(key);
				expiredRowsDeleted += 1;
			}
		}
		for (const [key, record] of this.leaseRecords) {
			if (Date.parse(record.expiresAt) <= now) {
				this.leaseRecords.delete(key);
				expiredRowsDeleted += 1;
			}
		}
		for (const [key, record] of this.artifactRecords) {
			if (Date.parse(record.expiresAt) <= now) {
				this.artifactRecords.delete(key);
				expiredRowsDeleted += 1;
			}
		}
		for (const [key, record] of this.conversationRecords) {
			if (Date.parse(record.expiresAt) <= now) {
				this.conversationRecords.delete(key);
				expiredRowsDeleted += 1;
			}
		}
		for (const [key, record] of this.replies) {
			if (Date.parse(record.expiresAt) <= now) {
				this.replies.delete(key);
				expiredRowsDeleted += 1;
			}
		}
		for (const [key, record] of this.knowledgeRecords) {
			if (
				record.expiresAt &&
				Date.parse(record.expiresAt) <= now
			) {
				this.knowledgeRecords.delete(key);
				expiredRowsDeleted += 1;
			}
		}

		const batchSize = Math.max(1, options.batchSize ?? 500);
		for (const run of [...this.runRecords.values()]) {
			if (!isTerminal(run.status)) continue;
			const finished = Date.parse(run.finishedAt ?? run.updatedAt);
			if (
				finished < eventHorizon &&
				!this.trimmedRunEvents.has(run.id)
			) {
				const removedEvents = this.runEvents.get(run.id) ?? [];
				const removed = removedEvents.length;
				this.runEvents.delete(run.id);
				for (const event of removedEvents) {
					if (event.idempotencyKey) {
						this.eventIdempotency.delete(
							`${event.runId}\0${event.idempotencyKey}`,
						);
					}
				}
				this.trimmedRunEvents.add(run.id);
				eventsDeleted += removed;
			}
			if (
				run.parentRunId !== undefined ||
				finished >= runHorizon ||
				runsDeleted >= batchSize
			) {
				continue;
			}
			const family = [...this.runRecords.values()].filter(
				(candidate) => candidate.rootRunId === run.id,
			);
			if (
				family.some(
					(candidate) =>
						!isTerminal(candidate.status) ||
						Date.parse(candidate.finishedAt ?? candidate.updatedAt) >=
							runHorizon,
				)
			) {
				continue;
			}
			for (const member of family) {
				for (const event of this.runEvents.get(member.id) ?? []) {
					if (event.idempotencyKey) {
						this.eventIdempotency.delete(
							`${event.runId}\0${event.idempotencyKey}`,
						);
					}
				}
				this.runEvents.delete(member.id);
				this.runRecords.delete(member.id);
				this.executions.delete(member.id);
				this.links.delete(member.id);
				this.trimmedRunEvents.delete(member.id);
				for (const key of this.steps.keys()) {
					if (key.startsWith(`${member.id}\0`)) this.steps.delete(key);
				}
				for (const [ref, artifact] of this.artifactRecords) {
					if (artifact.runId === member.id) {
						this.artifactRecords.delete(ref);
					}
				}
				for (const conversation of this.conversationRecords.values()) {
					for (const message of conversation.messages) {
						if (message.runId === member.id) message.runId = undefined;
					}
				}
				for (const reply of this.replies.values()) {
					if (reply.runId === member.id) reply.runId = undefined;
				}
			}
			runsDeleted += 1;
		}
		return { eventsDeleted, runsDeleted, expiredRowsDeleted };
	}

	private ensureRun(input: NewRun): InternalRun {
		validateRunInput(input);
		const existing = this.runRecords.get(input.id);
		if (existing) {
			if (
				existing.kind !== input.kind ||
				existing.name !== input.name ||
				existing.rootRunId !== input.rootRunId ||
				existing.parentRunId !== input.parentRunId
			) {
				throw new StoreConflictError(
					`Run "${input.id}" already exists with different identity`,
				);
			}
			return existing;
		}
		if (
			input.rootRunId !== input.id &&
			!this.runRecords.has(input.rootRunId)
		) {
			throw new StoreConflictError(
				`Root run "${input.rootRunId}" does not exist`,
			);
		}
		if (input.parentRunId) {
			const parent = this.runRecords.get(input.parentRunId);
			if (!parent) {
				throw new StoreConflictError(
					`Parent run "${input.parentRunId}" does not exist`,
				);
			}
			if (parent.rootRunId !== input.rootRunId) {
				throw new StoreConflictError(
					`Parent run "${input.parentRunId}" belongs to another root`,
				);
			}
		}
		const now = this.now().toISOString();
		const run: InternalRun = {
			...cloneValue(input),
			...(input.input !== undefined
				? { input: normalizeJsonValue(input.input) }
				: {}),
			status: "pending",
			failureCount: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalModelCalls: 0,
			createdAt: now,
			updatedAt: now,
			nextEventSeq: 0,
			nextExecutionFence: 0,
			hasResult: false,
		};
		this.runRecords.set(run.id, run);
		this.appendEvent({
			runId: run.id,
			category: "lifecycle",
			type: "run.created",
			payload: { kind: run.kind, name: run.name },
			idempotencyKey: `run:${run.id}:created`,
		});
		return run;
	}

	private requireRun(runId: string): InternalRun {
		assertStoreKey(runId, "run ID");
		const run = this.runRecords.get(runId);
		if (!run) throw new StoreConflictError(`Run "${runId}" does not exist`);
		return run;
	}

	private listRuns(query: RunQuery = {}): RunRecord[] {
		const limit = boundedLimit(query.limit);
		let runs = [...this.runRecords.values()];
		if (query.kind) runs = runs.filter((run) => run.kind === query.kind);
		if (query.name) runs = runs.filter((run) => run.name === query.name);
		if (query.status) runs = runs.filter((run) => run.status === query.status);
		if (query.rootRunId) {
			runs = runs.filter((run) => run.rootRunId === query.rootRunId);
		}
		if (query.parentRunId) {
			runs = runs.filter((run) => run.parentRunId === query.parentRunId);
		}
		if (query.triggerType) {
			runs = runs.filter((run) => run.triggerType === query.triggerType);
		}
		if (query.triggerRef) {
			runs = runs.filter((run) => run.triggerRef === query.triggerRef);
		}
		runs.sort((a, b) =>
			a.createdAt === b.createdAt
				? b.id.localeCompare(a.id)
				: b.createdAt.localeCompare(a.createdAt),
		);
		if (query.before) {
			const cursor = this.runRecords.get(query.before);
			if (!cursor) return [];
			runs = runs.filter(
				(run) =>
					run.createdAt < cursor.createdAt ||
					(run.createdAt === cursor.createdAt &&
						run.id < cursor.id),
			);
		}
		return runs.slice(0, limit).map(clonePublicRun);
	}

	private assertEventAppendable(event: NewRunEvent): void {
		this.requireRun(event.runId);
		assertStoreKey(event.type, "event type");
		if (
			event.executionId &&
			!this.findExecution(event.runId, event.executionId)
		) {
			throw new StoreConflictError(
				`Execution "${event.executionId}" does not belong to run "${event.runId}"`,
			);
		}
		const payload = normalizeJsonValue(event.payload ?? {});
		assertEventPayload(payload);
		if (!event.idempotencyKey) return;
		assertStoreKey(event.idempotencyKey, "event idempotency key");
		const existing = this.eventIdempotency.get(
			`${event.runId}\0${event.idempotencyKey}`,
		);
		const digest = valueDigest({ type: event.type, payload });
		if (
			existing &&
			(existing.type !== event.type ||
				existing.payloadDigest !== digest)
		) {
			throw new StoreConflictError(
				`Event idempotency key "${event.idempotencyKey}" conflicts`,
			);
		}
	}

	private appendEvent(event: NewRunEvent): AppendEventResult {
		const run = this.requireRun(event.runId);
		assertStoreKey(event.type, "event type");
		if (
			event.executionId &&
			!this.findExecution(event.runId, event.executionId)
		) {
			throw new StoreConflictError(
				`Execution "${event.executionId}" does not belong to run "${event.runId}"`,
			);
		}
		const payload = normalizeJsonValue(event.payload ?? {});
		assertEventPayload(payload);
		const digest = valueDigest({ type: event.type, payload });
		if (event.idempotencyKey) {
			assertStoreKey(event.idempotencyKey, "event idempotency key");
			const idempotencyMapKey = `${event.runId}\0${event.idempotencyKey}`;
			const existing = this.eventIdempotency.get(idempotencyMapKey);
			if (existing) {
				if (
					existing.type !== event.type ||
					existing.payloadDigest !== digest
				) {
					throw new StoreConflictError(
						`Event idempotency key "${event.idempotencyKey}" conflicts`,
					);
				}
				return { kind: "duplicate", event: cloneValue(existing) };
			}
		}
		run.nextEventSeq += 1;
		run.updatedAt = this.now().toISOString();
		this.nextEventPosition += 1;
		this.trimmedRunEvents.delete(event.runId);
		const stored: StoredRunEvent = {
			...cloneValue(event),
			id: this.randomId(),
			position: this.nextEventPosition,
			seq: run.nextEventSeq,
			ts: this.now().toISOString(),
			payload,
			version: event.version ?? 1,
			payloadDigest: digest,
		};
		const events = this.runEvents.get(event.runId) ?? [];
		events.push(stored);
		this.runEvents.set(event.runId, events);
		if (event.idempotencyKey) {
			this.eventIdempotency.set(
				`${event.runId}\0${event.idempotencyKey}`,
				stored,
			);
		}
		return { kind: "appended", event: cloneValue(stored) };
	}

	private beginExecution(
		runId: string,
		executionId: string,
		ttlSeconds: number,
	): BeginExecutionResult {
		const run = this.requireRun(runId);
		if (isTerminal(run.status)) {
			throw new StoreConflictError(`Run "${runId}" is already terminal`);
		}
		assertStoreKey(executionId, "execution ID");
		assertPositiveInteger(ttlSeconds, "execution TTL");
		const now = this.now();
		const executions = this.executions.get(runId) ?? [];
		if (executions.some((execution) => execution.id === executionId)) {
			throw new StoreConflictError(
				`Execution "${executionId}" already exists`,
			);
		}
		const active = executions.find((item) => item.status === "running");
		if (active && Date.parse(active.leaseExpiresAt) > now.getTime()) {
			return { kind: "busy" };
		}
		if (active) {
			active.status = "lost";
			active.finishedAt = now.toISOString();
			this.appendEvent({
				runId,
				category: "execution",
				type: "execution.lost",
				executionId: active.id,
				payload: { attempt: active.attempt },
				idempotencyKey: `execution:${active.id}:lost`,
			});
		}
		run.nextExecutionFence += 1;
		const execution: InternalExecution = {
			id: executionId,
			runId,
			attempt: executions.length + 1,
			token: this.randomId(),
			fence: run.nextExecutionFence,
			leaseExpiresAt: expiresAt(now, ttlSeconds).toISOString(),
			status: "running",
			heartbeatAt: now.toISOString(),
			failureCounted: false,
		};
		executions.push(execution);
		this.executions.set(runId, executions);
		run.status = "running";
		run.startedAt ??= now.toISOString();
		run.updatedAt = now.toISOString();
		this.appendEvent({
			runId,
			category: "execution",
			type: "execution.started",
			executionId,
			payload: { attempt: execution.attempt, fence: execution.fence },
			idempotencyKey: `execution:${executionId}:started`,
		});
		return { kind: "acquired", execution: clonePublicExecution(execution) };
	}

	private refreshExecution(
		handle: ExecutionHandle,
		ttlSeconds: number,
	): ExecutionHandle {
		assertPositiveInteger(ttlSeconds, "execution TTL");
		const execution = this.requireExecution(handle);
		const now = this.now();
		execution.heartbeatAt = now.toISOString();
		execution.leaseExpiresAt = expiresAt(now, ttlSeconds).toISOString();
		return clonePublicExecution(execution);
	}

	private releaseExecution(handle: ExecutionHandle): void {
		const execution = this.findExecution(handle.runId, handle.id);
		if (execution?.status !== "running") return;
		if (execution.token !== handle.token || execution.fence !== handle.fence) {
			return;
		}
		const now = this.now().toISOString();
		execution.status = "failed";
		execution.finishedAt = now;
		this.appendEvent({
			runId: handle.runId,
			category: "execution",
			type: "execution.failed",
			executionId: handle.id,
			payload: {},
			idempotencyKey: `execution:${handle.id}:released`,
		});
	}

	private requireExecution(handle: ExecutionHandle): InternalExecution {
		const execution = this.findExecution(handle.runId, handle.id);
		if (
			execution?.status !== "running" ||
			execution.token !== handle.token ||
			execution.fence !== handle.fence ||
			Date.parse(execution.leaseExpiresAt) <= this.now().getTime()
		) {
			throw new LeaseLostError(`Execution lease for "${handle.runId}" was lost`);
		}
		return execution;
	}

	private findExecution(
		runId: string,
		executionId: string,
	): InternalExecution | undefined {
		return this.executions
			.get(runId)
			?.find((execution) => execution.id === executionId);
	}

	private beginStep<T>(
		runId: string,
		key: string,
		replayPolicy: ReplayPolicy,
		executionHandle: ExecutionHandle,
	): BeginStepResult<T> {
		assertExecutionRun(runId, executionHandle);
		this.requireRun(runId);
		const execution = this.requireExecution(executionHandle);
		assertStoreKey(key, "step key");
		const mapKey = stepMapKey(runId, key);
		const existing = this.steps.get(mapKey);
		if (existing?.status === "completed") {
			this.appendEvent({
				runId,
				category: "step",
				type: "step.reused",
				executionId: execution.id,
				stepKey: key,
				payload: { generation: existing.generation },
				idempotencyKey: `step:${key}:${existing.generation}:reused:${execution.id}`,
			});
			return {
				kind: "reuse",
				value: cloneValue(existing.value) as T,
				generation: existing.generation,
			};
		}
		if (existing?.status === "started") {
			if (existing.executionId === execution.id) {
				return { kind: "execute", generation: existing.generation };
			}
			const owner = existing.executionId
				? this.findExecution(runId, existing.executionId)
				: undefined;
			const ownerActive =
				owner?.status === "running" &&
				Date.parse(owner.leaseExpiresAt) > this.now().getTime();
			if (ownerActive) return { kind: "busy" };
			if (existing.replayPolicy === "guarded") {
				return { kind: "blocked", reason: "interrupted_guarded_step" };
			}
		}

		const generation = existing?.generation ?? 0;
		const now = this.now().toISOString();
		this.appendEvent({
			runId,
			category: "step",
			type: "step.started",
			executionId: execution.id,
			stepKey: key,
			payload: { generation, replayPolicy },
			idempotencyKey: `step:${key}:${generation}:started:${execution.id}`,
		});
		this.steps.set(mapKey, {
			runId,
			key,
			generation,
			status: "started",
			replayPolicy,
			executionId: execution.id,
			startedAt: now,
		});
		return { kind: "execute", generation };
	}

	private completeStep<T>(
		runId: string,
		key: string,
		value: T,
		executionHandle: ExecutionHandle,
	): T {
		assertExecutionRun(runId, executionHandle);
		const execution = this.requireExecution(executionHandle);
		const mapKey = stepMapKey(runId, key);
		const existing = this.steps.get(mapKey);
		if (
			existing?.status !== "started" ||
			existing.executionId !== execution.id
		) {
			throw new StoreConflictError(`Step "${key}" is not owned by execution`);
		}
		const now = this.now();
		const normalized = normalizeJsonValue(value);
		const durationMs = existing.startedAt
			? Math.max(0, now.getTime() - Date.parse(existing.startedAt))
			: undefined;
		this.appendEvent({
			runId,
			category: "step",
			type: "step.completed",
			executionId: execution.id,
			stepKey: key,
			payload: {
				generation: existing.generation,
				...(durationMs !== undefined
					? { durationMs }
					: {}),
			},
			idempotencyKey: `step:${key}:${existing.generation}:completed`,
		});
		existing.status = "completed";
		existing.value = normalized;
		existing.finishedAt = now.toISOString();
		existing.durationMs = durationMs;
		return cloneValue(normalized);
	}

	private failStep(
		runId: string,
		key: string,
		errorCode: string,
		executionHandle: ExecutionHandle,
	): void {
		assertExecutionRun(runId, executionHandle);
		const execution = this.requireExecution(executionHandle);
		assertStoreKey(errorCode, "step error code");
		const existing = this.steps.get(stepMapKey(runId, key));
		if (
			existing?.status !== "started" ||
			existing.executionId !== execution.id
		) {
			return;
		}
		const now = this.now();
		const failedGeneration = existing.generation;
		const durationMs = existing.startedAt
			? Math.max(0, now.getTime() - Date.parse(existing.startedAt))
			: undefined;
		this.appendEvent({
			runId,
			category: "step",
			type: "step.failed",
			executionId: execution.id,
			stepKey: key,
			payload: {
				generation: failedGeneration,
				errorCode,
			},
			idempotencyKey: `step:${key}:${failedGeneration}:failed:${execution.id}`,
		});
		existing.status = "failed";
		existing.generation = failedGeneration + 1;
		existing.errorCode = errorCode;
		existing.finishedAt = now.toISOString();
		existing.durationMs = durationMs;
	}

	private invalidateSteps(
		runId: string,
		keys: readonly string[],
		reason: string,
		executionHandle: ExecutionHandle,
	): void {
		assertExecutionRun(runId, executionHandle);
		const execution = this.requireExecution(executionHandle);
		assertStoreKey(reason, "invalidation reason");
		const changes: Array<{ mapKey: string; step: RunStep; event: NewRunEvent }> =
			[];
		for (const key of new Set(keys)) {
			assertStoreKey(key, "step key");
			const mapKey = stepMapKey(runId, key);
			const existing = this.steps.get(mapKey);
			const generation = (existing?.generation ?? -1) + 1;
			const replacement: RunStep = {
				runId,
				key,
				generation,
				status: "invalidated",
				replayPolicy: existing?.replayPolicy ?? "safe",
				executionId: execution.id,
				errorCode: reason,
			};
			changes.push({
				mapKey,
				step: replacement,
				event: {
				runId,
				category: "step",
				type: "step.invalidated",
				executionId: execution.id,
				stepKey: key,
				payload: { generation, reason },
				idempotencyKey: `step:${key}:${generation}:invalidated`,
				},
			});
		}
		for (const change of changes) {
			this.assertEventAppendable(change.event);
		}
		for (const change of changes) {
			this.appendEvent(change.event);
			this.steps.set(change.mapKey, change.step);
		}
	}

	private incrementFailureCount(
		runId: string,
		execution: ExecutionHandle,
	): number {
		assertExecutionRun(runId, execution);
		const run = this.requireRun(runId);
		const active = this.requireExecution(execution);
		if (active.failureCounted) return run.failureCount;
		active.failureCounted = true;
		run.failureCount += 1;
		run.updatedAt = this.now().toISOString();
		return run.failureCount;
	}

	private recordUsage(
		runId: string,
		inputTokens: number,
		outputTokens: number,
		model: string,
		execution?: ExecutionHandle,
	): void {
		if (execution) assertExecutionRun(runId, execution);
		const run = this.requireRun(runId);
		if (execution) this.requireExecution(execution);
		if (
			!Number.isSafeInteger(inputTokens) ||
			inputTokens < 0 ||
			!Number.isSafeInteger(outputTokens) ||
			outputTokens < 0
		) {
			throw new StoreConflictError("Token usage must be nonnegative integers");
		}
		assertStoreKey(model, "model");
		const nextModelCall = run.totalModelCalls + 1;
		this.appendEvent({
			runId,
			category: "agent",
			type: "agent.usage",
			executionId: execution?.id,
			payload: { inputTokens, outputTokens, model },
			idempotencyKey: execution
				? `usage:${execution.id}:${nextModelCall}`
				: undefined,
		});
		run.totalInputTokens += inputTokens;
		run.totalOutputTokens += outputTokens;
		run.totalModelCalls = nextModelCall;
		run.updatedAt = this.now().toISOString();
	}

	private addLink(link: Omit<RunLink, "createdAt">): RunLink {
		this.requireRun(link.runId);
		assertStoreKey(link.kind, "run link kind");
		assertStoreKey(link.externalId, "run link external ID");
		const links = this.links.get(link.runId) ?? [];
		const existing = links.find(
			(item) =>
				item.kind === link.kind && item.externalId === link.externalId,
		);
		if (existing) {
			existing.url = link.url ?? existing.url;
			existing.metadata = {
				...(existing.metadata ?? {}),
				...normalizeJsonValue(link.metadata ?? {}),
			};
			return cloneValue(existing);
		}
		const stored: RunLink = {
			...cloneValue(link),
			metadata: normalizeJsonValue(link.metadata ?? {}),
			createdAt: this.now().toISOString(),
		};
		this.appendEvent({
			runId: link.runId,
			category: "external",
			type: "external.linked",
			payload: { kind: link.kind, externalId: link.externalId },
			idempotencyKey: `link:${link.kind}:${link.externalId}`,
		});
		links.push(stored);
		this.links.set(link.runId, links);
		return cloneValue(stored);
	}

	private acceptDelivery(input: AcceptDeliveryInput): AcceptDeliveryResult {
		validateDelivery(input);
		const mapKey = inboxMapKey(input.provider, input.deliveryId);
		const existing = this.getLiveInbox(input.provider, input.deliveryId);
		if (existing) {
			if (existing.payloadDigest !== input.payloadDigest) {
				throw new StoreConflictError(
					"Delivery ID was reused with a different payload",
				);
			}
			return { kind: existing.status, runId: existing.runId };
		}

		if (input.subjectKey) {
			const lease = this.getLiveLease(input.subjectKey);
			if (lease && lease.ownerId !== input.run.id) {
				return { kind: "subject_busy", activeRunId: lease.ownerId };
			}
		}

		this.ensureRun(input.run);
		if (input.subjectKey) {
			if (
				this.acquireLease(
					input.subjectKey,
					input.run.id,
					input.subjectLeaseTtlSeconds ?? input.deliveryTtlSeconds,
				) === null
			) {
				return { kind: "subject_busy" };
			}
		}

		this.inboxRecords.set(mapKey, {
			provider: input.provider,
			deliveryId: input.deliveryId,
			runId: input.run.id,
			subjectKey: input.subjectKey,
			payloadDigest: input.payloadDigest,
			status: "pending",
			expiresAt: expiresAt(
				this.now(),
				input.deliveryTtlSeconds,
			).toISOString(),
		});
		return { kind: "accepted", runId: input.run.id };
	}

	private markDispatched(provider: string, deliveryId: string): void {
		assertStoreKey(provider, "delivery provider");
		assertStoreKey(deliveryId, "delivery ID");
		const key = inboxMapKey(provider, deliveryId);
		const record = this.inboxRecords.get(key);
		if (
			!record ||
			Date.parse(record.expiresAt) <= this.now().getTime() ||
			(record.status !== "pending" && record.status !== "dispatched")
		) {
			throw new StoreConflictError("Delivery claim was lost");
		}
		record.status = "dispatched";
	}

	private abandonDelivery(provider: string, deliveryId: string): void {
		assertStoreKey(provider, "delivery provider");
		assertStoreKey(deliveryId, "delivery ID");
		const key = inboxMapKey(provider, deliveryId);
		const record = this.inboxRecords.get(key);
		if (record?.status !== "pending") return;
		const activeExecution = this.executions
			.get(record.runId)
			?.some(
				(execution) =>
					execution.status === "running" &&
					Date.parse(execution.leaseExpiresAt) > this.now().getTime(),
			);
		if (activeExecution) {
			record.status = "dispatched";
			return;
		}
		const run = this.runRecords.get(record.runId);
		if (run && !isTerminal(run.status)) {
			this.appendEvent({
				runId: run.id,
				category: "lifecycle",
				type: "run.cancelled",
				payload: { reason: "dispatch_abandoned" },
				idempotencyKey: `run:${run.id}:dispatch-abandoned`,
			});
		}
		this.inboxRecords.delete(key);
		if (record.subjectKey) {
			const lease = this.getLiveLease(record.subjectKey);
			if (lease?.ownerId === record.runId) this.releaseLease(lease);
		}
		if (run && !isTerminal(run.status)) {
			run.status = "cancelled";
			run.errorCode = "dispatch_abandoned";
			run.finishedAt = this.now().toISOString();
			run.updatedAt = run.finishedAt;
		}
	}

	private getLiveInbox(
		provider: string,
		deliveryId: string,
	): InternalInbox | undefined {
		assertStoreKey(provider, "delivery provider");
		assertStoreKey(deliveryId, "delivery ID");
		const key = inboxMapKey(provider, deliveryId);
		const record = this.inboxRecords.get(key);
		if (record && Date.parse(record.expiresAt) <= this.now().getTime()) {
			const activeExecution = this.executions
				.get(record.runId)
				?.some(
					(execution) =>
						execution.status === "running" &&
						Date.parse(execution.leaseExpiresAt) > this.now().getTime(),
				);
			if (activeExecution) return record;
			const run = this.runRecords.get(record.runId);
			if (run && !isTerminal(run.status)) {
				this.appendEvent({
					runId: run.id,
					category: "lifecycle",
					type: "run.cancelled",
					payload: { reason: "delivery_expired" },
					idempotencyKey: `run:${run.id}:delivery-expired`,
				});
				run.status = "cancelled";
				run.errorCode = "delivery_expired";
				run.finishedAt = this.now().toISOString();
				run.updatedAt = run.finishedAt;
			}
			if (record.subjectKey) {
				const lease = this.getLiveLease(record.subjectKey);
				if (lease?.ownerId === record.runId) this.releaseLease(lease);
			}
			this.inboxRecords.delete(key);
			return undefined;
		}
		return record;
	}

	private acquireLease(
		resourceKey: string,
		ownerId: string,
		ttlSeconds: number,
	): InternalLease | null {
		assertStoreKey(resourceKey, "lease resource key");
		assertStoreKey(ownerId, "lease owner");
		const existing = this.getLiveLease(resourceKey);
		if (existing && existing.ownerId !== ownerId) return null;
		const now = this.now();
		let fence: number;
		let token: string;
		if (existing) {
			fence = existing.fence;
			token = existing.token;
		} else {
			this.nextLeaseFence += 1;
			fence = this.nextLeaseFence;
			token = this.randomId();
		}
		const lease: InternalLease = {
			resourceKey,
			ownerId,
			token,
			fence,
			expiresAt: expiresAt(now, ttlSeconds).toISOString(),
		};
		this.leaseRecords.set(resourceKey, lease);
		return cloneValue(lease);
	}

	private refreshLease(
		handle: LeaseHandle,
		ttlSeconds: number,
	): LeaseHandle {
		const lease = this.getLiveLease(handle.resourceKey);
		if (
			!lease ||
			lease.ownerId !== handle.ownerId ||
			lease.token !== handle.token ||
			lease.fence !== handle.fence
		) {
			throw new LeaseLostError(`Lease "${handle.resourceKey}" was lost`);
		}
		lease.expiresAt = expiresAt(this.now(), ttlSeconds).toISOString();
		return cloneValue(lease);
	}

	private releaseLease(handle: LeaseHandle): void {
		const lease = this.leaseRecords.get(handle.resourceKey);
		if (
			lease?.ownerId === handle.ownerId &&
			lease.token === handle.token &&
			lease.fence === handle.fence
		) {
			this.leaseRecords.delete(handle.resourceKey);
		}
	}

	private getLiveLease(resourceKey: string): InternalLease | undefined {
		const lease = this.leaseRecords.get(resourceKey);
		if (lease && Date.parse(lease.expiresAt) <= this.now().getTime()) {
			this.leaseRecords.delete(resourceKey);
			return undefined;
		}
		return lease;
	}

	private appendConversationMessage(
		provider: string,
		externalConversationId: string,
		message: Omit<ConversationMessage, "conversationId">,
		options: { ttlSeconds: number; maxMessages: number },
	): boolean {
		assertStoreKey(provider, "conversation provider");
		assertStoreKey(externalConversationId, "external conversation ID");
		assertStoreKey(message.id, "conversation message ID");
		assertPositiveInteger(options.maxMessages, "maximum messages");
		const key = conversationMapKey(provider, externalConversationId);
		const now = this.now();
		let conversation = this.conversationRecords.get(key);
		if (
			conversation &&
			Date.parse(conversation.expiresAt) <= now.getTime()
		) {
			this.conversationRecords.delete(key);
			conversation = undefined;
		}
		conversation ??= {
			id: createHash("sha256").update(key).digest("hex"),
			provider,
			externalId: externalConversationId,
			expiresAt: expiresAt(now, options.ttlSeconds).toISOString(),
			messages: [],
		};
		if (conversation.messages.some((item) => item.id === message.id)) {
			return false;
		}
		conversation.messages.push({
			...cloneValue(message),
			conversationId: conversation.id,
		});
		conversation.messages = conversation.messages
			.sort((a, b) =>
				a.occurredAt === b.occurredAt
					? a.id.localeCompare(b.id)
					: a.occurredAt.localeCompare(b.occurredAt),
			)
			.slice(-options.maxMessages);
		conversation.expiresAt = expiresAt(
			now,
			options.ttlSeconds,
		).toISOString();
		this.conversationRecords.set(key, conversation);
		return true;
	}

	private listConversationMessages(
		provider: string,
		externalConversationId: string,
		limit: number,
		refreshTtlSeconds?: number,
	): ConversationMessage[] {
		const key = conversationMapKey(provider, externalConversationId);
		const conversation = this.conversationRecords.get(key);
		if (!conversation) return [];
		const now = this.now();
		if (Date.parse(conversation.expiresAt) <= now.getTime()) {
			this.conversationRecords.delete(key);
			return [];
		}
		if (refreshTtlSeconds !== undefined) {
			conversation.expiresAt = expiresAt(
				now,
				refreshTtlSeconds,
			).toISOString();
		}
		return conversation.messages.slice(-boundedLimit(limit)).map(cloneValue);
	}

	private putReply(
		provider: string,
		operationId: string,
		runId: string,
		content: string,
		ttlSeconds: number,
	): void {
		this.requireRun(runId);
		const key = replyMapKey(provider, operationId);
		const existing = this.getLiveReply(key);
		if (
			existing &&
			(existing.runId !== runId || existing.content !== content)
		) {
			throw new StoreConflictError(
				"Outbound operation was reused with different content",
			);
		}
		this.replies.set(key, {
			runId,
			content,
			status: existing?.status ?? "pending",
			providerRef: existing?.providerRef,
			expiresAt: expiresAt(this.now(), ttlSeconds).toISOString(),
		});
	}

	private getReply(
		provider: string,
		operationId: string,
		refreshTtlSeconds?: number,
	): string | null {
		const record = this.getLiveReply(replyMapKey(provider, operationId));
		if (!record) return null;
		if (refreshTtlSeconds !== undefined) {
			record.expiresAt = expiresAt(
				this.now(),
				refreshTtlSeconds,
			).toISOString();
		}
		return record.content;
	}

	private markReplyDelivered(
		provider: string,
		operationId: string,
		providerRef?: string,
	): void {
		const record = this.getLiveReply(replyMapKey(provider, operationId));
		if (!record) {
			throw new StoreConflictError("Outbound delivery does not exist");
		}
		record.status = "delivered";
		record.providerRef = providerRef;
	}

	private replyDelivered(provider: string, operationId: string): boolean {
		return (
			this.getLiveReply(replyMapKey(provider, operationId))?.status ===
			"delivered"
		);
	}

	private getLiveReply(key: string): InternalReply | undefined {
		const record = this.replies.get(key);
		if (record && Date.parse(record.expiresAt) <= this.now().getTime()) {
			this.replies.delete(key);
			return undefined;
		}
		return record;
	}

	private getKnowledge(
		namespace: string,
		key: string,
		refreshTtlSeconds?: number,
	): string | null {
		const mapKey = knowledgeMapKey(namespace, key);
		const record = this.knowledgeRecords.get(mapKey);
		if (!record) return null;
		const now = this.now();
		if (record.expiresAt && Date.parse(record.expiresAt) <= now.getTime()) {
			this.knowledgeRecords.delete(mapKey);
			return null;
		}
		if (refreshTtlSeconds !== undefined && record.expiresAt !== undefined) {
			record.expiresAt = expiresAt(
				now,
				refreshTtlSeconds,
			).toISOString();
		}
		return record.content;
	}

	private putKnowledge(
		namespace: string,
		key: string,
		content: string,
		ttlSeconds?: number,
	): void {
		const mapKey = knowledgeMapKey(namespace, key);
		const existing = this.knowledgeRecords.get(mapKey);
		this.knowledgeRecords.set(mapKey, {
			content,
			version: (existing?.version ?? 0) + 1,
			expiresAt:
				ttlSeconds === undefined
					? undefined
					: expiresAt(this.now(), ttlSeconds).toISOString(),
		});
	}

	private appendKnowledgeLines(
		namespace: string,
		key: string,
		lines: readonly string[],
		options: { maxChars: number; ttlSeconds?: number },
	): void {
		assertPositiveInteger(options.maxChars, "maximum knowledge characters");
		const mapKey = knowledgeMapKey(namespace, key);
		const existing = this.getKnowledge(namespace, key) ?? "";
		const merged = new Set(
			existing
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		);
		for (const line of lines.map((line) => line.trim()).filter(Boolean)) {
			merged.add(line);
		}
		const content = [...merged].join("\n").slice(-options.maxChars);
		const previous = this.knowledgeRecords.get(mapKey);
		this.knowledgeRecords.set(mapKey, {
			content,
			version: (previous?.version ?? 0) + 1,
			expiresAt:
				options.ttlSeconds === undefined
					? undefined
					: expiresAt(this.now(), options.ttlSeconds).toISOString(),
		});
	}
}

export function createMemoryFactoryStore(
	options?: FactoryStoreOptions,
): MemoryFactoryStore {
	return new MemoryFactoryStore(options);
}

function clonePublicRun(run: InternalRun): RunRecord {
	const {
		nextEventSeq: _,
		nextExecutionFence: __,
		hasResult: ___,
		...record
	} = run;
	return cloneValue(record);
}

function clonePublicExecution(execution: InternalExecution): ExecutionHandle {
	return {
		id: execution.id,
		runId: execution.runId,
		attempt: execution.attempt,
		token: execution.token,
		fence: execution.fence,
		leaseExpiresAt: execution.leaseExpiresAt,
	};
}

function isTerminal(status: RunRecord["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function validateRunInput(run: NewRun): void {
	assertStoreKey(run.id, "run ID");
	assertStoreKey(run.rootRunId, "root run ID");
	assertStoreKey(run.name, "run name");
	if (run.parentRunId) assertStoreKey(run.parentRunId, "parent run ID");
	if (run.parentStepKey) {
		assertStoreKey(run.parentStepKey, "parent step key");
	}
	if (run.triggerType) assertStoreKey(run.triggerType, "trigger type");
	if (run.triggerRef) assertStoreKey(run.triggerRef, "trigger reference");
}

function validateDelivery(input: AcceptDeliveryInput): void {
	assertStoreKey(input.provider, "delivery provider");
	assertStoreKey(input.deliveryId, "delivery ID");
	assertStoreKey(input.payloadDigest, "delivery payload digest");
	if (input.subjectKey) assertStoreKey(input.subjectKey, "subject key");
	assertPositiveInteger(input.deliveryTtlSeconds, "delivery TTL");
	if (input.subjectLeaseTtlSeconds !== undefined) {
		assertPositiveInteger(input.subjectLeaseTtlSeconds, "subject lease TTL");
	}
	validateRunInput(input.run);
}

function boundedLimit(limit = 100): number {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new StoreConflictError("Limit must be a positive safe integer");
	}
	return Math.min(limit, 500);
}

function stepMapKey(runId: string, key: string): string {
	return `${runId}\0${key}`;
}

function inboxMapKey(provider: string, deliveryId: string): string {
	return `${provider}\0${deliveryId}`;
}

function conversationMapKey(provider: string, externalId: string): string {
	assertStoreKey(provider, "conversation provider");
	assertStoreKey(externalId, "external conversation ID");
	return `${provider}\0${externalId}`;
}

function replyMapKey(provider: string, operationId: string): string {
	assertStoreKey(provider, "outbound provider");
	assertStoreKey(operationId, "outbound operation ID");
	return `${provider}\0${operationId}`;
}

function knowledgeMapKey(namespace: string, key: string): string {
	assertStoreKey(namespace, "knowledge namespace");
	assertStoreKey(key, "knowledge key");
	return `${namespace}\0${key}`;
}

function assertExecutionRun(
	runId: string,
	execution: ExecutionHandle,
): void {
	if (execution.runId !== runId) {
		throw new StoreConflictError(
			`Execution "${execution.id}" does not belong to run "${runId}"`,
		);
	}
}
