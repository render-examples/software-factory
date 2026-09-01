import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
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
} from "../contracts.js";
import {
	LeaseLostError,
	StoreConflictError,
} from "../contracts.js";
import {
	artifactRef,
	assertEventPayload,
	assertPositiveInteger,
	assertStoreKey,
	canonicalJson,
	normalizeJsonValue,
	valueDigest,
} from "../values.js";
import {
	migratePostgres,
	verifyPostgresSchema,
} from "./migrations.js";
import {
	createPostgresPool,
	type PostgresPoolOptions,
} from "./pool.js";

interface PostgresFactoryStoreOptions extends PostgresPoolOptions {
	pool?: Pool;
}

export class PostgresFactoryStore implements FactoryStore {
	private readonly pool: Pool;
	private readonly ownsPool: boolean;
	private closePromise: Promise<void> | undefined;

	readonly events: RunEventStore = {
		append: async (event) =>
			this.transaction((client) => this.appendEventTx(client, event)),
		readRun: async (runId, options) => {
			assertStoreKey(runId, "run ID");
			const limit = boundedLimit(options?.limit);
			const result = await this.pool.query<RunEventRow>(
				`SELECT position, id, run_id, seq, ts, category, type,
				        execution_id, step_key, agent_name, payload,
				        payload_digest, version, idempotency_key,
				        correlation_id, causation_id
				 FROM render_factory.run_events
				 WHERE run_id = $1 AND seq > $2
				 ORDER BY seq
				 LIMIT $3`,
				[runId, options?.afterSeq ?? 0, limit],
			);
			return result.rows.map(mapEvent);
		},
		scan: async (options) => {
			const limit = boundedLimit(options?.limit);
			const result = await this.pool.query<RunEventRow>(
				`SELECT position, id, run_id, seq, ts, category, type,
				        execution_id, step_key, agent_name, payload,
				        payload_digest, version, idempotency_key,
				        correlation_id, causation_id
				 FROM render_factory.run_events
				 WHERE position > $1
				 ORDER BY position
				 LIMIT $2`,
				[options?.afterPosition ?? 0, limit],
			);
			return result.rows.map(mapEvent);
		},
	};

	readonly runs: RunStore = {
		ensureRun: async (run) =>
			this.transaction((client) => this.ensureRunTx(client, run)),
		getRun: async (runId) => {
			assertStoreKey(runId, "run ID");
			const result = await this.pool.query<RunRow>(
				`${RUN_SELECT} WHERE id = $1`,
				[runId],
			);
			return result.rows[0] ? mapRun(result.rows[0]) : null;
		},
		listRuns: async (query) => this.listRuns(query),
		getTerminal: async <T>(runId: string) => {
			assertStoreKey(runId, "run ID");
			const result = await this.pool.query<{
				status: string;
				result: unknown;
				has_result: boolean;
			}>(
				`SELECT status, result, has_result
				 FROM render_factory.runs
				 WHERE id = $1`,
				[runId],
			);
			const row = result.rows[0];
			if (!row || !isTerminal(row.status)) return { found: false };
			return {
				found: true,
				value: row.has_result ? (row.result as T) : undefined,
			};
		},
		getStep: async <T>(runId: string, key: string) =>
			this.getStep<T>(runId, key),
		beginExecution: async (runId, executionId, ttlSeconds) =>
			this.transaction((client) =>
				this.beginExecutionTx(client, runId, executionId, ttlSeconds),
			),
		refreshExecution: async (execution, ttlSeconds) =>
			this.refreshExecution(execution, ttlSeconds),
		releaseExecution: async (execution) =>
			this.transaction((client) =>
				this.releaseExecutionTx(client, execution),
			),
		beginStep: async <T>(
			runId: string,
			key: string,
			replayPolicy: ReplayPolicy,
			execution: ExecutionHandle,
		) =>
			this.transaction((client) =>
				this.beginStepTx<T>(
					client,
					runId,
					key,
					replayPolicy,
					execution,
				),
			),
		completeStep: async <T>(
			runId: string,
			key: string,
			value: T,
			execution: ExecutionHandle,
		) =>
			this.transaction((client) =>
				this.completeStepTx(client, runId, key, value, execution),
			),
		failStep: async (runId, key, errorCode, execution) =>
			this.transaction((client) =>
				this.failStepTx(client, runId, key, errorCode, execution),
			),
		invalidateSteps: async (runId, keys, reason, execution) =>
			this.transaction((client) =>
				this.invalidateStepsTx(client, runId, keys, reason, execution),
			),
		incrementFailureCount: async (runId, execution) =>
			this.transaction((client) =>
				this.incrementFailureCountTx(client, runId, execution),
			),
		recordUsage: async (
			runId,
			inputTokens,
			outputTokens,
			model,
			execution,
		) =>
			this.transaction((client) =>
				this.recordUsageTx(
					client,
					runId,
					inputTokens,
					outputTokens,
					model,
					execution,
				),
			),
		addLink: async (link) =>
			this.transaction((client) => this.addLinkTx(client, link)),
		listLinks: async (runId) => {
			assertStoreKey(runId, "run ID");
			const result = await this.pool.query<RunLinkRow>(
				`SELECT run_id, kind, external_id, url, metadata, created_at
				 FROM render_factory.run_links
				 WHERE run_id = $1
				 ORDER BY created_at, id`,
				[runId],
			);
			return result.rows.map(mapLink);
		},
		findRunsByLink: async (kind, externalId, limit) => {
			assertStoreKey(kind, "run link kind");
			assertStoreKey(externalId, "run link external ID");
			const result = await this.pool.query<RunRow>(
				`${RUN_SELECT}
				 WHERE id IN (
				   SELECT run_id
				   FROM render_factory.run_links
				   WHERE kind = $1 AND external_id = $2
				 )
				 ORDER BY created_at DESC, id DESC
				 LIMIT $3`,
				[kind, externalId, boundedLimit(limit)],
			);
			return result.rows.map(mapRun);
		},
	};

	readonly inbox: InboxStore = {
		accept: async (input) =>
			this.transaction((client) => this.acceptDeliveryTx(client, input)),
		markDispatched: async (provider, deliveryId) =>
			this.markDispatched(provider, deliveryId),
		abandon: async (provider, deliveryId) =>
			this.transaction((client) =>
				this.abandonDeliveryTx(client, provider, deliveryId),
			),
		getRunId: async (provider, deliveryId) => {
			assertStoreKey(provider, "delivery provider");
			assertStoreKey(deliveryId, "delivery ID");
			const result = await this.pool.query<{ run_id: string | null }>(
				`SELECT run_id
				 FROM render_factory.inbox_deliveries
				 WHERE provider = $1 AND delivery_id = $2 AND expires_at > now()`,
				[provider, deliveryId],
			);
			return result.rows[0]?.run_id ?? null;
		},
	};

	readonly leases: LeaseStore = {
		tryAcquire: async (resourceKey, ownerId, ttlSeconds) =>
			this.transaction((client) =>
				this.acquireLeaseTx(
					client,
					resourceKey,
					ownerId,
					ttlSeconds,
				),
			),
		refresh: async (lease, ttlSeconds) =>
			this.refreshLease(lease, ttlSeconds),
		release: async (lease) => this.releaseLease(lease),
	};

	readonly artifacts: ArtifactStore = {
		put: async (input) => this.putArtifact(input),
		get: async (ref, refreshTtlSeconds) =>
			this.getArtifact(ref, refreshTtlSeconds),
		delete: async (ref) => {
			await this.pool.query(
				"DELETE FROM render_factory.artifacts WHERE ref = $1",
				[ref],
			);
		},
	};

	readonly conversations: ConversationStore = {
		appendOnce: async (
			provider,
			externalConversationId,
			message,
			options,
		) =>
			this.transaction((client) =>
				this.appendConversationTx(
					client,
					provider,
					externalConversationId,
					message,
					options,
				),
			),
		list: async (
			provider,
			externalConversationId,
			limit,
			refreshTtlSeconds,
		) =>
			this.listConversation(
				provider,
				externalConversationId,
				limit,
				refreshTtlSeconds,
			),
		putReply: async (provider, operationId, runId, content, ttlSeconds) =>
			this.transaction((client) =>
				this.putReplyTx(
					client,
					provider,
					operationId,
					runId,
					content,
					ttlSeconds,
				),
			),
		getReply: async (provider, operationId, refreshTtlSeconds) =>
			this.getReply(provider, operationId, refreshTtlSeconds),
		markDelivered: async (provider, operationId, providerRef) =>
			this.markDelivered(provider, operationId, providerRef),
		wasDelivered: async (provider, operationId) =>
			this.wasDelivered(provider, operationId),
	};

	readonly knowledge: KnowledgeStore = {
		get: async (namespace, key, refreshTtlSeconds) =>
			this.getKnowledge(namespace, key, refreshTtlSeconds),
		put: async (namespace, key, content, ttlSeconds) =>
			this.putKnowledge(namespace, key, content, ttlSeconds),
		appendLines: async (namespace, key, lines, options) =>
			this.transaction((client) =>
				this.appendKnowledgeTx(client, namespace, key, lines, options),
			),
	};

	constructor(options: PostgresFactoryStoreOptions = {}) {
		this.pool =
			options.pool ??
			createPostgresPool({
				connectionString: options.connectionString,
				max: options.max,
				applicationName: options.applicationName,
			});
		this.ownsPool = !options.pool;
	}

	async health(): Promise<void> {
		await this.pool.query("SELECT 1");
	}

	async verifySchema(): Promise<void> {
		await verifyPostgresSchema(this.pool);
	}

	async migrate(): Promise<void> {
		await migratePostgres(this.pool);
	}

	async close(): Promise<void> {
		if (!this.ownsPool) return;
		this.closePromise ??= this.pool.end();
		await this.closePromise;
	}

	async completeRun(input: CompleteRunInput): Promise<void> {
		assertExecutionRun(input.runId, input.execution);
		await this.transaction(async (client) => {
			await this.requireExecutionTx(client, input.execution);
			const eventType =
				input.status === "completed"
					? "run.completed"
					: input.status === "cancelled"
						? "run.cancelled"
						: "run.failed";
			const updated = await client.query(
				`UPDATE render_factory.runs
				 SET status = $2, result = $3, error_code = $4,
				     has_result = $5,
				     finished_at = now(), updated_at = now()
				 WHERE id = $1 AND status = 'running'`,
				[
					input.runId,
					input.status,
					input.result === undefined
						? null
						: canonicalJson(input.result),
					input.errorCode ?? null,
					input.result !== undefined,
				],
			);
			if ((updated.rowCount ?? 0) !== 1) {
				throw new StoreConflictError(
					`Run "${input.runId}" is not running`,
				);
			}
			await client.query(
				`UPDATE render_factory.run_executions
				 SET status = $2, finished_at = now()
				 WHERE id = $1`,
				[
					input.execution.id,
					input.status === "completed" ? "completed" : "failed",
				],
			);
			await this.appendEventTx(client, {
				runId: input.runId,
				category: "lifecycle",
				type: eventType,
				executionId: input.execution.id,
				payload: input.errorCode
					? { errorCode: input.errorCode }
					: {},
				idempotencyKey: `run:${input.runId}:terminal`,
			});
			await client.query(
				`UPDATE render_factory.inbox_deliveries
				 SET status = 'completed', completed_at = now()
				 WHERE run_id = $1`,
				[input.runId],
			);
			await client.query(
				`DELETE FROM render_factory.leases
				 WHERE owner_id IN ($1, $2)`,
				[input.runId, input.execution.id],
			);
		});
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
		const batchSize = Math.min(options.batchSize ?? 500, 5_000);
		const now = options.now ?? new Date();

		// Phase 1: mark stale executions lost (one txn per execution)
		const staleExecutions = await this.pool.query<{
			id: string;
			run_id: string;
		}>(
			`SELECT id, run_id
			 FROM render_factory.run_executions
			 WHERE status = 'running'
			   AND lease_expires_at < $1::timestamptz - interval '1 hour'
			 ORDER BY lease_expires_at
			 LIMIT $2`,
			[now, batchSize],
		);
		for (const stale of staleExecutions.rows) {
			await this.transaction(async (client) => {
				const runLock = await client.query(
					`SELECT id FROM render_factory.runs
					 WHERE id = $1
					 FOR UPDATE SKIP LOCKED`,
					[stale.run_id],
				);
				if ((runLock.rowCount ?? 0) === 0) return;
				const executionLock = await client.query(
					`SELECT id FROM render_factory.run_executions
					 WHERE id = $1 AND run_id = $2 AND status = 'running'
					   AND lease_expires_at < $3::timestamptz - interval '1 hour'
					 FOR UPDATE SKIP LOCKED`,
					[stale.id, stale.run_id, now],
				);
				if ((executionLock.rowCount ?? 0) === 0) return;
				await client.query(
					`UPDATE render_factory.run_executions
					 SET status = 'lost', finished_at = $2,
					     error_code = 'execution_lease_expired'
					 WHERE id = $1`,
					[stale.id, now],
				);
				const failed = await client.query(
					`UPDATE render_factory.runs
					 SET status = 'failed',
					     error_code = 'execution_lease_expired',
					     finished_at = $2,
					     updated_at = $2
					 WHERE id = $1 AND status = 'running'`,
					[stale.run_id, now],
				);
				if ((failed.rowCount ?? 0) === 1) {
					await this.appendEventTx(client, {
						runId: stale.run_id,
						category: "lifecycle",
						type: "run.failed",
						executionId: stale.id,
						payload: { errorCode: "execution_lease_expired" },
						idempotencyKey: `run:${stale.run_id}:stale-execution`,
					});
					await client.query(
						`UPDATE render_factory.inbox_deliveries
						 SET status = 'completed', completed_at = $2
						 WHERE run_id = $1`,
						[stale.run_id, now],
					);
					await client.query(
						`DELETE FROM render_factory.leases
						 WHERE owner_id IN ($1, $2)`,
						[stale.run_id, stale.id],
					);
				}
			});
		}

		// Phase 2: expired inbox (one txn per delivery)
		const expiredInbox = await this.pool.query<{
			provider: string;
			delivery_id: string;
		}>(
			`SELECT provider, delivery_id
			 FROM render_factory.inbox_deliveries
			 WHERE expires_at <= $1
			 LIMIT $2`,
			[now, batchSize],
		);
		let expiredRowsDeleted = 0;
		for (const delivery of expiredInbox.rows) {
			await this.transaction(async (client) => {
				await client.query(
					`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
					[delivery.provider, delivery.delivery_id],
				);
				const retained = await this.getLiveInboxTx(
					client,
					delivery.provider,
					delivery.delivery_id,
					24 * 60 * 60,
				);
				if (!retained) expiredRowsDeleted += 1;
			});
		}

		// Phase 3: expired auxiliary rows (one txn per table)
		const expiredQueries: Array<[string, unknown[]]> = [
			[
				`DELETE FROM render_factory.leases
				 WHERE resource_key IN (
				   SELECT resource_key FROM render_factory.leases
				   WHERE expires_at <= $1
				   LIMIT $2
				 )`,
				[now, batchSize],
			],
			[
				`DELETE FROM render_factory.artifacts
				 WHERE ref IN (
				   SELECT ref FROM render_factory.artifacts
				   WHERE expires_at <= $1
				   LIMIT $2
				 )`,
				[now, batchSize],
			],
			[
				`DELETE FROM render_factory.outbound_deliveries
				 WHERE (provider, operation_id) IN (
				   SELECT provider, operation_id
				   FROM render_factory.outbound_deliveries
				   WHERE expires_at <= $1
				   LIMIT $2
				 )`,
				[now, batchSize],
			],
			[
				`DELETE FROM render_factory.conversations
				 WHERE id IN (
				   SELECT id FROM render_factory.conversations
				   WHERE expires_at <= $1
				   LIMIT $2
				 )`,
				[now, batchSize],
			],
			[
				`DELETE FROM render_factory.knowledge_entries
				 WHERE (namespace, key) IN (
				   SELECT namespace, key
				   FROM render_factory.knowledge_entries
				   WHERE expires_at IS NOT NULL AND expires_at <= $1
				   LIMIT $2
				 )`,
				[now, batchSize],
			],
		];
		for (const [sql, params] of expiredQueries) {
			const deleted = await this.pool.query(sql, params);
			expiredRowsDeleted += deleted.rowCount ?? 0;
		}

		// Phase 4: event retention
		const events = await this.transaction((client) =>
			client.query<{ count: string }>(
				`WITH candidates AS (
				   SELECT id
				   FROM render_factory.runs
				   WHERE status IN ('completed', 'failed', 'cancelled')
				     AND finished_at < $1::timestamptz - ($2::double precision * interval '1 day')
				     AND details_deleted_at IS NULL
				   ORDER BY finished_at
				   LIMIT $3
				   FOR UPDATE SKIP LOCKED
				 ), deleted AS (
				   DELETE FROM render_factory.run_events
				   WHERE run_id IN (SELECT id FROM candidates)
				   RETURNING 1
				 ), trimmed_steps AS (
				   UPDATE render_factory.run_steps
				   SET result = NULL, updated_at = $1
				   WHERE run_id IN (SELECT id FROM candidates)
				   RETURNING 1
				 ), marked AS (
				   UPDATE render_factory.runs
				   SET details_deleted_at = $1, updated_at = $1
				   WHERE id IN (SELECT id FROM candidates)
				   RETURNING 1
				 )
				 SELECT count(*)::text AS count FROM deleted`,
				[now, options.eventRetentionDays, batchSize],
			),
		);

		// Phase 5: run retention
		const runs = await this.transaction((client) =>
			client.query(
				`WITH candidates AS (
				   SELECT root.id
				   FROM render_factory.runs root
				   WHERE root.status IN ('completed', 'failed', 'cancelled')
				     AND root.parent_run_id IS NULL
				     AND root.finished_at < $1::timestamptz - ($2::double precision * interval '1 day')
				     AND NOT EXISTS (
				       SELECT 1
				       FROM render_factory.runs family
				       WHERE family.root_run_id = root.id
				         AND (
				           family.status NOT IN ('completed', 'failed', 'cancelled')
				           OR family.finished_at IS NULL
				           OR family.finished_at >= $1::timestamptz - ($2::double precision * interval '1 day')
				         )
				     )
				   ORDER BY root.finished_at
				   LIMIT $3
				   FOR UPDATE SKIP LOCKED
				 )
				 DELETE FROM render_factory.runs
				 WHERE id IN (SELECT id FROM candidates)`,
				[now, options.runRetentionDays, batchSize],
			),
		);

		return {
			eventsDeleted: Number(events.rows[0]?.count ?? 0),
			runsDeleted: runs.rowCount ?? 0,
			expiredRowsDeleted,
		};
	}

	private async transaction<T>(
		execute: (client: PoolClient) => Promise<T>,
	): Promise<T> {
		const maxRetries = 3;
		for (let attempt = 0; ; attempt++) {
			const client = await this.pool.connect();
			try {
				await client.query("BEGIN");
				const value = await execute(client);
				await client.query("COMMIT");
				return value;
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				const mapped = mapPostgresError(error);
				if (mapped !== error) throw mapped;
				if (attempt < maxRetries - 1 && isRetryablePostgresError(error)) {
					continue;
				}
				throw error;
			} finally {
				client.release();
			}
		}
	}

	private async ensureRunTx(
		client: PoolClient,
		run: NewRun,
	): Promise<RunRecord> {
		validateRunInput(run);
		if (run.rootRunId !== run.id) {
			const root = await client.query(
				`SELECT 1 FROM render_factory.runs WHERE id = $1`,
				[run.rootRunId],
			);
			if ((root.rowCount ?? 0) !== 1) {
				throw new StoreConflictError(
					`Root run "${run.rootRunId}" does not exist`,
				);
			}
		}
		if (run.parentRunId) {
			const parent = await client.query<{ root_run_id: string }>(
				`SELECT root_run_id FROM render_factory.runs WHERE id = $1`,
				[run.parentRunId],
			);
			if (!parent.rows[0]) {
				throw new StoreConflictError(
					`Parent run "${run.parentRunId}" does not exist`,
				);
			}
			if (parent.rows[0].root_run_id !== run.rootRunId) {
				throw new StoreConflictError(
					`Parent run "${run.parentRunId}" belongs to another root`,
				);
			}
		}
		const inserted = await client.query<RunRow>(
			`INSERT INTO render_factory.runs (
			   id, kind, name, status, root_run_id, parent_run_id,
			   parent_step_key, trigger_type, trigger_ref,
			   definition_version, input, has_input
			 )
			 VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)
			 ON CONFLICT (id) DO NOTHING
			 RETURNING ${RUN_COLUMNS}`,
			[
				run.id,
				run.kind,
				run.name,
				run.rootRunId,
				run.parentRunId ?? null,
				run.parentStepKey ?? null,
				run.triggerType ?? null,
				run.triggerRef ?? null,
				run.definitionVersion ?? null,
				run.input === undefined ? null : canonicalJson(run.input),
				run.input !== undefined,
			],
		);
		if (inserted.rows[0]) {
			await this.appendEventTx(client, {
				runId: run.id,
				category: "lifecycle",
				type: "run.created",
				payload: { kind: run.kind, name: run.name },
				idempotencyKey: `run:${run.id}:created`,
			});
			return mapRun(inserted.rows[0]);
		}
		const existing = await client.query<RunRow>(
			`${RUN_SELECT} WHERE id = $1 FOR UPDATE`,
			[run.id],
		);
		const row = existing.rows[0];
		if (!row) throw new StoreConflictError(`Run "${run.id}" disappeared`);
		const record = mapRun(row);
		if (
			record.kind !== run.kind ||
			record.name !== run.name ||
			record.rootRunId !== run.rootRunId ||
			record.parentRunId !== run.parentRunId
		) {
			throw new StoreConflictError(
				`Run "${run.id}" already exists with different identity`,
			);
		}
		return record;
	}

	private async appendEventTx(
		client: PoolClient,
		event: NewRunEvent,
	): Promise<AppendEventResult> {
		assertStoreKey(event.runId, "run ID");
		assertStoreKey(event.type, "event type");
		const payload = normalizeJsonValue(event.payload ?? {});
		assertEventPayload(payload);
		const digest = valueDigest({ type: event.type, payload });

		const locked = await client.query(
			`SELECT id FROM render_factory.runs WHERE id = $1 FOR UPDATE`,
			[event.runId],
		);
		if ((locked.rowCount ?? 0) !== 1) {
			throw new StoreConflictError(`Run "${event.runId}" does not exist`);
		}

		if (event.idempotencyKey) {
			assertStoreKey(event.idempotencyKey, "event idempotency key");
			const existing = await client.query<RunEventRow>(
				`SELECT position, id, run_id, seq, ts, category, type,
				        execution_id, step_key, agent_name, payload,
				        payload_digest, version, idempotency_key,
				        correlation_id, causation_id
				 FROM render_factory.run_events
				 WHERE run_id = $1 AND idempotency_key = $2`,
				[event.runId, event.idempotencyKey],
			);
			if (existing.rows[0]) {
				const stored = mapEvent(existing.rows[0]);
				if (stored.type !== event.type || stored.payloadDigest !== digest) {
					throw new StoreConflictError(
						`Event idempotency key "${event.idempotencyKey}" conflicts`,
					);
				}
				return { kind: "duplicate", event: stored };
			}
		}

		const sequence = await client.query<{ next_event_seq: string }>(
			`UPDATE render_factory.runs
			 SET next_event_seq = next_event_seq + 1,
			     details_deleted_at = NULL,
			     updated_at = now()
			 WHERE id = $1
			 RETURNING next_event_seq`,
			[event.runId],
		);
		const seq = Number(sequence.rows[0]?.next_event_seq);
		const global = await client.query<{ value: string }>(
			`UPDATE render_factory.counters
			 SET value = value + 1
			 WHERE name = 'event_position'
			 RETURNING value`,
		);
		const position = Number(global.rows[0]?.value);
		const inserted = await client.query<RunEventRow>(
			`INSERT INTO render_factory.run_events (
			   position, id, run_id, seq, category, type, execution_id, step_key,
			   agent_name, payload, payload_digest, version, idempotency_key,
			   correlation_id, causation_id
			 )
			 VALUES (
			   $1, $2, $3, $4, $5, $6, $7, $8,
			   $9, $10, $11, $12, $13, $14, $15
			 )
			 RETURNING position, id, run_id, seq, ts, category, type,
			           execution_id, step_key, agent_name, payload,
			           payload_digest, version, idempotency_key,
			           correlation_id, causation_id`,
			[
				position,
				randomUUID(),
				event.runId,
				seq,
				event.category,
				event.type,
				event.executionId ?? null,
				event.stepKey ?? null,
				event.agentName ?? null,
				canonicalJson(payload),
				digest,
				event.version ?? 1,
				event.idempotencyKey ?? null,
				event.correlationId ?? null,
				event.causationId ?? null,
			],
		);
		return { kind: "appended", event: mapEvent(inserted.rows[0]) };
	}

	private async listRuns(query: RunQuery = {}): Promise<RunRecord[]> {
		const params: unknown[] = [];
		const where: string[] = [];
		const add = (clause: string, value: unknown) => {
			params.push(value);
			where.push(clause.replace("?", `$${params.length}`));
		};
		if (query.kind) add("kind = ?", query.kind);
		if (query.name) add("name = ?", query.name);
		if (query.status) add("status = ?", query.status);
		if (query.rootRunId) add("root_run_id = ?", query.rootRunId);
		if (query.parentRunId) add("parent_run_id = ?", query.parentRunId);
		if (query.triggerType) add("trigger_type = ?", query.triggerType);
		if (query.triggerRef) add("trigger_ref = ?", query.triggerRef);
		if (query.before) {
			params.push(query.before);
			where.push(
				`(created_at, id) < (
				   SELECT created_at, id FROM render_factory.runs
				   WHERE id = $${params.length}
				 )`,
			);
		}
		params.push(boundedLimit(query.limit));
		const result = await this.pool.query<RunRow>(
			`${RUN_SELECT}
			 ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY created_at DESC, id DESC
			 LIMIT $${params.length}`,
			params,
		);
		return result.rows.map(mapRun);
	}

	private async getStep<T>(
		runId: string,
		key: string,
	): Promise<RunStep<T> | null> {
		assertStoreKey(runId, "run ID");
		assertStoreKey(key, "step key");
		const result = await this.pool.query<RunStepRow>(
			`${STEP_SELECT}
			 WHERE run_id = $1 AND step_key = $2`,
			[runId, key],
		);
		return result.rows[0] ? (mapStep(result.rows[0]) as RunStep<T>) : null;
	}

	private async beginExecutionTx(
		client: PoolClient,
		runId: string,
		executionId: string,
		ttlSeconds: number,
	): Promise<BeginExecutionResult> {
		assertStoreKey(runId, "run ID");
		assertStoreKey(executionId, "execution ID");
		assertPositiveInteger(ttlSeconds, "execution TTL");
		const run = await client.query<{
			next_execution_fence: string;
			status: string;
		}>(
			`SELECT next_execution_fence, status
			 FROM render_factory.runs
			 WHERE id = $1
			 FOR UPDATE`,
			[runId],
		);
		if (!run.rows[0]) {
			throw new StoreConflictError(`Run "${runId}" does not exist`);
		}
		if (isTerminal(run.rows[0].status)) {
			throw new StoreConflictError(`Run "${runId}" is already terminal`);
		}
		const active = await client.query<ExecutionRow & { lease_active: boolean }>(
			`SELECT ${EXECUTION_COLUMNS}, lease_expires_at > now() AS lease_active
			 FROM render_factory.run_executions
			 WHERE run_id = $1 AND status = 'running'
			 FOR UPDATE`,
			[runId],
		);
		const current = active.rows[0];
		if (current?.lease_active) {
			return { kind: "busy" };
		}
		if (current) {
			await client.query(
				`UPDATE render_factory.run_executions
				 SET status = 'lost', finished_at = now()
				 WHERE id = $1`,
				[current.id],
			);
			await this.appendEventTx(client, {
				runId,
				category: "execution",
				type: "execution.lost",
				executionId: current.id,
				payload: { attempt: current.attempt },
				idempotencyKey: `execution:${current.id}:lost`,
			});
		}
		const next = await client.query<{
			next_execution_fence: string;
		}>(
			`UPDATE render_factory.runs
			 SET next_execution_fence = next_execution_fence + 1,
			     status = 'running',
			     started_at = COALESCE(started_at, now()),
			     updated_at = now()
			 WHERE id = $1
			 RETURNING next_execution_fence`,
			[runId],
		);
		const attempts = await client.query<{ attempt: number }>(
			`SELECT COALESCE(max(attempt), 0)::int + 1 AS attempt
			 FROM render_factory.run_executions
			 WHERE run_id = $1`,
			[runId],
		);
		const attempt = Number(attempts.rows[0]?.attempt ?? 1);
		const fence = Number(next.rows[0]?.next_execution_fence);
		const token = randomUUID();
		const inserted = await client.query<ExecutionRow>(
			`INSERT INTO render_factory.run_executions (
			   id, run_id, attempt, status, token, fence,
			   lease_expires_at
			 )
			 VALUES (
			   $1, $2, $3, 'running', $4, $5,
			   now() + ($6 * interval '1 second')
			 )
			 RETURNING ${EXECUTION_COLUMNS}`,
			[executionId, runId, attempt, token, fence, ttlSeconds],
		);
		await this.appendEventTx(client, {
			runId,
			category: "execution",
			type: "execution.started",
			executionId,
			payload: { attempt, fence },
			idempotencyKey: `execution:${executionId}:started`,
		});
		return {
			kind: "acquired",
			execution: mapExecution(inserted.rows[0]),
		};
	}

	private async refreshExecution(
		execution: ExecutionHandle,
		ttlSeconds: number,
	): Promise<ExecutionHandle> {
		assertPositiveInteger(ttlSeconds, "execution TTL");
		const result = await this.pool.query<ExecutionRow>(
			`UPDATE render_factory.run_executions
			 SET heartbeat_at = now(),
			     lease_expires_at = now() + ($5 * interval '1 second')
			 WHERE id = $1 AND run_id = $2 AND token = $3 AND fence = $4
			   AND status = 'running' AND lease_expires_at > now()
			 RETURNING ${EXECUTION_COLUMNS}`,
			[
				execution.id,
				execution.runId,
				execution.token,
				execution.fence,
				ttlSeconds,
			],
		);
		if (!result.rows[0]) {
			throw new LeaseLostError(
				`Execution lease for "${execution.runId}" was lost`,
			);
		}
		return mapExecution(result.rows[0]);
	}

	private async releaseExecutionTx(
		client: PoolClient,
		execution: ExecutionHandle,
	): Promise<void> {
		await client.query(
			`SELECT id
			 FROM render_factory.runs
			 WHERE id = $1
			 FOR UPDATE`,
			[execution.runId],
		);
		const result = await client.query(
			`UPDATE render_factory.run_executions
			 SET status = 'failed', finished_at = now()
			 WHERE id = $1 AND run_id = $2 AND token = $3 AND fence = $4
			   AND status = 'running'`,
			[
				execution.id,
				execution.runId,
				execution.token,
				execution.fence,
			],
		);
		if ((result.rowCount ?? 0) === 0) return;
		await this.appendEventTx(client, {
			runId: execution.runId,
			category: "execution",
			type: "execution.failed",
			executionId: execution.id,
			payload: {},
			idempotencyKey: `execution:${execution.id}:released`,
		});
	}

	private async requireExecutionTx(
		client: PoolClient,
		execution: ExecutionHandle,
	): Promise<ExecutionRow> {
		const run = await client.query(
			`SELECT id
			 FROM render_factory.runs
			 WHERE id = $1
			 FOR UPDATE`,
			[execution.runId],
		);
		if ((run.rowCount ?? 0) !== 1) {
			throw new StoreConflictError(
				`Run "${execution.runId}" does not exist`,
			);
		}
		const result = await client.query<ExecutionRow>(
			`${EXECUTION_SELECT}
			 WHERE id = $1 AND run_id = $2 AND token = $3 AND fence = $4
			   AND status = 'running' AND lease_expires_at > now()
			 FOR NO KEY UPDATE`,
			[
				execution.id,
				execution.runId,
				execution.token,
				execution.fence,
			],
		);
		if (!result.rows[0]) {
			throw new LeaseLostError(
				`Execution lease for "${execution.runId}" was lost`,
			);
		}
		return result.rows[0];
	}

	private async beginStepTx<T>(
		client: PoolClient,
		runId: string,
		key: string,
		replayPolicy: ReplayPolicy,
		execution: ExecutionHandle,
	): Promise<BeginStepResult<T>> {
		assertExecutionRun(runId, execution);
		assertStoreKey(key, "step key");
		await this.requireExecutionTx(client, execution);
		const selected = await client.query<RunStepRow>(
			`${STEP_SELECT}
			 WHERE run_id = $1 AND step_key = $2
			 FOR UPDATE`,
			[runId, key],
		);
		const existing = selected.rows[0];
		if (existing?.status === "completed") {
			await this.appendEventTx(client, {
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
				value: existing.result as T,
				generation: Number(existing.generation),
			};
		}
		if (existing?.status === "started" && existing.execution_id) {
			if (existing.execution_id === execution.id) {
				return { kind: "execute", generation: Number(existing.generation) };
			}
			const owner = await client.query<{
				status: string;
				lease_active: boolean;
			}>(
				`SELECT status, lease_expires_at > now() AS lease_active
				 FROM render_factory.run_executions
				 WHERE id = $1`,
				[existing.execution_id],
			);
			const active =
				owner.rows[0]?.status === "running" &&
				owner.rows[0].lease_active;
			if (active) return { kind: "busy" };
			if (existing.replay_policy === "guarded") {
				return {
					kind: "blocked",
					reason: "interrupted_guarded_step",
				};
			}
		}
		const generation = Number(existing?.generation ?? 0);
		await client.query(
			`INSERT INTO render_factory.run_steps (
			   run_id, step_key, generation, status, replay_policy,
			   execution_id, result, error_code, started_at, finished_at,
			   duration_ms, updated_at
			 )
			 VALUES ($1, $2, $3, 'started', $4, $5, NULL, NULL, now(), NULL, NULL, now())
			 ON CONFLICT (run_id, step_key) DO UPDATE SET
			   status = 'started',
			   replay_policy = EXCLUDED.replay_policy,
			   execution_id = EXCLUDED.execution_id,
			   result = NULL,
			   error_code = NULL,
			   started_at = now(),
			   finished_at = NULL,
			   duration_ms = NULL,
			   updated_at = now()`,
			[runId, key, generation, replayPolicy, execution.id],
		);
		await this.appendEventTx(client, {
			runId,
			category: "step",
			type: "step.started",
			executionId: execution.id,
			stepKey: key,
			payload: { generation, replayPolicy },
			idempotencyKey: `step:${key}:${generation}:started:${execution.id}`,
		});
		return { kind: "execute", generation };
	}

	private async completeStepTx<T>(
		client: PoolClient,
		runId: string,
		key: string,
		value: T,
		execution: ExecutionHandle,
	): Promise<T> {
		assertExecutionRun(runId, execution);
		await this.requireExecutionTx(client, execution);
		const normalized = normalizeJsonValue(value);
		const updated = await client.query<RunStepRow>(
			`UPDATE render_factory.run_steps
			 SET status = 'completed',
			     result = $4,
			     finished_at = now(),
			     duration_ms = GREATEST(0, round(extract(epoch FROM (now() - started_at)) * 1000)),
			     updated_at = now()
			 WHERE run_id = $1 AND step_key = $2
			   AND status = 'started' AND execution_id = $3
			 RETURNING ${STEP_COLUMNS}`,
			[runId, key, execution.id, canonicalJson(normalized)],
		);
		const step = updated.rows[0];
		if (!step) {
			throw new StoreConflictError(`Step "${key}" is not owned by execution`);
		}
		await this.appendEventTx(client, {
			runId,
			category: "step",
			type: "step.completed",
			executionId: execution.id,
			stepKey: key,
			payload: {
				generation: Number(step.generation),
				durationMs: Number(step.duration_ms ?? 0),
			},
			idempotencyKey: `step:${key}:${step.generation}:completed`,
		});
		return normalized;
	}

	private async failStepTx(
		client: PoolClient,
		runId: string,
		key: string,
		errorCode: string,
		execution: ExecutionHandle,
	): Promise<void> {
		assertExecutionRun(runId, execution);
		assertStoreKey(errorCode, "step error code");
		await this.requireExecutionTx(client, execution);
		const updated = await client.query<RunStepRow>(
			`UPDATE render_factory.run_steps
			 SET status = 'failed',
			     generation = generation + 1,
			     error_code = $4,
			     finished_at = now(),
			     duration_ms = GREATEST(0, round(extract(epoch FROM (now() - started_at)) * 1000)),
			     updated_at = now()
			 WHERE run_id = $1 AND step_key = $2
			   AND status = 'started' AND execution_id = $3
			 RETURNING ${STEP_COLUMNS}`,
			[runId, key, execution.id, errorCode],
		);
		const step = updated.rows[0];
		if (!step) return;
		await this.appendEventTx(client, {
			runId,
			category: "step",
			type: "step.failed",
			executionId: execution.id,
			stepKey: key,
			payload: {
				generation: Number(step.generation) - 1,
				errorCode,
			},
			idempotencyKey: `step:${key}:${Number(step.generation) - 1}:failed:${execution.id}`,
		});
	}

	private async invalidateStepsTx(
		client: PoolClient,
		runId: string,
		keys: readonly string[],
		reason: string,
		execution: ExecutionHandle,
	): Promise<void> {
		assertExecutionRun(runId, execution);
		assertStoreKey(reason, "invalidation reason");
		await this.requireExecutionTx(client, execution);
		for (const key of new Set(keys)) {
			assertStoreKey(key, "step key");
			const updated = await client.query<RunStepRow>(
				`INSERT INTO render_factory.run_steps (
				   run_id, step_key, generation, status, replay_policy,
				   execution_id, error_code, updated_at
				 )
				 VALUES ($1, $2, 0, 'invalidated', 'safe', $3, $4, now())
				 ON CONFLICT (run_id, step_key) DO UPDATE SET
				   generation = render_factory.run_steps.generation + 1,
				   status = 'invalidated',
				   execution_id = EXCLUDED.execution_id,
				   result = NULL,
				   error_code = EXCLUDED.error_code,
				   started_at = NULL,
				   finished_at = NULL,
				   duration_ms = NULL,
				   updated_at = now()
				 RETURNING ${STEP_COLUMNS}`,
				[runId, key, execution.id, reason],
			);
			const step = updated.rows[0];
			await this.appendEventTx(client, {
				runId,
				category: "step",
				type: "step.invalidated",
				executionId: execution.id,
				stepKey: key,
				payload: { generation: Number(step.generation), reason },
				idempotencyKey: `step:${key}:${step.generation}:invalidated`,
			});
		}
	}

	private async incrementFailureCountTx(
		client: PoolClient,
		runId: string,
		execution: ExecutionHandle,
	): Promise<number> {
		assertExecutionRun(runId, execution);
		await this.requireExecutionTx(client, execution);
		const counted = await client.query(
			`UPDATE render_factory.run_executions
			 SET failure_counted = true
			 WHERE id = $1 AND run_id = $2 AND failure_counted = false
			 RETURNING id`,
			[execution.id, runId],
		);
		if ((counted.rowCount ?? 0) === 0) {
			const current = await client.query<{ failure_count: number }>(
				`SELECT failure_count
				 FROM render_factory.runs
				 WHERE id = $1`,
				[runId],
			);
			if (!current.rows[0]) {
				throw new StoreConflictError(`Run "${runId}" does not exist`);
			}
			return Number(current.rows[0].failure_count);
		}
		const updated = await client.query<{ failure_count: number }>(
			`UPDATE render_factory.runs
			 SET failure_count = failure_count + 1, updated_at = now()
			 WHERE id = $1
			 RETURNING failure_count`,
			[runId],
		);
		if (!updated.rows[0]) {
			throw new StoreConflictError(`Run "${runId}" does not exist`);
		}
		return Number(updated.rows[0].failure_count);
	}

	private async recordUsageTx(
		client: PoolClient,
		runId: string,
		inputTokens: number,
		outputTokens: number,
		model: string,
		execution?: ExecutionHandle,
	): Promise<void> {
		if (execution) assertExecutionRun(runId, execution);
		if (
			!Number.isSafeInteger(inputTokens) ||
			inputTokens < 0 ||
			!Number.isSafeInteger(outputTokens) ||
			outputTokens < 0
		) {
			throw new StoreConflictError("Token usage must be nonnegative integers");
		}
		assertStoreKey(model, "model");
		if (execution) await this.requireExecutionTx(client, execution);
		const current = await client.query<{ total_model_calls: number }>(
			`SELECT total_model_calls FROM render_factory.runs WHERE id = $1 FOR UPDATE`,
			[runId],
		);
		if (!current.rows[0]) {
			throw new StoreConflictError(`Run "${runId}" does not exist`);
		}
		const nextCall = current.rows[0].total_model_calls + 1;
		await client.query(
			`UPDATE render_factory.runs
			 SET total_input_tokens = total_input_tokens + $2,
			     total_output_tokens = total_output_tokens + $3,
			     total_model_calls = $4,
			     updated_at = now()
			 WHERE id = $1`,
			[runId, inputTokens, outputTokens, nextCall],
		);
		await this.appendEventTx(client, {
			runId,
			category: "agent",
			type: "agent.usage",
			executionId: execution?.id,
			payload: { inputTokens, outputTokens, model },
			idempotencyKey: execution
				? `usage:${execution.id}:${nextCall}`
				: undefined,
		});
	}

	private async addLinkTx(
		client: PoolClient,
		link: Omit<RunLink, "createdAt">,
	): Promise<RunLink> {
		assertStoreKey(link.runId, "run ID");
		assertStoreKey(link.kind, "run link kind");
		assertStoreKey(link.externalId, "run link external ID");
		const inserted = await client.query<RunLinkRow>(
			`INSERT INTO render_factory.run_links (
			   run_id, kind, external_id, url, metadata
			 )
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (run_id, kind, external_id) DO UPDATE SET
			   url = COALESCE(EXCLUDED.url, render_factory.run_links.url),
			   metadata = render_factory.run_links.metadata || EXCLUDED.metadata
			 RETURNING run_id, kind, external_id, url, metadata, created_at`,
			[
				link.runId,
				link.kind,
				link.externalId,
				link.url ?? null,
				canonicalJson(link.metadata ?? {}),
			],
		);
		await this.appendEventTx(client, {
			runId: link.runId,
			category: "external",
			type: "external.linked",
			payload: { kind: link.kind, externalId: link.externalId },
			idempotencyKey: `link:${link.kind}:${link.externalId}`,
		});
		return mapLink(inserted.rows[0]);
	}

	private async acceptDeliveryTx(
		client: PoolClient,
		input: AcceptDeliveryInput,
	): Promise<AcceptDeliveryResult> {
		validateDelivery(input);
		await client.query(
			`SELECT pg_advisory_xact_lock(
			   hashtext($1), hashtext($2)
			 )`,
			[input.provider, input.deliveryId],
		);
		const existing = await this.getLiveInboxTx(
			client,
			input.provider,
			input.deliveryId,
			input.deliveryTtlSeconds,
		);
		if (existing) {
			if (!existing.run_id) {
				throw new StoreConflictError(
					"Delivery no longer references a run",
				);
			}
			if (existing.payload_digest !== input.payloadDigest) {
				throw new StoreConflictError(
					"Delivery ID was reused with a different payload",
				);
			}
			return {
				kind: existing.status,
				runId: existing.run_id,
			};
		}

		if (
			input.subjectKey &&
			!(await this.acquireLeaseTx(
				client,
				input.subjectKey,
				input.run.id,
				input.subjectLeaseTtlSeconds ?? input.deliveryTtlSeconds,
			))
		) {
			const owner = await client.query<{ owner_id: string }>(
				`SELECT owner_id
				 FROM render_factory.leases
				 WHERE resource_key = $1 AND expires_at > now()`,
				[input.subjectKey],
			);
			return {
				kind: "subject_busy",
				activeRunId: owner.rows[0]?.owner_id,
			};
		}

		await this.ensureRunTx(client, input.run);
		await client.query(
			`INSERT INTO render_factory.inbox_deliveries (
			   provider, delivery_id, run_id, subject_key, payload_digest,
			   status, expires_at
			 )
			 VALUES (
			   $1, $2, $3, $4, $5, 'pending',
			   now() + ($6 * interval '1 second')
			 )`,
			[
				input.provider,
				input.deliveryId,
				input.run.id,
				input.subjectKey ?? null,
				input.payloadDigest,
				input.deliveryTtlSeconds,
			],
		);
		return { kind: "accepted", runId: input.run.id };
	}

	private async getLiveInboxTx(
		client: PoolClient,
		provider: string,
		deliveryId: string,
		refreshTtlSeconds: number,
	): Promise<InboxRow | undefined> {
		const selected = await client.query<InboxRow & { live: boolean }>(
			`SELECT provider, delivery_id, run_id, subject_key, payload_digest,
			        status, expires_at, expires_at > now() AS live
			 FROM render_factory.inbox_deliveries
			 WHERE provider = $1 AND delivery_id = $2`,
			[provider, deliveryId],
		);
		const found = selected.rows[0];
		if (!found) return undefined;
		if (found.live) {
			const locked = await client.query<InboxRow>(
				`SELECT provider, delivery_id, run_id, subject_key,
				        payload_digest, status, expires_at
				 FROM render_factory.inbox_deliveries
				 WHERE provider = $1 AND delivery_id = $2
				 FOR UPDATE`,
				[provider, deliveryId],
			);
			return locked.rows[0];
		}

		let runStatus: string | undefined;
		if (found.run_id) {
			const run = await client.query<{ status: string }>(
				`SELECT status FROM render_factory.runs
				 WHERE id = $1
				 FOR UPDATE`,
				[found.run_id],
			);
			runStatus = run.rows[0]?.status;
		}
		const locked = await client.query<InboxRow>(
			`SELECT provider, delivery_id, run_id, subject_key,
			        payload_digest, status, expires_at
			 FROM render_factory.inbox_deliveries
			 WHERE provider = $1 AND delivery_id = $2
			   AND expires_at <= now()
			 FOR UPDATE`,
			[provider, deliveryId],
		);
		const expired = locked.rows[0];
		if (!expired) return this.getLiveInboxTx(
			client,
			provider,
			deliveryId,
			refreshTtlSeconds,
		);

		if (expired.run_id) {
			const active = await client.query(
				`SELECT 1 FROM render_factory.run_executions
				 WHERE run_id = $1 AND status = 'running'
				   AND lease_expires_at > now()
				 LIMIT 1`,
				[expired.run_id],
			);
			if ((active.rowCount ?? 0) > 0) {
				const refreshed = await client.query<InboxRow>(
					`UPDATE render_factory.inbox_deliveries
					 SET expires_at = now() + ($3 * interval '1 second')
					 WHERE provider = $1 AND delivery_id = $2
					 RETURNING provider, delivery_id, run_id, subject_key,
					           payload_digest, status, expires_at`,
					[provider, deliveryId, refreshTtlSeconds],
				);
				return refreshed.rows[0];
			}
		}

		if (expired.run_id && runStatus && !isTerminal(runStatus)) {
			await this.appendEventTx(client, {
				runId: expired.run_id,
				category: "lifecycle",
				type: "run.cancelled",
				payload: { reason: "delivery_expired" },
				idempotencyKey: `run:${expired.run_id}:delivery-expired`,
			});
			await client.query(
				`UPDATE render_factory.runs
				 SET status = 'cancelled',
				     error_code = 'delivery_expired',
				     finished_at = now(),
				     updated_at = now()
				 WHERE id = $1`,
				[expired.run_id],
			);
			await client.query(
				`DELETE FROM render_factory.leases
				 WHERE owner_id = $1`,
				[expired.run_id],
			);
		}
		await client.query(
			`DELETE FROM render_factory.inbox_deliveries
			 WHERE provider = $1 AND delivery_id = $2`,
			[provider, deliveryId],
		);
		return undefined;
	}

	private async markDispatched(
		provider: string,
		deliveryId: string,
	): Promise<void> {
		assertStoreKey(provider, "delivery provider");
		assertStoreKey(deliveryId, "delivery ID");
		const updated = await this.pool.query(
			`UPDATE render_factory.inbox_deliveries
			 SET status = 'dispatched',
			     dispatched_at = COALESCE(dispatched_at, now())
			 WHERE provider = $1 AND delivery_id = $2
			   AND status IN ('pending', 'dispatched')
			   AND expires_at > now()`,
			[provider, deliveryId],
		);
		if ((updated.rowCount ?? 0) !== 1) {
			throw new StoreConflictError("Delivery claim was lost");
		}
	}

	private async abandonDeliveryTx(
		client: PoolClient,
		provider: string,
		deliveryId: string,
	): Promise<void> {
		assertStoreKey(provider, "delivery provider");
		assertStoreKey(deliveryId, "delivery ID");
		await client.query(
			`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
			[provider, deliveryId],
		);
		const found = await client.query<{
			run_id: string;
			subject_key: string | null;
		}>(
			`SELECT run_id, subject_key
			 FROM render_factory.inbox_deliveries
			 WHERE provider = $1 AND delivery_id = $2 AND status = 'pending'`,
			[provider, deliveryId],
		);
		const row = found.rows[0];
		if (!row) return;
		const run = await client.query<{ status: string }>(
			`SELECT status
			 FROM render_factory.runs
			 WHERE id = $1
			 FOR UPDATE`,
			[row.run_id],
		);
		const lockedDelivery = await client.query(
			`SELECT 1
			 FROM render_factory.inbox_deliveries
			 WHERE provider = $1 AND delivery_id = $2 AND status = 'pending'
			 FOR UPDATE`,
			[provider, deliveryId],
		);
		if ((lockedDelivery.rowCount ?? 0) === 0) return;
		const activeExecution = await client.query(
			`SELECT 1
			 FROM render_factory.run_executions
			 WHERE run_id = $1 AND status = 'running'
			   AND lease_expires_at > now()
			 LIMIT 1`,
			[row.run_id],
		);
		if ((activeExecution.rowCount ?? 0) > 0) {
			await client.query(
				`UPDATE render_factory.inbox_deliveries
				 SET status = 'dispatched',
				     dispatched_at = COALESCE(dispatched_at, now())
				 WHERE provider = $1 AND delivery_id = $2`,
				[provider, deliveryId],
			);
			return;
		}
		if (run.rows[0] && !isTerminal(run.rows[0].status)) {
			await this.appendEventTx(client, {
				runId: row.run_id,
				category: "lifecycle",
				type: "run.cancelled",
				payload: { reason: "dispatch_abandoned" },
				idempotencyKey: `run:${row.run_id}:dispatch-abandoned`,
			});
			await client.query(
				`UPDATE render_factory.runs
				 SET status = 'cancelled', error_code = 'dispatch_abandoned',
				     finished_at = now(), updated_at = now()
				 WHERE id = $1`,
				[row.run_id],
			);
		}
		await client.query(
			`DELETE FROM render_factory.inbox_deliveries
			 WHERE provider = $1 AND delivery_id = $2`,
			[provider, deliveryId],
		);
		if (row.subject_key) {
			await client.query(
				`DELETE FROM render_factory.leases
				 WHERE resource_key = $1 AND owner_id = $2`,
				[row.subject_key, row.run_id],
			);
		}
	}

	private async acquireLeaseTx(
		client: PoolClient,
		resourceKey: string,
		ownerId: string,
		ttlSeconds: number,
	): Promise<LeaseHandle | null> {
		assertStoreKey(resourceKey, "lease resource key");
		assertStoreKey(ownerId, "lease owner");
		assertPositiveInteger(ttlSeconds, "lease TTL");
		const result = await client.query<LeaseRow>(
			`INSERT INTO render_factory.leases (
			   resource_key, owner_id, token, expires_at
			 )
			 VALUES (
			   $1, $2, $3, now() + ($4 * interval '1 second')
			 )
			 ON CONFLICT (resource_key) DO UPDATE SET
			   owner_id = EXCLUDED.owner_id,
			   token = CASE
			     WHEN render_factory.leases.owner_id = EXCLUDED.owner_id
			       AND render_factory.leases.expires_at > now()
			       THEN render_factory.leases.token
			     ELSE EXCLUDED.token
			   END,
			   fence = CASE
			     WHEN render_factory.leases.owner_id = EXCLUDED.owner_id
			       AND render_factory.leases.expires_at > now()
			       THEN render_factory.leases.fence
			     ELSE nextval(pg_get_serial_sequence('render_factory.leases', 'fence'))
			   END,
			   expires_at = EXCLUDED.expires_at,
			   updated_at = now()
			 WHERE render_factory.leases.expires_at <= now()
			    OR render_factory.leases.owner_id = EXCLUDED.owner_id
			 RETURNING resource_key, owner_id, token, fence, expires_at`,
			[resourceKey, ownerId, randomUUID(), ttlSeconds],
		);
		return result.rows[0] ? mapLease(result.rows[0]) : null;
	}

	private async refreshLease(
		lease: LeaseHandle,
		ttlSeconds: number,
	): Promise<LeaseHandle> {
		assertStoreKey(lease.resourceKey, "lease resource key");
		assertStoreKey(lease.ownerId, "lease owner");
		assertPositiveInteger(ttlSeconds, "lease TTL");
		const result = await this.pool.query<LeaseRow>(
			`UPDATE render_factory.leases
			 SET expires_at = now() + ($3 * interval '1 second'),
			     updated_at = now()
			 WHERE resource_key = $1 AND owner_id = $2
			   AND token = $4 AND fence = $5
			   AND expires_at > now()
			 RETURNING resource_key, owner_id, token, fence, expires_at`,
			[
				lease.resourceKey,
				lease.ownerId,
				ttlSeconds,
				lease.token,
				lease.fence,
			],
		);
		if (!result.rows[0]) {
			throw new LeaseLostError(`Lease "${lease.resourceKey}" was lost`);
		}
		return mapLease(result.rows[0]);
	}

	private async releaseLease(lease: LeaseHandle): Promise<void> {
		await this.pool.query(
			`DELETE FROM render_factory.leases
			 WHERE resource_key = $1 AND owner_id = $2
			   AND token = $3 AND fence = $4`,
			[lease.resourceKey, lease.ownerId, lease.token, lease.fence],
		);
	}

	private async putArtifact(input: {
		runId: string;
		namespace: string;
		content: string;
		mediaType?: string;
		ttlSeconds: number;
	}): Promise<string> {
		assertStoreKey(input.runId, "artifact run ID");
		assertStoreKey(input.namespace, "artifact namespace");
		assertPositiveInteger(input.ttlSeconds, "artifact TTL");
		const ref = artifactRef(input.runId, input.namespace);
		const bytes = Buffer.from(input.content, "utf8");
		await this.pool.query(
			`INSERT INTO render_factory.artifacts (
			   ref, run_id, namespace, media_type, content,
			   size_bytes, sha256, expires_at
			 )
			 VALUES (
			   $1, $2, $3, $4, $5, $6, $7,
			   now() + ($8 * interval '1 second')
			 )`,
			[
				ref,
				input.runId,
				input.namespace,
				input.mediaType ?? "text/plain; charset=utf-8",
				bytes,
				bytes.byteLength,
				createHash("sha256").update(bytes).digest("hex"),
				input.ttlSeconds,
			],
		);
		return ref;
	}

	private async getArtifact(
		ref: string,
		refreshTtlSeconds?: number,
	): Promise<ArtifactRecord | null> {
		if (refreshTtlSeconds !== undefined) {
			assertPositiveInteger(refreshTtlSeconds, "artifact TTL");
		}
		const result =
			refreshTtlSeconds === undefined
				? await this.pool.query<ArtifactRow>(
						`SELECT ref, run_id, namespace, media_type, content,
						        size_bytes, sha256, expires_at
						 FROM render_factory.artifacts
						 WHERE ref = $1 AND expires_at > now()`,
						[ref],
					)
				: await this.pool.query<ArtifactRow>(
						`UPDATE render_factory.artifacts
						 SET accessed_at = now(),
						     expires_at = now() + ($2 * interval '1 second')
						 WHERE ref = $1 AND expires_at > now()
						 RETURNING ref, run_id, namespace, media_type, content,
						           size_bytes, sha256, expires_at`,
						[ref, refreshTtlSeconds],
					);
		const row = result.rows[0];
		return row
			? {
					ref: row.ref,
					runId: row.run_id,
					namespace: row.namespace,
					content: Buffer.from(row.content).toString("utf8"),
					mediaType: row.media_type,
					sizeBytes: Number(row.size_bytes),
					sha256: row.sha256,
					expiresAt: iso(row.expires_at),
				}
			: null;
	}

	private async appendConversationTx(
		client: PoolClient,
		provider: string,
		externalConversationId: string,
		message: Omit<ConversationMessage, "conversationId">,
		options: { ttlSeconds: number; maxMessages: number },
	): Promise<boolean> {
		assertStoreKey(provider, "conversation provider");
		assertStoreKey(externalConversationId, "external conversation ID");
		assertStoreKey(message.id, "conversation message ID");
		assertPositiveInteger(options.ttlSeconds, "conversation TTL");
		assertPositiveInteger(options.maxMessages, "maximum messages");
		const conversationId = createHash("sha256")
			.update(`${provider}\0${externalConversationId}`)
			.digest("hex");
		await client.query(
			`DELETE FROM render_factory.conversations
			 WHERE provider = $1 AND external_id = $2 AND expires_at <= now()`,
			[provider, externalConversationId],
		);
		await client.query(
			`INSERT INTO render_factory.conversations (
			   id, provider, external_id, expires_at
			 )
			 VALUES (
			   $1, $2, $3, now() + ($4 * interval '1 second')
			 )
			 ON CONFLICT (provider, external_id) DO UPDATE SET
			   updated_at = now(),
			   expires_at = EXCLUDED.expires_at`,
			[
				conversationId,
				provider,
				externalConversationId,
				options.ttlSeconds,
			],
		);
		const inserted = await client.query(
			`INSERT INTO render_factory.conversation_messages (
			   id, conversation_id, run_id, external_message_id,
			   role, content, occurred_at
			 )
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (conversation_id, external_message_id) DO NOTHING`,
			[
				message.id,
				conversationId,
				message.runId ?? null,
				message.id,
				message.role,
				message.content,
				message.occurredAt,
			],
		);
		if ((inserted.rowCount ?? 0) === 0) return false;
		await client.query(
			`DELETE FROM render_factory.conversation_messages
			 WHERE conversation_id = $1
			   AND id IN (
			     SELECT id
			     FROM render_factory.conversation_messages
			     WHERE conversation_id = $1
			     ORDER BY occurred_at DESC, id DESC
			     OFFSET $2
			   )`,
			[conversationId, options.maxMessages],
		);
		return true;
	}

	private async listConversation(
		provider: string,
		externalConversationId: string,
		limit: number,
		refreshTtlSeconds?: number,
	): Promise<ConversationMessage[]> {
		assertStoreKey(provider, "conversation provider");
		assertStoreKey(externalConversationId, "external conversation ID");
		if (refreshTtlSeconds !== undefined) {
			assertPositiveInteger(refreshTtlSeconds, "conversation TTL");
		}
		const conversation =
			refreshTtlSeconds === undefined
				? await this.pool.query<{ id: string }>(
						`SELECT id
						 FROM render_factory.conversations
						 WHERE provider = $1 AND external_id = $2
						   AND expires_at > now()`,
						[provider, externalConversationId],
					)
				: await this.pool.query<{ id: string }>(
						`UPDATE render_factory.conversations
						 SET updated_at = now(),
						     expires_at = now() + ($3 * interval '1 second')
						 WHERE provider = $1 AND external_id = $2
						   AND expires_at > now()
						 RETURNING id`,
						[provider, externalConversationId, refreshTtlSeconds],
					);
		const id = conversation.rows[0]?.id;
		if (!id) return [];
		const result = await this.pool.query<ConversationMessageRow>(
			`SELECT id, conversation_id, run_id, role, content, occurred_at
			 FROM (
			   SELECT id, conversation_id, run_id, role, content, occurred_at
			   FROM render_factory.conversation_messages
			   WHERE conversation_id = $1
			   ORDER BY occurred_at DESC, id DESC
			   LIMIT $2
			 ) recent
			 ORDER BY occurred_at, id`,
			[id, boundedLimit(limit)],
		);
		return result.rows.map(mapConversationMessage);
	}

	private async putReplyTx(
		client: PoolClient,
		provider: string,
		operationId: string,
		runId: string,
		content: string,
		ttlSeconds: number,
	): Promise<void> {
		assertStoreKey(provider, "outbound provider");
		assertStoreKey(operationId, "outbound operation ID");
		assertPositiveInteger(ttlSeconds, "outbound delivery TTL");
		await client.query(
			`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
			[provider, operationId],
		);
		await client.query(
			`DELETE FROM render_factory.outbound_deliveries
			 WHERE provider = $1 AND operation_id = $2 AND expires_at <= now()`,
			[provider, operationId],
		);
		const existing = await client.query<{
			run_id: string | null;
			content: string;
		}>(
			`SELECT run_id, content
			 FROM render_factory.outbound_deliveries
			 WHERE provider = $1 AND operation_id = $2
			 FOR UPDATE`,
			[provider, operationId],
		);
		if (
			existing.rows[0] &&
			(existing.rows[0].run_id !== runId ||
				existing.rows[0].content !== content)
		) {
			throw new StoreConflictError(
				"Outbound operation was reused with different content",
			);
		}
		if (existing.rows[0]) {
			await client.query(
				`UPDATE render_factory.outbound_deliveries
				 SET expires_at = now() + ($3 * interval '1 second')
				 WHERE provider = $1 AND operation_id = $2`,
				[provider, operationId, ttlSeconds],
			);
		} else {
			await client.query(
				`INSERT INTO render_factory.outbound_deliveries (
				   provider, operation_id, run_id, content, status, expires_at
				 )
				 VALUES (
				   $1, $2, $3, $4, 'pending',
				   now() + ($5 * interval '1 second')
				 )`,
				[provider, operationId, runId, content, ttlSeconds],
			);
		}
	}

	private async getReply(
		provider: string,
		operationId: string,
		refreshTtlSeconds?: number,
	): Promise<string | null> {
		if (refreshTtlSeconds !== undefined) {
			assertPositiveInteger(refreshTtlSeconds, "outbound delivery TTL");
		}
		const result =
			refreshTtlSeconds === undefined
				? await this.pool.query<{ content: string }>(
						`SELECT content
						 FROM render_factory.outbound_deliveries
						 WHERE provider = $1 AND operation_id = $2
						   AND expires_at > now()`,
						[provider, operationId],
					)
				: await this.pool.query<{ content: string }>(
						`UPDATE render_factory.outbound_deliveries
						 SET expires_at = now() + ($3 * interval '1 second')
						 WHERE provider = $1 AND operation_id = $2
						   AND expires_at > now()
						 RETURNING content`,
						[provider, operationId, refreshTtlSeconds],
					);
		return result.rows[0]?.content ?? null;
	}

	private async markDelivered(
		provider: string,
		operationId: string,
		providerRef?: string,
	): Promise<void> {
		const result = await this.pool.query(
			`UPDATE render_factory.outbound_deliveries
			 SET status = 'delivered', provider_ref = $3, delivered_at = now()
			 WHERE provider = $1 AND operation_id = $2
			   AND expires_at > now()`,
			[provider, operationId, providerRef ?? null],
		);
		if ((result.rowCount ?? 0) !== 1) {
			throw new StoreConflictError("Outbound delivery does not exist");
		}
	}

	private async wasDelivered(
		provider: string,
		operationId: string,
	): Promise<boolean> {
		const result = await this.pool.query(
			`SELECT 1
			 FROM render_factory.outbound_deliveries
			 WHERE provider = $1 AND operation_id = $2
			   AND status = 'delivered' AND expires_at > now()`,
			[provider, operationId],
		);
		return (result.rowCount ?? 0) === 1;
	}

	private async getKnowledge(
		namespace: string,
		key: string,
		refreshTtlSeconds?: number,
	): Promise<string | null> {
		validateKnowledgeKey(namespace, key);
		if (refreshTtlSeconds !== undefined) {
			assertPositiveInteger(refreshTtlSeconds, "knowledge TTL");
		}
		const result =
			refreshTtlSeconds === undefined
				? await this.pool.query<{ content: string }>(
						`SELECT content
						 FROM render_factory.knowledge_entries
						 WHERE namespace = $1 AND key = $2
						   AND (expires_at IS NULL OR expires_at > now())`,
						[namespace, key],
					)
				: await this.pool.query<{ content: string }>(
						`UPDATE render_factory.knowledge_entries
						 SET expires_at = CASE
						       WHEN expires_at IS NULL THEN NULL
						       ELSE now() + ($3 * interval '1 second')
						     END,
						     updated_at = now()
						 WHERE namespace = $1 AND key = $2
						   AND (expires_at IS NULL OR expires_at > now())
						 RETURNING content`,
						[namespace, key, refreshTtlSeconds],
					);
		return result.rows[0]?.content ?? null;
	}

	private async putKnowledge(
		namespace: string,
		key: string,
		content: string,
		ttlSeconds?: number,
	): Promise<void> {
		validateKnowledgeKey(namespace, key);
		if (ttlSeconds !== undefined) {
			assertPositiveInteger(ttlSeconds, "knowledge TTL");
		}
		await this.pool.query(
			`INSERT INTO render_factory.knowledge_entries (
			   namespace, key, content, expires_at
			 )
			 VALUES (
			   $1, $2, $3,
			   CASE WHEN $4::int IS NULL
			        THEN NULL
			        ELSE now() + ($4 * interval '1 second')
			   END
			 )
			 ON CONFLICT (namespace, key) DO UPDATE SET
			   content = EXCLUDED.content,
			   version = render_factory.knowledge_entries.version + 1,
			   updated_at = now(),
			   expires_at = EXCLUDED.expires_at`,
			[namespace, key, content, ttlSeconds ?? null],
		);
	}

	private async appendKnowledgeTx(
		client: PoolClient,
		namespace: string,
		key: string,
		lines: readonly string[],
		options: { maxChars: number; ttlSeconds?: number },
	): Promise<void> {
		validateKnowledgeKey(namespace, key);
		assertPositiveInteger(options.maxChars, "maximum knowledge characters");
		await client.query(
			`SELECT pg_advisory_xact_lock(
			   hashtext($1), hashtext($2)
			 )`,
			[namespace, key],
		);
		const current = await client.query<{
			content: string;
			version: string;
		}>(
			`SELECT content, version
			 FROM render_factory.knowledge_entries
			 WHERE namespace = $1 AND key = $2
			   AND (expires_at IS NULL OR expires_at > now())
			 FOR UPDATE`,
			[namespace, key],
		);
		const merged = new Set(
			(current.rows[0]?.content ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		);
		for (const line of lines.map((line) => line.trim()).filter(Boolean)) {
			merged.add(line);
		}
		const content = [...merged].join("\n").slice(-options.maxChars);
		await client.query(
			`INSERT INTO render_factory.knowledge_entries (
			   namespace, key, content, expires_at
			 )
			 VALUES (
			   $1, $2, $3,
			   CASE WHEN $4::int IS NULL
			        THEN NULL
			        ELSE now() + ($4 * interval '1 second')
			   END
			 )
			 ON CONFLICT (namespace, key) DO UPDATE SET
			   content = EXCLUDED.content,
			   version = render_factory.knowledge_entries.version + 1,
			   updated_at = now(),
			   expires_at = EXCLUDED.expires_at`,
			[namespace, key, content, options.ttlSeconds ?? null],
		);
	}
}

export function createPostgresFactoryStore(
	options?: PostgresFactoryStoreOptions,
): PostgresFactoryStore {
	return new PostgresFactoryStore(options);
}

export async function migrateFactoryStore(
	options: PostgresPoolOptions = {},
): Promise<void> {
	const pool = createPostgresPool(options);
	try {
		await migratePostgres(pool);
	} finally {
		await pool.end();
	}
}

const RUN_COLUMNS = `
id, kind, name, status, root_run_id, parent_run_id, parent_step_key,
trigger_type, trigger_ref, definition_version, input, result, error_code,
has_input, has_result, failure_count, total_input_tokens, total_output_tokens, total_model_calls,
created_at, started_at, finished_at, updated_at`;
const RUN_SELECT = `SELECT ${RUN_COLUMNS} FROM render_factory.runs`;

const EXECUTION_COLUMNS = `
id, run_id, attempt, status, token, fence, lease_expires_at,
started_at, heartbeat_at, finished_at, error_code, failure_counted`;
const EXECUTION_SELECT = `SELECT ${EXECUTION_COLUMNS}
	FROM render_factory.run_executions`;

const STEP_COLUMNS = `
run_id, step_key, generation, status, replay_policy, execution_id,
result, error_code, started_at, finished_at, duration_ms, updated_at`;
const STEP_SELECT = `SELECT ${STEP_COLUMNS} FROM render_factory.run_steps`;

interface RunRow extends QueryResultRow {
	id: string;
	kind: RunRecord["kind"];
	name: string;
	status: RunRecord["status"];
	root_run_id: string;
	parent_run_id: string | null;
	parent_step_key: string | null;
	trigger_type: string | null;
	trigger_ref: string | null;
	definition_version: string | null;
	input: unknown;
	result: unknown;
	error_code: string | null;
	has_input: boolean;
	has_result: boolean;
	failure_count: number;
	total_input_tokens: string | number;
	total_output_tokens: string | number;
	total_model_calls: number;
	created_at: Date | string;
	started_at: Date | string | null;
	finished_at: Date | string | null;
	updated_at: Date | string;
}

interface ExecutionRow extends QueryResultRow {
	id: string;
	run_id: string;
	attempt: number;
	status: "running" | "completed" | "failed" | "lost";
	token: string;
	fence: string | number;
	lease_expires_at: Date | string;
	started_at: Date | string;
	heartbeat_at: Date | string;
	finished_at: Date | string | null;
	error_code: string | null;
	failure_counted: boolean;
}

interface RunEventRow extends QueryResultRow {
	position: string | number;
	id: string;
	run_id: string;
	seq: string | number;
	ts: Date | string;
	category: StoredRunEvent["category"];
	type: string;
	execution_id: string | null;
	step_key: string | null;
	agent_name: string | null;
	payload: Record<string, unknown>;
	payload_digest: string;
	version: number;
	idempotency_key: string | null;
	correlation_id: string | null;
	causation_id: string | null;
}

interface RunStepRow extends QueryResultRow {
	run_id: string;
	step_key: string;
	generation: number;
	status: RunStep["status"];
	replay_policy: RunStep["replayPolicy"];
	execution_id: string | null;
	result: unknown;
	error_code: string | null;
	started_at: Date | string | null;
	finished_at: Date | string | null;
	duration_ms: string | number | null;
	updated_at: Date | string;
}

interface RunLinkRow extends QueryResultRow {
	run_id: string;
	kind: string;
	external_id: string;
	url: string | null;
	metadata: Record<string, unknown>;
	created_at: Date | string;
}

interface ArtifactRow extends QueryResultRow {
	ref: string;
	run_id: string;
	namespace: string;
	media_type: string;
	content: Buffer | Uint8Array;
	size_bytes: string | number;
	sha256: string;
	expires_at: Date | string;
}

interface InboxRow extends QueryResultRow {
	provider: string;
	delivery_id: string;
	run_id: string | null;
	subject_key: string | null;
	payload_digest: string;
	status: "pending" | "dispatched" | "completed";
	expires_at: Date | string;
}

interface LeaseRow extends QueryResultRow {
	resource_key: string;
	owner_id: string;
	token: string;
	fence: string | number;
	expires_at: Date | string;
}

interface ConversationMessageRow extends QueryResultRow {
	id: string;
	conversation_id: string;
	run_id: string | null;
	role: ConversationMessage["role"];
	content: string;
	occurred_at: Date | string;
}

function mapRun(row: RunRow): RunRecord {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		status: row.status,
		rootRunId: row.root_run_id,
		parentRunId: row.parent_run_id ?? undefined,
		parentStepKey: row.parent_step_key ?? undefined,
		triggerType: row.trigger_type ?? undefined,
		triggerRef: row.trigger_ref ?? undefined,
		definitionVersion: row.definition_version ?? undefined,
		...(row.has_input ? { input: row.input } : {}),
		...(row.has_result ? { result: row.result } : {}),
		errorCode: row.error_code ?? undefined,
		failureCount: Number(row.failure_count),
		totalInputTokens: Number(row.total_input_tokens),
		totalOutputTokens: Number(row.total_output_tokens),
		totalModelCalls: Number(row.total_model_calls),
		createdAt: iso(row.created_at),
		startedAt: row.started_at ? iso(row.started_at) : undefined,
		finishedAt: row.finished_at ? iso(row.finished_at) : undefined,
		updatedAt: iso(row.updated_at),
	};
}

function mapExecution(row: ExecutionRow): ExecutionHandle {
	return {
		id: row.id,
		runId: row.run_id,
		attempt: Number(row.attempt),
		token: row.token,
		fence: Number(row.fence),
		leaseExpiresAt: iso(row.lease_expires_at),
	};
}

function mapEvent(row: RunEventRow): StoredRunEvent {
	return {
		id: row.id,
		position: Number(row.position),
		runId: row.run_id,
		seq: Number(row.seq),
		ts: iso(row.ts),
		category: row.category,
		type: row.type,
		executionId: row.execution_id ?? undefined,
		stepKey: row.step_key ?? undefined,
		agentName: row.agent_name ?? undefined,
		payload: row.payload ?? {},
		payloadDigest: row.payload_digest,
		version: Number(row.version),
		idempotencyKey: row.idempotency_key ?? undefined,
		correlationId: row.correlation_id ?? undefined,
		causationId: row.causation_id ?? undefined,
	};
}

function mapStep(row: RunStepRow): RunStep {
	return {
		runId: row.run_id,
		key: row.step_key,
		generation: Number(row.generation),
		status: row.status,
		replayPolicy: row.replay_policy,
		executionId: row.execution_id ?? undefined,
		...(row.status === "completed" ? { value: row.result } : {}),
		errorCode: row.error_code ?? undefined,
		startedAt: row.started_at ? iso(row.started_at) : undefined,
		finishedAt: row.finished_at ? iso(row.finished_at) : undefined,
		durationMs:
			row.duration_ms === null ? undefined : Number(row.duration_ms),
	};
}

function mapLink(row: RunLinkRow): RunLink {
	return {
		runId: row.run_id,
		kind: row.kind,
		externalId: row.external_id,
		url: row.url ?? undefined,
		metadata: row.metadata ?? {},
		createdAt: iso(row.created_at),
	};
}

function mapConversationMessage(
	row: ConversationMessageRow,
): ConversationMessage {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		runId: row.run_id ?? undefined,
		role: row.role,
		content: row.content,
		occurredAt: iso(row.occurred_at),
	};
}

function mapLease(row: LeaseRow): LeaseHandle {
	return {
		resourceKey: row.resource_key,
		ownerId: row.owner_id,
		token: row.token,
		fence: Number(row.fence),
		expiresAt: iso(row.expires_at),
	};
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

function validateKnowledgeKey(namespace: string, key: string): void {
	assertStoreKey(namespace, "knowledge namespace");
	assertStoreKey(key, "knowledge key");
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

function boundedLimit(limit = 100): number {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new StoreConflictError("Limit must be a positive safe integer");
	}
	return Math.min(limit, 500);
}

function isTerminal(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function iso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function pgErrorCode(error: unknown): string | undefined {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code: unknown }).code === "string"
	) {
		return (error as { code: string }).code;
	}
	return undefined;
}

function isRetryablePostgresError(error: unknown): boolean {
	const code = pgErrorCode(error);
	return code === "40001" || code === "40P01";
}

function mapPostgresError(error: unknown): unknown {
	const code = pgErrorCode(error);
	switch (code) {
		case "23505":
		case "23503":
		case "23514":
			return new StoreConflictError(
				`Constraint violation: ${error instanceof Error ? error.message : String(error)}`,
			);
		default:
			return error;
	}
}
