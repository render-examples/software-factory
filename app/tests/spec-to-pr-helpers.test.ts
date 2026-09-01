import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createMemoryFactoryStore,
} from "#factory/store";
import { createCheckpointRunner } from "../workflows/spec-to-pr/checkpoints.js";
import {
	DOWNSTREAM_STAGES,
	MAX_ISSUE_CHARS,
	STAGES,
} from "../workflows/spec-to-pr/constants.js";
import { issueContext } from "../workflows/spec-to-pr/context.js";

async function setup(options?: { now?: () => Date }) {
	const store = createMemoryFactoryStore({ now: options?.now });
	const runId = randomUUID();
	await store.runs.ensureRun({
		id: runId,
		rootRunId: runId,
		kind: "workflow",
		name: "spec-to-pr",
	});
	const claim = await store.runs.beginExecution(
		runId,
		randomUUID(),
		30,
	);
	if (claim.kind !== "acquired") throw new Error("test execution was busy");
	return {
		store,
		runId,
		execution: claim.execution,
		refresh: vi.fn().mockResolvedValue(undefined),
	};
}

describe("spec-to-pr helpers", () => {
	it("preserves the durable downstream checkpoint keys", () => {
		expect(DOWNSTREAM_STAGES).toEqual([
			"analysis",
			"implementation-1",
			"commit-1",
			"self-review-1",
			"self-review-fix",
			"self-review-commit",
			"review-1",
			"implementation-2",
			"commit-2",
			"review-2",
			"push",
			"pull-request",
		]);
	});

	it("bounds issue context before it reaches an agent", () => {
		const context = issueContext(
			{
				number: 42,
				title: "Large issue",
				body: "x".repeat(MAX_ISSUE_CHARS * 2),
				state: "open",
				labels: ["factory"],
				user: "reporter",
				htmlUrl: "https://github.test/issues/42",
			},
			[],
		);

		expect(context).toHaveLength(MAX_ISSUE_CHARS);
		expect(context).toMatch(/^# Large issue/);
	});

	it("replays a completed stage and refreshes the subject lease", async () => {
		const setupResult = await setup();
		const first = createCheckpointRunner({
			runId: setupResult.runId,
			execution: setupResult.execution,
			store: setupResult.store,
			refreshSubjectLease: setupResult.refresh,
		});
		await first.run(STAGES.analysis, async () => "saved analysis");

		const execute = vi.fn();
		await expect(first.run(STAGES.analysis, execute)).resolves.toBe(
			"saved analysis",
		);
		expect(execute).not.toHaveBeenCalled();
		expect(setupResult.refresh).toHaveBeenCalled();
	});

	it("refuses to replay an interrupted guarded stage", async () => {
		let now = new Date("2026-08-31T00:00:00.000Z");
		const first = await setup({ now: () => now });
		await first.store.runs.beginStep(
			first.runId,
			STAGES.analysis.key,
			"guarded",
			first.execution,
		);
		now = new Date(now.getTime() + 31_000);
		const secondClaim = await first.store.runs.beginExecution(
			first.runId,
			randomUUID(),
			30,
		);
		if (secondClaim.kind !== "acquired") {
			throw new Error("replacement execution was busy");
		}
		const checkpoints = createCheckpointRunner({
			runId: first.runId,
			execution: secondClaim.execution,
			store: first.store,
			refreshSubjectLease: vi.fn(),
		});
		const execute = vi.fn();

		await expect(checkpoints.run(STAGES.analysis, execute)).rejects.toThrow(
			/refusing non-deterministic replay/,
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("allows a guarded stage to retry after a normal failure", async () => {
		const setupResult = await setup();
		const checkpoints = createCheckpointRunner({
			runId: setupResult.runId,
			execution: setupResult.execution,
			store: setupResult.store,
			refreshSubjectLease: setupResult.refresh,
		});

		await expect(
			checkpoints.run(STAGES.analysis, async () => {
				throw new Error("agent failed");
			}),
		).rejects.toThrow("agent failed");
		expect(
			await setupResult.store.runs.getStep(
				setupResult.runId,
				STAGES.analysis.key,
			),
		).toMatchObject({ status: "failed", generation: 1 });
		let retryGeneration = -1;
		await expect(
			checkpoints.run(STAGES.analysis, async ({ generation }) => {
				retryGeneration = generation;
				return "recovered";
			}),
		).resolves.toBe("recovered");
		expect(retryGeneration).toBe(1);
	});
});
