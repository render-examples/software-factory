import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createPostgresFactoryStore,
	type PostgresFactoryStore,
} from "#factory/store";

const enabled = process.env.RUN_LIVE_INTEGRATION === "1";
if (enabled && !process.env.DATABASE_URL) {
	throw new Error("DATABASE_URL is required for live integration tests");
}
const suite = enabled ? describe : describe.skip;

suite("live Postgres integration", () => {
	let gatewayStore: PostgresFactoryStore;
	let workflowStore: PostgresFactoryStore;

	beforeAll(async () => {
		gatewayStore = createPostgresFactoryStore({
			applicationName: "factory-integration-gateway",
			max: 2,
		});
		workflowStore = createPostgresFactoryStore({
			applicationName: "factory-integration-workflow",
			max: 2,
		});
		await gatewayStore.migrate();
		await workflowStore.verifySchema();
	});

	afterAll(async () => {
		await Promise.all([gatewayStore?.close(), workflowStore?.close()]);
	});

	it("shares intake, execution, checkpoints, and terminal state across processes", async () => {
		const runId = randomUUID();
		const deliveryId = `delivery-${randomUUID()}`;
		const subjectKey = `github:integration/factory:issue:${Date.now()}`;
		expect(
			await gatewayStore.inbox.accept({
				provider: "github",
				deliveryId,
				payloadDigest: "a".repeat(64),
				subjectKey,
				run: {
					id: runId,
					rootRunId: runId,
					kind: "workflow",
					name: "spec-to-pr",
					triggerType: "integration",
				},
				deliveryTtlSeconds: 600,
				subjectLeaseTtlSeconds: 600,
			}),
		).toEqual({ kind: "accepted", runId });
		await gatewayStore.inbox.markDispatched("github", deliveryId);

		expect((await workflowStore.runs.getRun(runId))?.status).toBe("pending");
		const claim = await workflowStore.runs.beginExecution(
			runId,
			randomUUID(),
			30,
		);
		if (claim.kind !== "acquired") throw new Error("integration run was busy");
		expect(
			(
				await workflowStore.runs.beginStep(
					runId,
					"probe",
					"safe",
					claim.execution,
				)
			).kind,
		).toBe("execute");
		await workflowStore.runs.completeStep(
			runId,
			"probe",
			{ ok: true },
			claim.execution,
		);
		await workflowStore.completeRun({
			runId,
			execution: claim.execution,
			status: "completed",
			result: { status: "ok" },
		});

		expect(await gatewayStore.runs.getTerminal(runId)).toEqual({
			found: true,
			value: { status: "ok" },
		});
		expect(
			(await gatewayStore.events.readRun(runId)).map((event) => event.type),
		).toEqual(
			expect.arrayContaining([
				"run.created",
				"execution.started",
				"step.started",
				"step.completed",
				"run.completed",
			]),
		);
		expect(
			(
				await gatewayStore.inbox.accept({
					provider: "github",
					deliveryId,
					payloadDigest: "a".repeat(64),
					subjectKey,
					run: {
						id: randomUUID(),
						rootRunId: randomUUID(),
						kind: "workflow",
						name: "spec-to-pr",
					},
					deliveryTtlSeconds: 600,
				})
			).kind,
		).toBe("completed");
	});

	it("shares conversation and artifact state", async () => {
		const runId = randomUUID();
		await gatewayStore.runs.ensureRun({
			id: runId,
			rootRunId: runId,
			kind: "agent",
			name: "assistant",
		});
		const ref = await workflowStore.artifacts.put({
			runId,
			namespace: "answer",
			content: "artifact",
			ttlSeconds: 600,
		});
		expect((await gatewayStore.artifacts.get(ref))?.content).toBe("artifact");

		const thread = `thread-${randomUUID()}`;
		await gatewayStore.conversations.appendOnce(
			"chat",
			thread,
			{
				id: randomUUID(),
				runId,
				role: "user",
				content: "hello",
				occurredAt: new Date().toISOString(),
			},
			{ ttlSeconds: 600, maxMessages: 20 },
		);
		expect(
			await workflowStore.conversations.list("chat", thread, 20),
		).toHaveLength(1);
	});
});
