/**
 * The pipeline with every external boundary mocked: no models, no sandbox,
 * no GitHub, no Postgres. What is under test is the control flow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskContext } from "@renderinc/sdk/workflows";

const mocks = vi.hoisted(() => ({
	triageTask: vi.fn(),
	analysisTask: vi.fn(),
	implementTask: vi.fn(),
	selfReviewTask: vi.fn(),
	securityTask: vi.fn(),
	correctnessTask: vi.fn(),
	testsTask: vi.fn(),
	judgeTask: vi.fn(),
	gh: {
		getIssue: vi.fn(),
		getRepoSnapshot: vi.fn(),
		getPermission: vi.fn(),
		listIssueComments: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		ensureIssueComment: vi.fn(),
		ensurePull: vi.fn(),
	},
	terminate: vi.fn(),
	createSandbox: vi.fn(),
	setupCheckout: vi.fn(),
	commitChanges: vi.fn(),
	completeDiff: vi.fn(),
	runVerification: vi.fn(),
	verifyPush: vi.fn(),
	finishRun: vi.fn(),
	mergeRunResult: vi.fn(),
	setRunStage: vi.fn(),
	markStarted: vi.fn(),
	getRun: vi.fn(),
	heartbeat: vi.fn(),
	appendEvent: vi.fn(),
}));

vi.mock("@renderinc/sdk/workflows", () => ({
	task: (config: { name: string }, handler: unknown) => ({
		name: config.name,
		handler,
	}),
}));

vi.mock("../app/tasks/index.js", () => ({
	triageTask: { name: "triage", func: mocks.triageTask },
	analysisTask: { name: "analyst", func: mocks.analysisTask },
	implementTask: { name: "implementer", func: mocks.implementTask },
	selfReviewTask: { name: "self-review", func: mocks.selfReviewTask },
	securityTask: { name: "security", func: mocks.securityTask },
	correctnessTask: { name: "correctness", func: mocks.correctnessTask },
	testsTask: { name: "tests", func: mocks.testsTask },
	judgeTask: { name: "judge", func: mocks.judgeTask },
	isBudgetExceeded: (err: unknown) =>
		err instanceof Error && err.message.includes("[BUDGET_EXCEEDED]"),
}));

vi.mock("../app/github/index.js", () => ({
	githubFromEnv: () => mocks.gh,
	githubToken: async () => "ghs_installation_token",
}));
vi.mock("../app/sandbox/index.js", () => ({
	createSandbox: mocks.createSandbox,
	connectSandbox: (id: string) => ({ id }),
}));
vi.mock("../app/store/index.js", () => ({
	finishRun: mocks.finishRun,
	mergeRunResult: mocks.mergeRunResult,
	setRunStage: mocks.setRunStage,
	markStarted: mocks.markStarted,
	getRun: mocks.getRun,
	heartbeat: mocks.heartbeat,
	appendEvent: mocks.appendEvent,
}));
vi.mock("../app/store/events.js", () => ({
	appendEvent: mocks.appendEvent,
}));
vi.mock("../app/git/index.js", () => ({
	branchName: () => "factory/issue-42-abcdef",
	setupCheckout: mocks.setupCheckout,
	commitChanges: mocks.commitChanges,
	completeDiff: mocks.completeDiff,
	runVerification: mocks.runVerification,
	verifyPush: mocks.verifyPush,
}));

const { specToPr } = await import("../app/workflows/index.js");

const mockCtx: TaskContext = {
	metadata: {},
	run: vi
		.fn()
		.mockImplementation(
			async (
				taskDef: { func: (...args: unknown[]) => unknown },
				...args: unknown[]
			) => taskDef.func(mockCtx, ...args),
		),
};

function makeRunRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-0001",
		repo: "jacobprall/render-factory-sample",
		subjectKind: "issue",
		subjectNumber: 42,
		workflow: "spec-to-pr",
		status: "running",
		stage: null,
		outcome: null,
		result: null,
		summary: null,
		trigger: {
			deliveryId: "del-1",
			event: "issues",
			action: "labeled",
			label: "factory:full-run",
			actor: { login: "Maintainer", id: 1 },
		},
		input: {},
		previousRunId: null,
		cancelRequestedAt: null,
		dispatchAttempts: 1,
		dispatchAfter: null,
		dispatchedAt: null,
		heartbeatAt: null,
		startedAt: new Date().toISOString(),
		completedAt: null,
		costUsd: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

const run = (input: unknown): Promise<unknown> =>
	(
		specToPr as unknown as {
			handler: (ctx: TaskContext, input: unknown) => Promise<unknown>;
		}
	).handler(mockCtx, input);

const INPUT = { runId: "run-0001" };

beforeEach(() => {
	vi.clearAllMocks();

	mocks.markStarted.mockResolvedValue(true);
	mocks.getRun.mockResolvedValue(makeRunRecord());
	mocks.heartbeat.mockResolvedValue(undefined);
	mocks.appendEvent.mockResolvedValue("1");
	mocks.gh.getPermission.mockResolvedValue("admin");

	mocks.gh.getIssue.mockResolvedValue({
		number: 42,
		title: "Add retries",
		body: "Please add retries to the client.",
		labels: ["factory:full-run"],
		user: "Maintainer",
		htmlUrl: "https://github.com/test/test/issues/42",
	});
	mocks.gh.listIssueComments.mockResolvedValue([]);
	mocks.gh.getRepoSnapshot.mockResolvedValue({
		defaultBranch: "main",
		paths: ["src/client.ts"],
		truncated: false,
		files: [],
	});
	mocks.gh.addLabels.mockResolvedValue(undefined);
	mocks.gh.removeLabel.mockResolvedValue(undefined);
	mocks.gh.ensureIssueComment.mockResolvedValue(undefined);
	mocks.gh.ensurePull.mockResolvedValue({
		number: 7,
		htmlUrl: "https://github.com/acme/widgets/pull/7",
		headSha: "sha-impl",
	});

	mocks.triageTask.mockResolvedValue(
		'{"hasEnoughDetail":true,"questions":[],"rationale":"clear"}',
	);
	mocks.analysisTask.mockResolvedValue("Step 1. Step 2.");
	mocks.implementTask.mockResolvedValue('{"summary":"Added retries"}');
	mocks.selfReviewTask.mockResolvedValue('{"needsRevision":false,"issues":[]}');
	mocks.securityTask.mockResolvedValue('{"findings":[]}');
	mocks.correctnessTask.mockResolvedValue('{"findings":[]}');
	mocks.testsTask.mockResolvedValue('{"findings":[]}');
	mocks.judgeTask.mockResolvedValue(
		'{"decision":"approve","riskTier":"trivial","summary":"Clean.","topFindings":[]}',
	);

	mocks.createSandbox.mockResolvedValue({
		id: "sbx-1",
		terminate: mocks.terminate,
	});
	mocks.terminate.mockResolvedValue(undefined);
	mocks.setupCheckout.mockResolvedValue({
		remoteUrl: "https://github.com/acme/widgets.git",
		base: "main",
		baseSha: "sha-base",
		branch: "factory/issue-42-abcdef",
	});
	mocks.commitChanges.mockResolvedValue("sha-impl");
	mocks.completeDiff.mockResolvedValue("diff --git a/x b/x");
	mocks.runVerification.mockResolvedValue({ passed: true, failures: "" });
	mocks.verifyPush.mockResolvedValue(undefined);
	mocks.finishRun.mockResolvedValue({
		finished: true,
		followUpCreated: false,
	});
	mocks.mergeRunResult.mockResolvedValue(undefined);
	mocks.setRunStage.mockResolvedValue(undefined);
});

describe("happy path", () => {
	it("opens a draft pull request against the reviewed commit", async () => {
		const result = await run(INPUT);

		expect(result).toEqual({
			pullRequest: "https://github.com/acme/widgets/pull/7",
			branch: "factory/issue-42-abcdef",
		});
		expect(mocks.verifyPush).toHaveBeenCalledWith(
			expect.anything(),
			"ghs_installation_token",
			expect.anything(),
			"sha-impl",
		);
		expect(mocks.gh.ensurePull).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ expectedHeadSha: "sha-impl", base: "main" }),
		);
		expect(mocks.finishRun).toHaveBeenCalledWith(
			"run-0001",
			"completed",
			expect.objectContaining({
				outcome: "draft_pr_opened",
				result: expect.objectContaining({
					pullRequest: expect.stringContaining("/pull/7"),
				}),
			}),
		);
	});

	it("removes the trigger label once the run is over", async () => {
		await run(INPUT);
		expect(mocks.gh.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:full-run",
		);
	});

	it("advances the status label through each phase, then to pr-open", async () => {
		await run(INPUT);

		const applied = mocks.gh.addLabels.mock.calls.map(
			(call: unknown[]) => (call[2] as string[])[0],
		);
		expect(applied).toEqual([
			"factory-status:analyzing",
			"factory-status:implementing",
			"factory-status:reviewing",
			"factory-status:pr-open",
		]);
	});

	it("adds the next status label before removing the previous one", async () => {
		await run(INPUT);

		const order = [
			...mocks.gh.addLabels.mock.calls.map((c: unknown[]) => ({
				op: "add",
				label: (c[2] as string[])[0],
			})),
			...mocks.gh.removeLabel.mock.calls.map((c: unknown[]) => ({
				op: "remove",
				label: c[2] as string,
			})),
		];
		const addAnalyzing = order.findIndex(
			(e) => e.op === "add" && e.label === "factory-status:implementing",
		);
		const removeAnalyzing = order.findIndex(
			(e) => e.op === "remove" && e.label === "factory-status:analyzing",
		);
		expect(addAnalyzing).toBeGreaterThanOrEqual(0);
		expect(removeAnalyzing).toBeGreaterThanOrEqual(0);
	});

	it("clears status labels left by an earlier run", async () => {
		mocks.gh.getIssue.mockResolvedValue({
			number: 42,
			title: "Add retries",
			body: "Please add retries.",
			labels: ["factory:full-run", "factory-status:failed", "bug"],
			user: "Maintainer",
			htmlUrl: "https://github.com/test/test/issues/42",
		});

		await run(INPUT);

		expect(mocks.gh.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory-status:failed",
		);
		expect(mocks.gh.removeLabel).not.toHaveBeenCalledWith(
			expect.anything(),
			42,
			"bug",
		);
	});

	it("fans the diff out to three reviewers in parallel", async () => {
		await run(INPUT);
		expect(mocks.securityTask).toHaveBeenCalledOnce();
		expect(mocks.correctnessTask).toHaveBeenCalledOnce();
		expect(mocks.testsTask).toHaveBeenCalledOnce();
	});

	it("terminates the sandbox", async () => {
		await run(INPUT);
		expect(mocks.terminate).toHaveBeenCalledOnce();
	});
});

describe("early exits", () => {
	it("asks for clarification without creating a sandbox", async () => {
		mocks.triageTask.mockResolvedValue(
			'{"hasEnoughDetail":false,"questions":["Which client?"],"rationale":"vague"}',
		);

		const result = await run(INPUT);

		expect(result).toEqual({ questions: ["Which client?"] });
		expect(mocks.createSandbox).not.toHaveBeenCalled();
		expect(mocks.gh.ensureIssueComment).toHaveBeenCalled();
		expect(mocks.gh.addLabels).toHaveBeenCalledWith(expect.anything(), 42, [
			"factory-status:needs-detail",
		]);
	});

	it("stops when the implementer changed nothing", async () => {
		mocks.commitChanges.mockResolvedValue(null);

		const result = await run(INPUT);

		expect(result).toEqual({ status: "no_changes" });
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
		expect(mocks.terminate).toHaveBeenCalledOnce();
	});

	it("refuses to run when the label was removed before the workflow started", async () => {
		mocks.gh.getIssue.mockResolvedValue({
			number: 42,
			title: "t",
			body: "b",
			labels: [],
			user: "Maintainer",
			htmlUrl: "https://github.com/test/test/issues/42",
		});

		const result = await run(INPUT);
		expect(result).toEqual({ status: "trigger_removed" });
	});
});

describe("review outcomes", () => {
	it("revises once, then reports if the judge still objects", async () => {
		mocks.judgeTask.mockResolvedValue(
			'{"decision":"request_changes","riskTier":"high","summary":"Unsafe.","topFindings":[]}',
		);
		mocks.commitChanges
			.mockResolvedValueOnce("sha-impl")
			.mockResolvedValueOnce("sha-revised");

		const result = await run(INPUT);

		expect(result).toMatchObject({ summary: "Unsafe." });
		expect(mocks.judgeTask).toHaveBeenCalledTimes(2);
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
	});

	it("feeds verification failures back to the implementer", async () => {
		mocks.runVerification
			.mockResolvedValueOnce({ passed: false, failures: "tsc: type error" })
			.mockResolvedValue({ passed: true, failures: "" });

		const result = await run(INPUT);

		expect(result).toMatchObject({
			pullRequest: expect.stringContaining("/pull/7"),
		});
		const messages = mocks.implementTask.mock.calls.map(
			(call: unknown[]) => (call[1] as { message: string }).message,
		);
		expect(messages.some((m: string) => m.includes("tsc: type error"))).toBe(
			true,
		);
	});

	it("gives up after the verification round limit", async () => {
		mocks.runVerification.mockResolvedValue({
			passed: false,
			failures: "still failing",
		});

		const result = await run(INPUT);

		expect(result).toMatchObject({
			summary: expect.stringContaining("Verification failed"),
		});
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
	});
});

describe("failure handling", () => {
	it("terminates the sandbox when a stage throws", async () => {
		mocks.analysisTask.mockRejectedValue(new Error("model unavailable"));

		await expect(run(INPUT)).rejects.toThrow("model unavailable");
		expect(mocks.terminate).toHaveBeenCalledOnce();
	});

	it("marks the issue factory-status:failed when a stage throws", async () => {
		mocks.analysisTask.mockRejectedValue(new Error("model unavailable"));

		await expect(run(INPUT)).rejects.toThrow("model unavailable");
		expect(mocks.gh.addLabels).toHaveBeenCalledWith(expect.anything(), 42, [
			"factory-status:failed",
		]);
	});

	it("still opens the pull request when labelling fails", async () => {
		mocks.gh.addLabels.mockRejectedValue(new Error("labels API down"));

		const result = await run(INPUT);

		expect(result).toMatchObject({
			pullRequest: expect.stringContaining("/pull/7"),
		});
	});

	it("fails closed when an agent cannot produce valid JSON twice", async () => {
		mocks.triageTask.mockResolvedValue("I am not sure.");

		await expect(run(INPUT)).rejects.toThrow(/invalid structured output/);
		expect(mocks.triageTask).toHaveBeenCalledTimes(2);
	});
});
