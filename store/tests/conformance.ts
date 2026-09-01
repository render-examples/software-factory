import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FactoryStore, NewRun } from "../contracts.js";
import { StoreConflictError } from "../contracts.js";

export function runFactoryStoreConformance(
	name: string,
	createStore: () => Promise<FactoryStore> | FactoryStore,
	options: { skip?: boolean } = {},
): void {
	const suite = options.skip ? describe.skip : describe;
	suite(`${name} FactoryStore conformance`, () => {
		it("persists generic runs and idempotent ordered events", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("workflow");
				await store.runs.ensureRun(run);
				const first = await store.events.append({
					runId: run.id,
					category: "external",
					type: "external.linked",
					payload: { kind: "test", externalId: "one" },
					idempotencyKey: "external:test:one",
				});
				const duplicate = await store.events.append({
					runId: run.id,
					category: "external",
					type: "external.linked",
					payload: { externalId: "one", kind: "test" },
					idempotencyKey: "external:test:one",
				});
				expect(first.kind).toBe("appended");
				expect(duplicate.kind).toBe("duplicate");
				expect((await store.events.readRun(run.id)).map((e) => e.seq)).toEqual([
					1, 2,
				]);
				await expect(
					store.events.append({
						runId: run.id,
						category: "external",
						type: "external.linked",
						payload: { kind: "test", externalId: "different" },
						idempotencyKey: "external:test:one",
					}),
				).rejects.toBeInstanceOf(StoreConflictError);
				const nullInput = newRootRun("null-input");
				await store.runs.ensureRun({ ...nullInput, input: null });
				expect(await store.runs.getRun(nullInput.id)).toMatchObject({
					input: null,
				});
				const missingInput = newRootRun("missing-input");
				await store.runs.ensureRun(missingInput);
				expect(
					"input" in ((await store.runs.getRun(missingInput.id)) ?? {}),
				).toBe(false);
			} finally {
				await store.close();
			}
		});

		it("rejects non-JSON values consistently", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("json-contract");
				await expect(
					store.runs.ensureRun({
						...run,
						input: { when: new Date() },
					}),
				).rejects.toBeInstanceOf(StoreConflictError);
				const cyclic: { self?: unknown } = {};
				cyclic.self = cyclic;
				await store.runs.ensureRun(run);
				await expect(
					store.events.append({
						runId: run.id,
						category: "external",
						type: "external.invalid",
						payload: cyclic,
					}),
				).rejects.toBeInstanceOf(StoreConflictError);
			} finally {
				await store.close();
			}
		});

		it("rejects child runs attached across root boundaries", async () => {
			const store = await createStore();
			try {
				const first = newRootRun("root-one");
				const second = newRootRun("root-two");
				await store.runs.ensureRun(first);
				await store.runs.ensureRun(second);
				await expect(
					store.runs.ensureRun({
						id: randomUUID(),
						rootRunId: first.id,
						parentRunId: second.id,
						kind: "agent",
						name: "invalid-child",
					}),
				).rejects.toBeInstanceOf(StoreConflictError);
			} finally {
				await store.close();
			}
		});

		it("deduplicates inbox deliveries and serializes subjects", async () => {
			const store = await createStore();
			try {
				const first = newRootRun("first");
				const accepted = await store.inbox.accept({
					provider: "github",
					deliveryId: `delivery-${randomUUID()}`,
					payloadDigest: "a".repeat(64),
					subjectKey: `repo/issue/${randomUUID()}`,
					run: first,
					deliveryTtlSeconds: 600,
					subjectLeaseTtlSeconds: 600,
				});
				expect(accepted).toEqual({ kind: "accepted", runId: first.id });

				const deliveryId = `delivery-${randomUUID()}`;
				const subjectKey = `repo/issue/${randomUUID()}`;
				const second = newRootRun("second");
				expect(
					await store.inbox.accept({
						provider: "github",
						deliveryId,
						payloadDigest: "b".repeat(64),
						subjectKey,
						run: second,
						deliveryTtlSeconds: 600,
						subjectLeaseTtlSeconds: 600,
					}),
				).toEqual({ kind: "accepted", runId: second.id });
				expect(
					await store.inbox.accept({
						provider: "github",
						deliveryId,
						payloadDigest: "b".repeat(64),
						subjectKey,
						run: newRootRun("ignored"),
						deliveryTtlSeconds: 600,
						subjectLeaseTtlSeconds: 600,
					}),
				).toEqual({ kind: "pending", runId: second.id });
				await store.inbox.markDispatched("github", deliveryId);
				expect(
					(
						await store.inbox.accept({
							provider: "github",
							deliveryId,
							payloadDigest: "b".repeat(64),
							subjectKey,
							run: newRootRun("ignored"),
							deliveryTtlSeconds: 600,
							subjectLeaseTtlSeconds: 600,
						})
					).kind,
				).toBe("dispatched");

				const blocked = await store.inbox.accept({
					provider: "github",
					deliveryId: `delivery-${randomUUID()}`,
					payloadDigest: "c".repeat(64),
					subjectKey,
					run: newRootRun("blocked"),
					deliveryTtlSeconds: 600,
					subjectLeaseTtlSeconds: 600,
				});
				expect(blocked.kind).toBe("subject_busy");
			} finally {
				await store.close();
			}
		});

		it("reuses an active lease handle for the same owner", async () => {
			const store = await createStore();
			try {
				const resource = `lease-${randomUUID()}`;
				const first = await store.leases.tryAcquire(resource, "owner", 30);
				const second = await store.leases.tryAcquire(resource, "owner", 30);
				expect(first).not.toBeNull();
				expect(second).toMatchObject({
					token: first?.token,
					fence: first?.fence,
				});
				if (second) await store.leases.release(second);
			} finally {
				await store.close();
			}
		});

		it("does not abandon a delivery after its run starts executing", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("dispatch-race");
				const deliveryId = `delivery-${randomUUID()}`;
				const input = {
					provider: "github",
					deliveryId,
					payloadDigest: "e".repeat(64),
					run,
					deliveryTtlSeconds: 600,
				};
				await store.inbox.accept(input);
				const execution = await store.runs.beginExecution(
					run.id,
					randomUUID(),
					30,
				);
				if (execution.kind !== "acquired") {
					throw new Error("test execution was busy");
				}

				await store.inbox.abandon("github", deliveryId);
				expect((await store.inbox.accept(input)).kind).toBe("dispatched");
				await expect(
					store.completeRun({
						runId: run.id,
						execution: execution.execution,
						status: "completed",
						result: { ok: true },
					}),
				).resolves.toBeUndefined();
			} finally {
				await store.close();
			}
		});

		it("fences executions and preserves guarded replay semantics", async () => {
			const now = new Date("2026-08-31T12:00:00.000Z");
			const store = await createStore();
			try {
				const run = newRootRun("steps");
				await store.runs.ensureRun(run);
				const claim = await store.runs.beginExecution(
					run.id,
					`execution-${randomUUID()}`,
					30,
				);
				expect(claim.kind).toBe("acquired");
				if (claim.kind !== "acquired") return;
				const execution = claim.execution;
				expect(
					(
						await store.runs.beginStep(
							run.id,
							"analysis",
							"guarded",
							execution,
						)
					).kind,
				).toBe("execute");
				await store.runs.completeStep(
					run.id,
					"analysis",
					{ plan: true },
					execution,
				);
				const reused = await store.runs.beginStep<{ plan: boolean }>(
					run.id,
					"analysis",
					"guarded",
					execution,
				);
				expect(reused).toMatchObject({
					kind: "reuse",
					value: { plan: true },
				});
				await store.completeRun({
					runId: run.id,
					execution,
					status: "completed",
					result: { ok: true, at: now.toISOString() },
				});
				expect(await store.runs.getTerminal(run.id)).toEqual({
					found: true,
					value: { ok: true, at: now.toISOString() },
				});
			} finally {
				await store.close();
			}
		});

		it("rejects cross-run capabilities and counts each execution failure once", async () => {
			const store = await createStore();
			try {
				const first = newRootRun("first-run");
				const second = newRootRun("second-run");
				await store.runs.ensureRun(first);
				await store.runs.ensureRun(second);
				const claim = await store.runs.beginExecution(
					first.id,
					`execution-${randomUUID()}`,
					30,
				);
				if (claim.kind !== "acquired") throw new Error("test run was busy");

				await expect(
					store.runs.beginStep(
						second.id,
						"analysis",
						"safe",
						claim.execution,
					),
				).rejects.toBeInstanceOf(StoreConflictError);
				expect(
					await store.runs.incrementFailureCount(
						first.id,
						claim.execution,
					),
				).toBe(1);
				expect(
					await store.runs.incrementFailureCount(
						first.id,
						claim.execution,
					),
				).toBe(1);

				await store.completeRun({
					runId: first.id,
					execution: claim.execution,
					status: "completed",
					result: { ok: true },
				});
				await expect(
					store.runs.beginExecution(
						first.id,
						`execution-${randomUUID()}`,
						30,
					),
				).rejects.toBeInstanceOf(StoreConflictError);
			} finally {
				await store.close();
			}
		});

		it("distinguishes JSON null from an omitted terminal result", async () => {
			const store = await createStore();
			try {
				for (const [suffix, result] of [
					["null", null],
					["missing", undefined],
				] as const) {
					const run = newRootRun(`terminal-${suffix}`);
					await store.runs.ensureRun(run);
					const claim = await store.runs.beginExecution(
						run.id,
						randomUUID(),
						30,
					);
					if (claim.kind !== "acquired") {
						throw new Error("test execution was busy");
					}
					await store.completeRun({
						runId: run.id,
						execution: claim.execution,
						status: "completed",
						...(result !== undefined ? { result } : {}),
					});
					expect(await store.runs.getTerminal(run.id)).toEqual({
						found: true,
						value: result,
					});
				}
			} finally {
				await store.close();
			}
		});

		it("stores artifacts, conversation messages, replies, and knowledge", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("state");
				await store.runs.ensureRun(run);
				const ref = await store.artifacts.put({
					runId: run.id,
					namespace: "result",
					content: "large result",
					ttlSeconds: 600,
				});
				expect((await store.artifacts.get(ref))?.content).toBe("large result");

				const conversation = `thread-${randomUUID()}`;
				const messageId = `message-${randomUUID()}`;
				expect(
					await store.conversations.appendOnce(
						"chat",
						conversation,
						{
							id: messageId,
							runId: run.id,
							role: "user",
							content: "hello",
							occurredAt: "2026-08-31T12:00:00.000Z",
						},
						{ ttlSeconds: 600, maxMessages: 20 },
					),
				).toBe(true);
				expect(
					await store.conversations.appendOnce(
						"chat",
						conversation,
						{
							id: messageId,
							runId: run.id,
							role: "user",
							content: "hello",
							occurredAt: "2026-08-31T12:00:00.000Z",
						},
						{ ttlSeconds: 600, maxMessages: 20 },
					),
				).toBe(false);
				expect(
					await store.conversations.list("chat", conversation, 20),
				).toHaveLength(1);

				await store.conversations.putReply(
					"chat",
					messageId,
					run.id,
					"world",
					600,
				);
				expect(
					await store.conversations.getReply("chat", messageId),
				).toBe("world");
				await store.conversations.markDelivered("chat", messageId);
				expect(
					await store.conversations.wasDelivered("chat", messageId),
				).toBe(true);

				await store.knowledge.appendLines(
					"repository",
					"acme/widget",
					["Use tabs", "Use tabs", "Run checks"],
					{ maxChars: 2_000, ttlSeconds: 600 },
				);
				expect(
					await store.knowledge.get("repository", "acme/widget"),
				).toBe("Use tabs\nRun checks");
			} finally {
				await store.close();
			}
		});

		it("rejects writes with a stale execution handle", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("fencing");
				await store.runs.ensureRun(run);
				const first = await store.runs.beginExecution(
					run.id,
					randomUUID(),
					30,
				);
				if (first.kind !== "acquired") {
					throw new Error("first execution was busy");
				}
				await store.runs.releaseExecution(first.execution);
				const second = await store.runs.beginExecution(
					run.id,
					randomUUID(),
					30,
				);
				if (second.kind !== "acquired") {
					throw new Error("second execution was busy");
				}
				await expect(
					store.runs.beginStep(
						run.id,
						"stale-step",
						"safe",
						first.execution,
					),
				).rejects.toThrow();
				await expect(
					store.runs.completeStep(
						run.id,
						"stale-step",
						{ ok: true },
						first.execution,
					),
				).rejects.toThrow();
				await expect(
					store.runs.recordUsage(
						run.id,
						100,
						50,
						"claude",
						first.execution,
					),
				).rejects.toThrow();

				await store.completeRun({
					runId: run.id,
					execution: second.execution,
					status: "completed",
					result: { ok: true },
				});
			} finally {
				await store.close();
			}
		});

		it("rejects invalid store keys", async () => {
			const store = await createStore();
			try {
				await expect(
					store.runs.ensureRun({
						id: "",
						rootRunId: "",
						kind: "workflow",
						name: "bad",
					}),
				).rejects.toBeInstanceOf(StoreConflictError);
				const run = newRootRun("valid");
				await store.runs.ensureRun(run);
				await expect(
					store.events.append({
						runId: run.id,
						category: "external",
						type: "",
						payload: {},
					}),
				).rejects.toBeInstanceOf(StoreConflictError);
				await expect(store.runs.getStep(run.id, "")).rejects.toBeInstanceOf(
					StoreConflictError,
				);
				await expect(
					store.runs.listLinks(""),
				).rejects.toBeInstanceOf(StoreConflictError);
			} finally {
				await store.close();
			}
		});

		it("handles beginStep self-ownership as resumable", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("self-own");
				await store.runs.ensureRun(run);
				const claim = await store.runs.beginExecution(
					run.id,
					randomUUID(),
					30,
				);
				if (claim.kind !== "acquired") {
					throw new Error("execution was busy");
				}
				const first = await store.runs.beginStep(
					run.id,
					"retryable",
					"safe",
					claim.execution,
				);
				expect(first.kind).toBe("execute");
				const retry = await store.runs.beginStep(
					run.id,
					"retryable",
					"safe",
					claim.execution,
				);
				expect(retry.kind).toBe("execute");
				await store.runs.completeStep(
					run.id,
					"retryable",
					{ ok: true },
					claim.execution,
				);
				await store.completeRun({
					runId: run.id,
					execution: claim.execution,
					status: "completed",
					result: { ok: true },
				});
			} finally {
				await store.close();
			}
		});

		it("records and deduplicates usage per execution", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("usage");
				await store.runs.ensureRun(run);
				const claim = await store.runs.beginExecution(
					run.id,
					randomUUID(),
					30,
				);
				if (claim.kind !== "acquired") {
					throw new Error("execution was busy");
				}
				await store.runs.recordUsage(
					run.id,
					100,
					50,
					"claude-sonnet",
					claim.execution,
				);
				await store.runs.recordUsage(
					run.id,
					200,
					75,
					"claude-sonnet",
					claim.execution,
				);
				const record = await store.runs.getRun(run.id);
				expect(record?.totalInputTokens).toBe(300);
				expect(record?.totalOutputTokens).toBe(125);
				expect(record?.totalModelCalls).toBe(2);
				await store.completeRun({
					runId: run.id,
					execution: claim.execution,
					status: "completed",
				});
			} finally {
				await store.close();
			}
		});

		it("manages links with metadata normalization", async () => {
			const store = await createStore();
			try {
				const run = newRootRun("links");
				await store.runs.ensureRun(run);
				const uniqueKind = `test.link-${randomUUID()}`;
				const uniqueExtId = `ref-${randomUUID()}`;
				const created = await store.runs.addLink({
					runId: run.id,
					kind: uniqueKind,
					externalId: uniqueExtId,
					metadata: { issueNumber: 1 },
				});
				expect(created.metadata).toEqual({ issueNumber: 1 });
				const updated = await store.runs.addLink({
					runId: run.id,
					kind: uniqueKind,
					externalId: uniqueExtId,
					metadata: { extra: true },
				});
				expect(updated.metadata).toEqual({
					issueNumber: 1,
					extra: true,
				});
				const links = await store.runs.listLinks(run.id);
				expect(links).toHaveLength(1);
				const found = await store.runs.findRunsByLink(
					uniqueKind,
					uniqueExtId,
					10,
				);
				expect(found).toHaveLength(1);
				expect(found[0].id).toBe(run.id);
			} finally {
				await store.close();
			}
		});

		it("closes idempotently", async () => {
			const store = await createStore();
			await store.close();
			await expect(store.close()).resolves.toBeUndefined();
		});
	});
}

function newRootRun(name: string): NewRun {
	const id = randomUUID();
	return {
		id,
		rootRunId: id,
		kind: "workflow",
		name,
		triggerType: "test",
		triggerRef: randomUUID(),
	};
}
