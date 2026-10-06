/**
 * The spec-to-pr pipeline with every external boundary mocked: no models,
 * no sandbox, no GitHub, no Postgres. What is under test is the control flow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskContext } from "@renderinc/sdk/workflows";

const mocks = vi.hoisted(() => ({
	implementTask: vi.fn(),
	selfReviewTask: vi.fn(),
	gh: {
		getIssue: vi.fn(),
		getPermission: vi.fn(),
		listIssueComments: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
		ensureIssueComment: vi.fn(),
		ensurePull: vi.fn(),
		getBranchTipSha: vi.fn(),
	},
	commitChanges: vi.fn(),
	completeDiff: vi.fn(),
	runVerification: vi.fn(),
	git: vi.fn(),
	finishRun: vi.fn(),
	mergeRunResult: vi.fn(),
	setRunStage: vi.fn(),
	markStarted: vi.fn(),
	getRun: vi.fn(),
	heartbeat: vi.fn(),
	appendEvent: vi.fn(),
	getSpecVersion: vi.fn(),
	approveVersion: vi.fn(),
	getSpec: vi.fn(),
	lease: vi.fn(),
	release: vi.fn(),
	publish: vi.fn(),
	gitDataClient: vi.fn(),
}));

vi.mock("@renderinc/sdk/workflows", () => ({
	task: (config: { name: string }, handler: unknown) => ({
		name: config.name,
		handler,
	}),
}));

vi.mock("../app/tasks/index.js", () => ({
	implementTask: { name: "implementer", func: mocks.implementTask },
	selfReviewTask: { name: "self-review", func: mocks.selfReviewTask },
	isBudgetExceeded: (err: unknown) =>
		err instanceof Error && err.message.includes("[BUDGET_EXCEEDED]"),
}));

vi.mock("../app/github/index.js", () => ({
	githubFromEnv: () => mocks.gh,
	githubToken: async () => "ghs_installation_token",
	gitDataClient: () => mocks.gitDataClient(),
}));
vi.mock("../app/sandbox/index.js", () => ({
	createSandbox: vi.fn(),
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
	getSpecVersion: mocks.getSpecVersion,
	approveVersion: mocks.approveVersion,
	getSpec: mocks.getSpec,
}));
vi.mock("../app/store/events.js", () => ({
	appendEvent: mocks.appendEvent,
}));
vi.mock("../app/git/index.js", () => ({
	branchName: () => "factory/issue-42-abcdef",
	setupBranch: vi.fn().mockResolvedValue({
		remoteUrl: "",
		base: "main",
		baseSha: "sha-base",
		branch: "factory/issue-42-abcdef",
	}),
	commitChanges: mocks.commitChanges,
	completeDiff: mocks.completeDiff,
	runVerification: mocks.runVerification,
	createBranch: vi.fn(),
	git: mocks.git,
}));
vi.mock("../app/workspaces/index.js", () => ({
	lease: mocks.lease,
	release: mocks.release,
}));
vi.mock("../app/publish/index.js", () => ({
	publish: mocks.publish,
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

const SPEC_DOC = {
	title: "Add retries",
	summary: "Add retry logic to the HTTP client",
	problem: "Requests fail without retries",
	goals: ["Add retries"],
	nonGoals: [],
	acceptanceCriteria: [
		{ id: "AC-1", text: "Client retries on 5xx", verification: "automated" },
	],
	approach: "Wrap fetch calls",
	affectedAreas: [{ path: "src/client.ts", change: "Add retry logic" }],
	testPlan: "Unit tests for retry logic",
	risks: [],
	assumptions: [],
	openQuestions: [],
};

const NOW = "2026-10-05T17:30:00.000Z";

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
			label: "factory:spec-approved",
			actor: { login: "Maintainer", id: 1 },
		},
		input: { specId: "spec-001", specVersion: 1, autoAdvance: false },
		previousRunId: null,
		cancelRequestedAt: null,
		dispatchAttempts: 1,
		dispatchAfter: null,
		dispatchedAt: null,
		heartbeatAt: null,
		startedAt: NOW,
		completedAt: null,
		costUsd: 0,
		createdAt: NOW,
		updatedAt: NOW,
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
		labels: ["factory:spec-approved"],
		user: "Maintainer",
		htmlUrl: "https://github.com/test/test/issues/42",
	});
	mocks.gh.listIssueComments.mockResolvedValue([]);
	mocks.gh.addLabels.mockResolvedValue(undefined);
	mocks.gh.removeLabel.mockResolvedValue(undefined);
	mocks.gh.ensureIssueComment.mockResolvedValue(undefined);
	mocks.gh.getBranchTipSha.mockResolvedValue("sha-base");
	mocks.gh.ensurePull.mockResolvedValue({
		number: 7,
		htmlUrl: "https://github.com/acme/widgets/pull/7",
		headSha: "sha-commit",
	});

	mocks.getSpecVersion.mockResolvedValue({
		specId: "spec-001",
		version: 1,
		document: SPEC_DOC,
		markdown: "",
		notes: null,
		lastCommentId: null,
		runId: null,
		createdAt: NOW,
	});
	mocks.approveVersion.mockResolvedValue(true);
	mocks.getSpec.mockResolvedValue({
		id: "spec-001",
		repo: "jacobprall/render-factory-sample",
		issueNumber: 42,
		status: "approved",
		currentVersion: 1,
		approvedVersion: 1,
		approvedBy: "Maintainer",
		approvedAt: NOW,
		commentId: "12345",
		createdAt: NOW,
		updatedAt: NOW,
	});

	mocks.implementTask.mockResolvedValue('{"summary":"Added retries"}');
	mocks.selfReviewTask.mockResolvedValue('{"needsRevision":false,"issues":[]}');

	mocks.lease.mockResolvedValue({
		sandbox: {
			id: "sbx-1",
			run: vi.fn(),
			mustRun: vi.fn(),
			download: vi.fn(),
		},
		sandboxRecordId: "sr-1",
		repoDir: "/home/user/repo",
		baseBranch: "main",
		baseSha: "sha-base",
		headSha: "sha-base",
	});
	mocks.release.mockResolvedValue(undefined);

	mocks.commitChanges.mockResolvedValue("sha-impl");
	mocks.completeDiff.mockResolvedValue("diff --git a/x b/x");
	mocks.runVerification.mockResolvedValue({
		passed: true,
		failures: "",
		results: [
			{ command: "npm test", exitCode: 0, durationMs: 1000, outputTail: "" },
		],
	});
	mocks.git.mockResolvedValue("");
	mocks.publish.mockResolvedValue({
		ok: true,
		result: {
			commitSha: "sha-commit",
			treeSha: "sha-tree",
			branch: "factory/issue-42-abcdef",
		},
	});

	mocks.finishRun.mockResolvedValue({
		finished: true,
		followUpCreated: false,
	});
	mocks.mergeRunResult.mockResolvedValue(undefined);
	mocks.setRunStage.mockResolvedValue(undefined);
});

describe("happy path", () => {
	it("opens a draft pull request after publishing", async () => {
		const result = await run(INPUT);

		expect(result).toEqual(
			expect.objectContaining({
				prNumber: 7,
				prUrl: "https://github.com/acme/widgets/pull/7",
				headSha: "sha-commit",
			}),
		);
		expect(mocks.publish).toHaveBeenCalled();
		expect(mocks.gh.ensurePull).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				expectedHeadSha: "sha-commit",
				base: "main",
			}),
		);
		expect(mocks.finishRun).toHaveBeenCalledWith(
			"run-0001",
			"completed",
			expect.objectContaining({ outcome: "pr_opened" }),
		);
	});

	it("removes the trigger label and conversation labels", async () => {
		await run(INPUT);
		expect(mocks.gh.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:spec-approved",
		);
		expect(mocks.gh.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:triage",
		);
		expect(mocks.gh.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:full-run",
		);
	});

	it("leases a workspace and releases it in cleanup", async () => {
		await run(INPUT);
		expect(mocks.lease).toHaveBeenCalledWith("run-0001", {
			kind: "branch",
			name: "main",
		});
		expect(mocks.release).toHaveBeenCalledWith("run-0001");
	});

	it("uses run.startedAt as the deterministic author date", async () => {
		await run(INPUT);

		expect(mocks.publish).toHaveBeenCalledWith(
			expect.objectContaining({ authorDate: NOW }),
		);
	});
});

describe("early exits", () => {
	it("finishes no_spec when specId is null", async () => {
		mocks.getRun.mockResolvedValue(
			makeRunRecord({ input: { specId: null, specVersion: null } }),
		);

		const result = await run(INPUT);

		expect(result).toEqual(
			expect.objectContaining({
				detail: expect.stringContaining("No specification"),
			}),
		);
		expect(mocks.lease).not.toHaveBeenCalled();
		expect(mocks.gh.ensureIssueComment).toHaveBeenCalled();
	});

	it("finishes no_spec when spec version does not exist", async () => {
		mocks.getSpecVersion.mockResolvedValue(null);

		const result = await run(INPUT);

		expect(result).toEqual(
			expect.objectContaining({
				detail: expect.stringContaining("does not exist"),
			}),
		);
		expect(mocks.lease).not.toHaveBeenCalled();
	});

	it("finishes no_spec when approval returns false", async () => {
		mocks.approveVersion.mockResolvedValue(false);

		const result = await run(INPUT);

		expect(result).toEqual(
			expect.objectContaining({
				detail: expect.stringContaining("Could not approve"),
			}),
		);
	});

	it("stops when the implementer changed nothing", async () => {
		mocks.commitChanges.mockResolvedValue(null);

		const result = await run(INPUT);

		expect(result).toEqual(expect.objectContaining({ status: "no_changes" }));
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
		expect(mocks.release).toHaveBeenCalledOnce();
	});
});

describe("verification", () => {
	it("feeds verification failures back to the implementer", async () => {
		mocks.runVerification
			.mockResolvedValueOnce({
				passed: false,
				failures: "tsc: type error",
				results: [
					{
						command: "npm test",
						exitCode: 1,
						durationMs: 500,
						outputTail: "tsc: type error",
					},
				],
			})
			.mockResolvedValue({
				passed: true,
				failures: "",
				results: [
					{
						command: "npm test",
						exitCode: 0,
						durationMs: 1000,
						outputTail: "",
					},
				],
			});

		const result = await run(INPUT);

		expect(result).toEqual(expect.objectContaining({ prNumber: 7 }));
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
			results: [
				{
					command: "npm test",
					exitCode: 1,
					durationMs: 500,
					outputTail: "still failing",
				},
			],
		});

		const result = await run(INPUT);

		expect(result).toEqual(
			expect.objectContaining({
				summary: expect.stringContaining("Verification failed"),
			}),
		);
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
	});
});

describe("self-review re-verification failure", () => {
	it("resets to the verified commit when self-review fix fails re-verify", async () => {
		// First verify pass → self-review finds issues → fix committed →
		// re-verify fails → should reset to original verified sha
		mocks.selfReviewTask.mockResolvedValue(
			'{"needsRevision":true,"issues":["debug console.log"]}',
		);
		mocks.commitChanges
			.mockResolvedValueOnce("sha-impl") // initial impl
			.mockResolvedValueOnce("sha-fix"); // self-review fix

		let verifyCall = 0;
		mocks.runVerification.mockImplementation(async () => {
			verifyCall++;
			if (verifyCall <= 1) {
				// First verification (on sha-impl) passes
				return {
					passed: true,
					failures: "",
					results: [
						{
							command: "npm test",
							exitCode: 0,
							durationMs: 1000,
							outputTail: "",
						},
					],
				};
			}
			// Re-verification after self-review fix fails
			return {
				passed: false,
				failures: "broken by fix",
				results: [
					{
						command: "npm test",
						exitCode: 1,
						durationMs: 500,
						outputTail: "broken",
					},
				],
			};
		});

		await run(INPUT);

		// Should have called git reset --hard to roll back
		expect(mocks.git).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("reset --hard"),
			expect.any(String),
		);

		// Should still publish (not fail)
		expect(mocks.publish).toHaveBeenCalled();
	});
});

describe("publish refusal", () => {
	it("stops with publish_refused when publish returns reasons", async () => {
		mocks.publish.mockResolvedValue({
			ok: false,
			reasons: [{ kind: "symlink", detail: "Symlink: src/link" }],
		});

		await run(INPUT);

		expect(mocks.finishRun).toHaveBeenCalledWith(
			"run-0001",
			"completed",
			expect.objectContaining({ outcome: "publish_refused" }),
		);
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
	});
});

describe("auto-advance", () => {
	it("queues a pr-review follow-up when autoAdvance is set", async () => {
		mocks.getRun.mockResolvedValue(
			makeRunRecord({
				input: { specId: "spec-001", specVersion: 1, autoAdvance: true },
			}),
		);

		await run(INPUT);

		expect(mocks.finishRun).toHaveBeenCalledWith(
			"run-0001",
			"completed",
			expect.objectContaining({
				outcome: "pr_opened",
				followUp: expect.objectContaining({
					workflow: "pr-review",
					subjectKind: "pull_request",
					subjectNumber: 7,
					input: expect.objectContaining({
						prNumber: 7,
						headSha: "sha-commit",
					}),
					previousRunId: "run-0001",
				}),
			}),
		);
	});

	it("gives the follow-up a follow_up trigger with no label", async () => {
		mocks.getRun.mockResolvedValue(
			makeRunRecord({
				input: { specId: "spec-001", specVersion: 1, autoAdvance: true },
			}),
		);

		await run(INPUT);

		const finishCall = mocks.finishRun.mock.calls[0];
		const details = finishCall?.[2] as Record<string, unknown>;
		const followUp = details?.followUp as Record<string, unknown>;
		const followTrigger = followUp?.trigger as Record<string, unknown>;

		expect(followTrigger.event).toBe("follow_up");
		expect(followTrigger.label).toBeUndefined();
		expect(followTrigger.actor).toEqual({ login: "Maintainer", id: 1 });
		expect(followTrigger.previousRunId).toBe("run-0001");
	});

	it("does not queue a follow-up when autoAdvance is false", async () => {
		await run(INPUT);

		const call = mocks.finishRun.mock.calls[0];
		const details = call?.[2] as Record<string, unknown>;
		expect(details?.followUp).toBeUndefined();
	});
});

describe("failure handling", () => {
	it("releases the workspace when a stage throws", async () => {
		mocks.implementTask.mockRejectedValue(new Error("model unavailable"));

		await expect(run(INPUT)).rejects.toThrow("model unavailable");
		expect(mocks.release).toHaveBeenCalledOnce();
	});

	it("marks the issue factory-status:failed when a stage throws", async () => {
		mocks.implementTask.mockRejectedValue(new Error("model unavailable"));

		await expect(run(INPUT)).rejects.toThrow("model unavailable");
		expect(mocks.gh.addLabels).toHaveBeenCalledWith(expect.anything(), 42, [
			"factory-status:failed",
		]);
	});
});
