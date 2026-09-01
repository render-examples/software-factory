import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryFactoryStore } from "../memory.js";
import { runFactoryStoreConformance } from "./conformance.js";

runFactoryStoreConformance("memory", () => createMemoryFactoryStore());

describe("MemoryFactoryStore expiry", () => {
	it("terminalizes an expired delivery and releases its subject", async () => {
		let now = new Date("2026-08-31T00:00:00.000Z");
		const store = createMemoryFactoryStore({ now: () => now });
		const deliveryId = randomUUID();
		const subjectKey = randomUUID();
		const firstRun = randomUUID();
		await store.inbox.accept({
			provider: "github",
			deliveryId,
			payloadDigest: "a".repeat(64),
			subjectKey,
			run: {
				id: firstRun,
				rootRunId: firstRun,
				kind: "workflow",
				name: "expiry",
			},
			deliveryTtlSeconds: 1,
			subjectLeaseTtlSeconds: 30,
		});
		now = new Date(now.getTime() + 2_000);
		const secondRun = randomUUID();
		expect(
			await store.inbox.accept({
				provider: "github",
				deliveryId,
				payloadDigest: "a".repeat(64),
				subjectKey,
				run: {
					id: secondRun,
					rootRunId: secondRun,
					kind: "workflow",
					name: "expiry",
				},
				deliveryTtlSeconds: 30,
				subjectLeaseTtlSeconds: 30,
			}),
		).toEqual({ kind: "accepted", runId: secondRun });
		expect(await store.runs.getRun(firstRun)).toMatchObject({
			status: "cancelled",
			errorCode: "delivery_expired",
		});
	});

	it("cascades events when a retained run summary is deleted", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const store = createMemoryFactoryStore({ now: () => now });
		const runId = randomUUID();
		await store.runs.ensureRun({
			id: runId,
			rootRunId: runId,
			kind: "workflow",
			name: "retention",
		});
		const claim = await store.runs.beginExecution(runId, randomUUID(), 30);
		if (claim.kind !== "acquired") throw new Error("test run was busy");
		await store.completeRun({
			runId,
			execution: claim.execution,
			status: "completed",
			result: { ok: true },
		});
		now = new Date("2026-01-03T00:00:00.000Z");
		await store.cleanup({
			eventRetentionDays: 90,
			runRetentionDays: 1,
			now,
		});
		expect(await store.runs.getRun(runId)).toBeNull();
		expect(await store.events.readRun(runId)).toEqual([]);
	});
});
