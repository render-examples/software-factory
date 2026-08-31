import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	checkpoints: new Map<string, unknown>(),
	sandboxStatus: "running" as "running" | "terminated",
	currentSha: "base-sha",
	commitCount: 0,
	analysisTask: vi.fn(),
	triageTask: vi.fn(),
	implementTask: vi.fn(),
	securityTask: vi.fn(),
	correctnessTask: vi.fn(),
	testsTask: vi.fn(),
	judgeTask: vi.fn(),
	completeIntake: vi.fn(),
	ensureIssueComment: vi.fn(),
	ensurePull: vi.fn(),
	terminate: vi.fn(),
	execGitWithToken: vi.fn(),
	sandbox: undefined as unknown,
}));

async function* execResult(
	output = "",
	exitCode = 0,
): AsyncGenerator<
	| { type: "output"; stream: "stdout"; data: string }
	| { type: "exit"; exitCode: number }
> {
	if (output) yield { type: "output", stream: "stdout", data: output };
	yield { type: "exit", exitCode };
}

const sandbox = {
	id: "sandbox-1",
	status: async () => state.sandboxStatus,
	terminate: state.terminate,
	exec: async (command: string) => {
		if (command.includes("symbolic-ref")) return execResult("origin/main\n");
		if (command.includes("rev-parse 'origin/main'")) {
			return execResult("base-sha\n");
		}
		if (command.includes("diff --cached --quiet")) return execResult("", 1);
		if (command.includes(" commit -m ")) {
			state.commitCount += 1;
			state.currentSha = `commit-${state.commitCount}`;
			return execResult();
		}
		if (command.includes("rev-parse HEAD")) {
			return execResult(`${state.currentSha}\n`);
		}
		if (command.includes("diff --no-ext-diff")) {
			return execResult("diff --git a/file.ts b/file.ts\n+change\n");
		}
		return execResult();
	},
};
state.sandbox = sandbox;

vi.mock("#factory-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#factory-sdk")>();
	return {
		...actual,
		RenderSandboxProvider: class {
			async create() {
				state.sandboxStatus = "running";
				return state.sandbox;
			}
			async connect() {
				return state.sandbox;
			}
		},
	};
});

vi.mock("../tasks/index.js", () => ({
	analysisTask: state.analysisTask,
	triageTask: state.triageTask,
	implementTask: state.implementTask,
	securityTask: state.securityTask,
	correctnessTask: state.correctnessTask,
	testsTask: state.testsTask,
	judgeTask: state.judgeTask,
}));

vi.mock("../lib/github.js", () => ({
	githubFromEnv: () => ({
		getIssue: async () => ({
			number: 42,
			title: "Fix the bug",
			body: "Detailed issue",
			state: "open",
			labels: ["factory"],
			user: "reporter",
			htmlUrl: "https://github.test/issues/42",
		}),
		listIssueComments: async () => [],
		removeLabel: async () => {},
		ensureIssueComment: state.ensureIssueComment,
		ensurePull: state.ensurePull,
	}),
}));

vi.mock("../lib/run-store.js", () => ({
	getCheckpoint: async (_attemptId: string, stage: string) =>
		state.checkpoints.has(stage)
			? { found: true, value: state.checkpoints.get(stage) }
			: { found: false },
	putCheckpoint: async (_attemptId: string, stage: string, value: unknown) => {
		state.checkpoints.set(stage, value);
		return value;
	},
	clearCheckpoints: async (_attemptId: string, stages: readonly string[]) => {
		for (const stage of stages) state.checkpoints.delete(stage);
	},
	refreshIntakeLease: async () => {},
	claimExecution: async () => true,
	refreshExecution: async () => {},
	releaseExecution: async () => {},
	incrementFailureCount: async () => 1,
	completeIntake: state.completeIntake,
}));

vi.mock("../lib/sandbox-git.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/sandbox-git.js")>();
	return { ...actual, execGitWithToken: state.execGitWithToken };
});

import { branchName, specToPr } from "../workflows/spec-to-pr.js";

const implementation = JSON.stringify({
	summary: "Implemented the fix",
	verification: [{ command: "npm test", result: "passed", passed: true }],
});

beforeEach(() => {
	state.checkpoints.clear();
	state.currentSha = "base-sha";
	state.commitCount = 0;
	state.sandboxStatus = "running";
	vi.clearAllMocks();
	state.terminate.mockResolvedValue(undefined);
	process.env.FACTORY_REPO = "acme/factory";
	process.env.FACTORY_LABEL = "factory";
	process.env.GITHUB_TOKEN = "token";
	state.triageTask.mockResolvedValue(
		JSON.stringify({
			hasEnoughDetail: true,
			questions: [],
			rationale: "actionable",
		}),
	);
	state.analysisTask.mockResolvedValue("analysis");
	state.implementTask.mockResolvedValue(implementation);
	state.securityTask.mockResolvedValue("no security findings");
	state.correctnessTask.mockResolvedValue("correct");
	state.testsTask.mockResolvedValue("covered");
	state.judgeTask.mockResolvedValue(
		JSON.stringify({ decision: "approve", summary: "ready" }),
	);
	state.ensurePull.mockResolvedValue({
		htmlUrl: "https://github.test/pull/7",
	});
	state.execGitWithToken.mockImplementation(
		async (_sandbox: unknown, _token: string, args: string[]) => {
			if (args.includes("ls-remote")) {
				return {
					output: `${state.currentSha}\trefs/heads/factory\n`,
					exitCode: 0,
				};
			}
			return { output: "", exitCode: 0 };
		},
	);
});

afterEach(() => {
	delete process.env.FACTORY_REPO;
	delete process.env.FACTORY_LABEL;
	delete process.env.GITHUB_TOKEN;
});

describe("spec-to-pr workflow", () => {
	it("derives collision-resistant branches from the full delivery ID", () => {
		expect(branchName(42, "delivery-123456")).not.toBe(
			branchName(42, "delivery-654321"),
		);
	});

	it("discards execution checkpoints when the saved sandbox is gone", async () => {
		const attemptId = "delivery-stale1";
		state.sandboxStatus = "terminated";
		state.checkpoints.set("sandbox", {
			id: "stale-sandbox",
			ready: true,
			remoteUrl: "https://github.com/acme/factory.git",
			remoteHead: "origin/main",
			base: "main",
			baseSha: "base-sha",
			branch: branchName(42, attemptId),
		});
		state.checkpoints.set("analysis", "stale analysis");
		state.checkpoints.set("implementation-1", {
			raw: implementation,
			report: JSON.parse(implementation),
		});

		const result = await specToPr({ issueNumber: 42, attemptId });

		expect(result).toMatchObject({ status: "draft_pr_opened" });
		expect(state.analysisTask).toHaveBeenCalledOnce();
		expect(state.implementTask).toHaveBeenCalledOnce();
	});

	it("does not replay an interrupted model stage", async () => {
		state.checkpoints.set("analysis-started", true);

		await expect(
			specToPr({
				issueNumber: 42,
				attemptId: "delivery-interrupted",
			}),
		).rejects.toThrow(/refusing non-deterministic replay/);
		expect(state.analysisTask).not.toHaveBeenCalled();
	});

	it("opens an approved draft PR and verifies the pushed SHA", async () => {
		const result = await specToPr({
			issueNumber: 42,
			attemptId: "delivery-123456",
		});

		expect(result).toEqual({
			status: "draft_pr_opened",
			decision: "approve",
			pullRequest: "https://github.test/pull/7",
		});
		expect(state.implementTask).toHaveBeenCalledOnce();
		expect(state.securityTask).toHaveBeenCalledOnce();
		expect(state.correctnessTask).toHaveBeenCalledOnce();
		expect(state.testsTask).toHaveBeenCalledOnce();
		expect(state.execGitWithToken).toHaveBeenCalledWith(
			sandbox,
			"token",
			expect.arrayContaining(["ls-remote"]),
		);
		expect(state.ensurePull).toHaveBeenCalledWith(
			{ owner: "acme", repo: "factory", fullName: "acme/factory" },
			expect.objectContaining({ draft: true, base: "main" }),
		);
		expect(state.completeIntake).toHaveBeenCalledOnce();
		expect(state.terminate).toHaveBeenCalledOnce();

		const replay = await specToPr({
			issueNumber: 42,
			attemptId: "delivery-123456",
		});
		expect(replay).toEqual(result);
		expect(state.implementTask).toHaveBeenCalledOnce();
		expect(state.terminate).toHaveBeenCalledTimes(2);
	});

	it("runs one revision and a second review before opening the draft", async () => {
		state.judgeTask
			.mockResolvedValueOnce(
				JSON.stringify({
					decision: "request_changes",
					summary: "fix the edge case",
				}),
			)
			.mockResolvedValueOnce(
				JSON.stringify({ decision: "approve", summary: "fixed" }),
			);

		const result = await specToPr({
			issueNumber: 42,
			attemptId: "delivery-654321",
		});

		expect(result).toMatchObject({
			status: "draft_pr_opened",
			decision: "approve",
		});
		expect(state.implementTask).toHaveBeenCalledTimes(2);
		expect(state.judgeTask).toHaveBeenCalledTimes(2);
		expect(state.commitCount).toBe(2);
	});

	it("stops without pushing when the revision still fails review", async () => {
		state.judgeTask.mockResolvedValue(
			JSON.stringify({
				decision: "request_changes",
				summary: "still unsafe",
			}),
		);

		const result = await specToPr({
			issueNumber: 42,
			attemptId: "delivery-999999",
		});

		expect(result).toEqual({
			status: "changes_requested",
			summary: "still unsafe",
		});
		expect(state.implementTask).toHaveBeenCalledTimes(2);
		expect(state.ensurePull).not.toHaveBeenCalled();
		expect(state.execGitWithToken).toHaveBeenCalledTimes(1);
	});
});
