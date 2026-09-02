/**
 * The pipeline with every external boundary mocked: no models, no sandbox,
 * no GitHub, no Postgres. What is under test is the control flow.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowResult } from "../app/contracts/index.js";

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
		listIssueComments: vi.fn(),
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
	setRunBranch: vi.fn(),
}));

// task() normally registers with Render; here it just hands back the handler.
vi.mock("@renderinc/sdk/workflows", () => ({
	task: (_config: unknown, handler: unknown) => handler,
}));

vi.mock("../app/tasks/index.js", () => ({
	triageTask: mocks.triageTask,
	analysisTask: mocks.analysisTask,
	implementTask: mocks.implementTask,
	selfReviewTask: mocks.selfReviewTask,
	securityTask: mocks.securityTask,
	correctnessTask: mocks.correctnessTask,
	testsTask: mocks.testsTask,
	judgeTask: mocks.judgeTask,
}));

vi.mock("../app/github/index.js", () => ({ githubFromEnv: () => mocks.gh }));
vi.mock("../app/sandbox/index.js", () => ({
	createSandbox: mocks.createSandbox,
	connectSandbox: (id: string) => ({ id }),
}));
vi.mock("../app/store/index.js", () => ({
	finishRun: mocks.finishRun,
	setRunBranch: mocks.setRunBranch,
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
const run = specToPr as unknown as (input: unknown) => Promise<WorkflowResult>;

const INPUT = { issueNumber: 42, runId: "run-0001" };

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FACTORY_REPO = "acme/widgets";
	process.env.FACTORY_LABEL = "factory";
	process.env.GITHUB_TOKEN = "ghp_test";

	mocks.gh.getIssue.mockResolvedValue({
		number: 42,
		title: "Add retries",
		body: "Please add retries to the client.",
		labels: ["factory"],
	});
	mocks.gh.listIssueComments.mockResolvedValue([]);
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

	mocks.createSandbox.mockResolvedValue({ id: "sbx-1", terminate: mocks.terminate });
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
	mocks.finishRun.mockResolvedValue(undefined);
	mocks.setRunBranch.mockResolvedValue(undefined);
});

describe("happy path", () => {
	it("opens a draft pull request against the reviewed commit", async () => {
		const result = await run(INPUT);

		expect(result).toEqual({
			status: "draft_pr_opened",
			pullRequest: "https://github.com/acme/widgets/pull/7",
		});
		expect(mocks.verifyPush).toHaveBeenCalledWith(
			expect.anything(),
			"ghp_test",
			expect.anything(),
			"sha-impl",
		);
		expect(mocks.gh.ensurePull).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ expectedHeadSha: "sha-impl", base: "main" }),
		);
		expect(mocks.finishRun).toHaveBeenCalledWith(
			"run-0001",
			"draft_pr_opened",
			expect.objectContaining({ pullRequest: expect.stringContaining("/pull/7") }),
		);
	});

	it("removes the trigger label to acknowledge intake", async () => {
		await run(INPUT);
		expect(mocks.gh.removeLabel).toHaveBeenCalledWith(expect.anything(), 42, "factory");
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

		expect(result).toEqual({ status: "needs_clarification", questions: ["Which client?"] });
		expect(mocks.createSandbox).not.toHaveBeenCalled();
		expect(mocks.gh.ensureIssueComment).toHaveBeenCalled();
	});

	it("stops when the implementer changed nothing", async () => {
		mocks.commitChanges.mockResolvedValue(null);

		const result = await run(INPUT);

		expect(result).toEqual({ status: "no_changes" });
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
		expect(mocks.terminate).toHaveBeenCalledOnce();
	});

	it("refuses to run when the label was removed before the workflow started", async () => {
		mocks.gh.getIssue.mockResolvedValue({ number: 42, title: "t", body: "b", labels: [] });

		await expect(run(INPUT)).rejects.toThrow(/no longer has/);
		expect(mocks.finishRun).toHaveBeenCalledWith("run-0001", "failed", expect.anything());
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

		expect(result).toMatchObject({ status: "changes_requested" });
		expect(mocks.judgeTask).toHaveBeenCalledTimes(2);
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
	});

	it("feeds verification failures back to the implementer", async () => {
		mocks.runVerification
			.mockResolvedValueOnce({ passed: false, failures: "tsc: type error" })
			.mockResolvedValue({ passed: true, failures: "" });

		const result = await run(INPUT);

		expect(result).toMatchObject({ status: "draft_pr_opened" });
		const messages = mocks.implementTask.mock.calls.map((call) => call[0].message);
		expect(messages.some((m: string) => m.includes("tsc: type error"))).toBe(true);
	});

	it("gives up after the verification round limit", async () => {
		mocks.runVerification.mockResolvedValue({ passed: false, failures: "still failing" });

		const result = await run(INPUT);

		expect(result).toMatchObject({ status: "changes_requested" });
		expect(mocks.gh.ensurePull).not.toHaveBeenCalled();
	});
});

describe("failure handling", () => {
	it("terminates the sandbox when a stage throws", async () => {
		mocks.analysisTask.mockRejectedValue(new Error("model unavailable"));

		await expect(run(INPUT)).rejects.toThrow("model unavailable");
		expect(mocks.terminate).toHaveBeenCalledOnce();
	});

	it("fails closed when an agent cannot produce valid JSON twice", async () => {
		mocks.triageTask.mockResolvedValue("I am not sure.");

		await expect(run(INPUT)).rejects.toThrow(/invalid structured output/);
		expect(mocks.triageTask).toHaveBeenCalledTimes(2);
	});
});
