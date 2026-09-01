import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPostgresFactoryStore,
	type PostgresFactoryStore,
} from "../postgres/index.js";

const enabled = process.env.RUN_LIVE_INTEGRATION === "1";
if (enabled && !process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL is required for live integration tests");
}
const suite = enabled ? describe : describe.skip;

suite("Postgres FactoryStore concurrency", () => {
	let store: PostgresFactoryStore;

	beforeAll(async () => {
		store = createPostgresFactoryStore({
			applicationName: "render-factory-concurrency",
			max: 4,
		});
		await store.migrate();
	});

	afterAll(async () => {
		await store?.close();
	});

	it("serializes concurrent first delivery claims", async () => {
		const deliveryId = `delivery-${randomUUID()}`;
		const firstRun = randomUUID();
		const secondRun = randomUUID();
		const input = (runId: string) => ({
			provider: "github",
			deliveryId,
			payloadDigest: "d".repeat(64),
			run: {
				id: runId,
				rootRunId: runId,
				kind: "workflow" as const,
				name: "concurrency",
			},
			deliveryTtlSeconds: 600,
		});

		const results = await Promise.all([
			store.inbox.accept(input(firstRun)),
			store.inbox.accept(input(secondRun)),
		]);

		expect(results.map((result) => result.kind).sort()).toEqual([
			"accepted",
			"pending",
		]);
		expect(
			new Set(
				results.flatMap((result) =>
					"runId" in result ? [result.runId] : [],
				),
			).size,
		).toBe(1);
	});

	it("fences a stale lease even when the owner ID is reused", async () => {
		const resource = `lease-${randomUUID()}`;
		const first = await store.leases.tryAcquire(resource, "owner", 1);
		if (!first) throw new Error("first lease was not acquired");
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		const second = await store.leases.tryAcquire(resource, "owner", 30);
		if (!second) throw new Error("second lease was not acquired");
		expect(second.fence).not.toBe(first.fence);

		await store.leases.release(first);
		expect(
			await store.leases.tryAcquire(resource, "other-owner", 30),
		).toBeNull();
		await store.leases.release(second);
		expect(
			await store.leases.tryAcquire(resource, "other-owner", 30),
		).not.toBeNull();
	});

	it("terminalizes an expired delivery before reusing its ID", async () => {
		const deliveryId = `delivery-${randomUUID()}`;
		const subjectKey = `subject-${randomUUID()}`;
		const firstRun = randomUUID();
		const accepted = await store.inbox.accept({
			provider: "github",
			deliveryId,
			payloadDigest: "f".repeat(64),
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
		expect(accepted.kind).toBe("accepted");
		await new Promise((resolve) => setTimeout(resolve, 1_100));

		const secondRun = randomUUID();
		expect(
			await store.inbox.accept({
				provider: "github",
				deliveryId,
				payloadDigest: "f".repeat(64),
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

	it("does not lose concurrent first-write knowledge entries", async () => {
		const key = `knowledge-${randomUUID()}`;
		await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				store.knowledge.appendLines(
					"concurrency",
					key,
					[`line-${index}`],
					{ maxChars: 2_000, ttlSeconds: 600 },
				),
			),
		);
		const value = await store.knowledge.get("concurrency", key);
		for (let index = 0; index < 10; index++) {
			expect(value).toContain(`line-${index}`);
		}
	});

	it("serializes conflicting reply reservations and drops expired history", async () => {
		const runId = randomUUID();
		await store.runs.ensureRun({
			id: runId,
			rootRunId: runId,
			kind: "agent",
			name: "assistant",
		});
		const operationId = randomUUID();
		const reservations = await Promise.allSettled([
			store.conversations.putReply(
				"chat",
				operationId,
				runId,
				"first",
				30,
			),
			store.conversations.putReply(
				"chat",
				operationId,
				runId,
				"second",
				30,
			),
		]);
		expect(
			reservations.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			reservations.filter((result) => result.status === "rejected"),
		).toHaveLength(1);

		const thread = `thread-${randomUUID()}`;
		const oldMessageId = randomUUID();
		const newMessageId = randomUUID();
		await store.conversations.appendOnce(
			"chat",
			thread,
			{
				id: oldMessageId,
				runId,
				role: "user",
				content: "old",
				occurredAt: new Date().toISOString(),
			},
			{ ttlSeconds: 1, maxMessages: 20 },
		);
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		await store.conversations.appendOnce(
			"chat",
			thread,
			{
				id: newMessageId,
				runId,
				role: "user",
				content: "new",
				occurredAt: new Date().toISOString(),
			},
			{ ttlSeconds: 30, maxMessages: 20 },
		);
		expect(
			(await store.conversations.list("chat", thread, 20)).map(
				(message) => message.content,
			),
		).toEqual(["new"]);
	});
});
