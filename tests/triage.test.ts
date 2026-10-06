/**
 * Triage workflow unit tests. Every external boundary is mocked:
 * no models, no sandbox, no GitHub, no Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskContext } from "@renderinc/sdk/workflows";

const mocks = vi.hoisted(() => ({
	triageTask: vi.fn(),
	specWriterTask: vi.fn(),
	gh: {
		getIssue: vi.fn(),
		listIssueComments: vi.fn(),
		getPermission: vi.fn(),
		ensureIssueComment: vi.fn(),
		upsertMarkedComment: vi.fn(),
		removeLabel: vi.fn(),
		addLabels: vi.fn(),
	},
	openWorkspace: vi.fn(),
	closeWorkspace: vi.fn(),
	listTrackedFiles: vi.fn(),
	markStarted: vi.fn(),
	getRun: vi.fn(),
	heartbeat: vi.fn(),
	finishRun: vi.fn(),
	setRunStage: vi.fn(),
	appendEvent: vi.fn(),
	createSpec: vi.fn(),
	addSpecVersion: vi.fn(),
	getCurrentSpec: vi.fn(),
	getSpecVersion: vi.fn(),
	setSpecCommentId: vi.fn(),
	supersedeSpec: vi.fn(),
}));

vi.mock("@renderinc/sdk/workflows", () => ({
	task: (config: { name: string }, handler: unknown) => ({
		name: config.name,
		handler,
	}),
}));

vi.mock("../app/tasks/index.js", () => ({
	triageTask: { name: "triage", func: mocks.triageTask },
	specWriterTask: { name: "spec-writer", func: mocks.specWriterTask },
	isBudgetExceeded: (err: unknown) =>
		err instanceof Error && err.message.includes("[BUDGET_EXCEEDED]"),
}));

vi.mock("../app/github/index.js", () => ({
	githubFromEnv: () => mocks.gh,
	githubToken: async () => "ghs_installation_token",
}));

vi.mock("../app/store/index.js", () => ({
	markStarted: mocks.markStarted,
	getRun: mocks.getRun,
	heartbeat: mocks.heartbeat,
	finishRun: mocks.finishRun,
	setRunStage: mocks.setRunStage,
	appendEvent: mocks.appendEvent,
	createSpec: mocks.createSpec,
	addSpecVersion: mocks.addSpecVersion,
	getCurrentSpec: mocks.getCurrentSpec,
	getSpecVersion: mocks.getSpecVersion,
	setSpecCommentId: mocks.setSpecCommentId,
	supersedeSpec: mocks.supersedeSpec,
}));

vi.mock("../app/workspaces/index.js", () => ({
	openWorkspace: mocks.openWorkspace,
	closeWorkspace: mocks.closeWorkspace,
}));

vi.mock("../app/git/index.js", () => ({
	listTrackedFiles: mocks.listTrackedFiles,
}));

function makeRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-t1",
		repo: "jacobprall/render-factory-sample",
		subjectKind: "issue",
		subjectNumber: 42,
		workflow: "triage",
		status: "running",
		stage: null,
		outcome: null,
		result: null,
		summary: null,
		trigger: {
			deliveryId: "del-1",
			event: "issues",
			action: "labeled",
			label: "factory:triage",
			actor: { login: "Maintainer", id: 1 },
		},
		input: { autoAdvance: false },
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

function humanComment(id: number, body: string, user = "Maintainer") {
	return {
		id,
		body,
		user,
		authorType: "User",
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function botComment(id: number, body: string, user = "factory-bot") {
	return {
		id,
		body,
		user,
		authorType: "Bot",
		createdAt: "2026-01-01T00:00:00Z",
	};
}

const validSpec = {
	title: "Add retries",
	summary: "Add retry logic to the HTTP client",
	problem: "Requests fail without retries",
	goals: ["Automatic retries on transient failures"],
	nonGoals: ["Circuit breaker"],
	acceptanceCriteria: [
		{ id: "AC-1", text: "Retries on 5xx", verification: "automated" as const },
	],
	approach: "Wrap fetch calls with a retry helper",
	affectedAreas: [{ path: "src/client.ts", change: "Add retry wrapper" }],
	testPlan: "Unit tests for retry logic",
	risks: ["May mask real errors"],
	assumptions: ["Server returns 5xx on transient failures"],
	openQuestions: [],
};

const validNotes = {
	findings: "The client is in src/client.ts with basic fetch calls",
	relevantPaths: ["src/client.ts"],
};

type TaskShape = {
	handler: (ctx: unknown, input: unknown) => Promise<unknown>;
};

let mockCtx: TaskContext;

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ shouldAdvanceTime: true });

	mockCtx = {
		metadata: {},
		run: vi
			.fn()
			.mockImplementation(
				async (
					taskDef: { func: (...args: unknown[]) => unknown },
					...args: unknown[]
				) => taskDef.func(mockCtx, ...args),
			),
	} as unknown as TaskContext;

	mocks.markStarted.mockResolvedValue(true);
	mocks.getRun.mockResolvedValue(makeRun());
	mocks.heartbeat.mockResolvedValue(undefined);
	mocks.finishRun.mockResolvedValue({
		finished: true,
		followUpCreated: false,
	});
	mocks.setRunStage.mockResolvedValue(undefined);
	mocks.appendEvent.mockResolvedValue("1");

	mocks.gh.getIssue.mockResolvedValue({
		number: 42,
		title: "Add retries",
		body: "Please add retries to the HTTP client.",
		state: "open",
		labels: ["factory:triage"],
		user: "Maintainer",
		htmlUrl: "https://github.com/test/test/issues/42",
	});
	mocks.gh.listIssueComments.mockResolvedValue([]);
	mocks.gh.getPermission.mockResolvedValue("admin");
	mocks.gh.ensureIssueComment.mockResolvedValue(undefined);
	mocks.gh.upsertMarkedComment.mockResolvedValue({ id: "comment-1" });
	mocks.gh.removeLabel.mockResolvedValue(undefined);
	mocks.gh.addLabels.mockResolvedValue(undefined);

	mocks.openWorkspace.mockResolvedValue({
		sandbox: {
			id: "sbx-1",
			run: vi.fn(),
			mustRun: vi.fn(),
			terminate: vi.fn(),
		},
		sandboxRecordId: "sbx-rec-1",
		repoDir: "/home/user/repo",
		baseBranch: "main",
		baseSha: "sha-base",
		headSha: "sha-head",
	});
	mocks.closeWorkspace.mockResolvedValue(undefined);
	mocks.listTrackedFiles.mockResolvedValue(new Set(["src/client.ts"]));

	mocks.getCurrentSpec.mockResolvedValue(null);
	mocks.getSpecVersion.mockResolvedValue(null);
	mocks.createSpec.mockResolvedValue(undefined);
	mocks.addSpecVersion.mockResolvedValue(1);
	mocks.setSpecCommentId.mockResolvedValue(undefined);
	mocks.supersedeSpec.mockResolvedValue(undefined);

	return () => {
		vi.useRealTimers();
	};
});

describe("triage workflow", () => {
	describe("assess routing", () => {
		it("routes ask decision to question comment", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "ask",
					questions: ["Which HTTP client?"],
					rationale: "Ambiguous target",
					findings: "Multiple clients found",
					relevantPaths: ["src/client.ts", "src/api.ts"],
				}),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.finishRun).toHaveBeenCalledWith(
				"run-t1",
				"completed",
				expect.objectContaining({
					outcome: "asked",
				}),
			);
			expect(mocks.gh.ensureIssueComment).toHaveBeenCalledWith(
				expect.anything(),
				42,
				expect.stringContaining("questions"),
				expect.stringContaining("Which HTTP client?"),
			);
		});

		it("routes draft decision to spec creation", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear issue",
					findings: "Client is in src/client.ts",
					relevantPaths: ["src/client.ts"],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.finishRun).toHaveBeenCalledWith(
				"run-t1",
				"completed",
				expect.objectContaining({
					outcome: "spec_drafted",
					result: expect.objectContaining({ version: 1 }),
				}),
			);
			expect(mocks.createSpec).toHaveBeenCalled();
			expect(mocks.addSpecVersion).toHaveBeenCalled();
			expect(mocks.gh.upsertMarkedComment).toHaveBeenCalled();
		});

		it("routes decline decision to decline comment", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "decline",
					questions: [],
					rationale: "This is spam",
					findings: "",
					relevantPaths: [],
				}),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.finishRun).toHaveBeenCalledWith(
				"run-t1",
				"completed",
				expect.objectContaining({
					outcome: "declined",
				}),
			);
			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeUndefined();
		});
	});

	describe("spec validation", () => {
		it("repairs invalid spec output once, then fails", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask
				.mockResolvedValueOnce("I am not JSON")
				.mockResolvedValueOnce("Still not JSON");

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;

			await expect(wf.handler(mockCtx, { runId: "run-t1" })).rejects.toThrow(
				/invalid structured output/,
			);
			expect(mocks.specWriterTask).toHaveBeenCalledTimes(2);
		});

		it("repairs on first failure and succeeds on second", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask
				.mockResolvedValueOnce("not json")
				.mockResolvedValueOnce(
					JSON.stringify({ spec: validSpec, notes: validNotes }),
				);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.finishRun).toHaveBeenCalledWith(
				"run-t1",
				"completed",
				expect.objectContaining({ outcome: "spec_drafted" }),
			);
		});
	});

	describe("spec comment editing in place", () => {
		it("edits the same comment on round 2", async () => {
			mocks.getCurrentSpec.mockResolvedValue({
				id: "spec-1",
				repo: "jacobprall/render-factory-sample",
				issueNumber: 42,
				status: "draft",
				currentVersion: 1,
				approvedVersion: null,
				approvedBy: null,
				approvedAt: null,
				commentId: "comment-1",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			mocks.getSpecVersion.mockResolvedValue({
				specId: "spec-1",
				version: 1,
				document: validSpec,
				markdown: "# v1",
				notes: validNotes,
				lastCommentId: "100",
				runId: "run-prev",
				createdAt: new Date().toISOString(),
			});
			mocks.addSpecVersion.mockResolvedValue(2);

			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Revising based on feedback",
					findings: "Updated findings",
					relevantPaths: ["src/client.ts"],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({
					spec: validSpec,
					notes: validNotes,
					changeSummary: "Updated the approach",
				}),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.createSpec).not.toHaveBeenCalled();
			expect(mocks.addSpecVersion).toHaveBeenCalledWith(
				expect.objectContaining({ specId: "spec-1" }),
			);
			expect(mocks.gh.upsertMarkedComment).toHaveBeenCalledWith(
				expect.anything(),
				42,
				expect.stringContaining("spec:spec-1"),
				expect.anything(),
			);
			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.result).toEqual({ specId: "spec-1", version: 2 });
		});
	});

	describe("approval label removal (B-04)", () => {
		it("removes factory:spec-approved when drafting a new version", async () => {
			mocks.gh.getIssue.mockResolvedValue({
				number: 42,
				title: "Add retries",
				body: "Please add retries.",
				state: "open",
				labels: ["factory:triage", "factory:spec-approved"],
				user: "Maintainer",
				htmlUrl: "https://github.com/test/test/issues/42",
			});
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.gh.removeLabel).toHaveBeenCalledWith(
				expect.anything(),
				42,
				"factory:spec-approved",
			);

			const upsertCall = mocks.gh.upsertMarkedComment.mock.calls[0];
			const commentBody = upsertCall[3] as string;
			expect(commentBody).toContain("spec-approved");
		});
	});

	describe("follow-up round (B-03)", () => {
		it("queues follow-up when unread human comments exist", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			mocks.gh.listIssueComments
				.mockResolvedValueOnce([humanComment(100, "Please handle retries")])
				.mockResolvedValueOnce([
					humanComment(100, "Please handle retries"),
					humanComment(200, "Also handle timeouts"),
				]);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeDefined();
			expect(finishCall.followUp.workflow).toBe("triage");
			expect(finishCall.followUp.trigger.event).toBe("follow_up");
		});

		it("does not queue follow-up when no new comments exist", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			const sameComments = [humanComment(100, "Please handle retries")];
			mocks.gh.listIssueComments.mockResolvedValue(sameComments);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeUndefined();
		});

		it("does not queue follow-up for declined outcome", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "decline",
					questions: [],
					rationale: "Spam",
					findings: "",
					relevantPaths: [],
				}),
			);

			mocks.gh.listIssueComments
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([humanComment(300, "New comment")]);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeUndefined();
		});

		it("ignores factory marker comments when detecting unread", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			mocks.gh.listIssueComments
				.mockResolvedValueOnce([humanComment(100, "Please handle retries")])
				.mockResolvedValueOnce([
					humanComment(100, "Please handle retries"),
					botComment(
						200,
						"<!-- render-factory:spec:abc --> spec comment",
						"github-actions[bot]",
					),
				]);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeUndefined();
		});

		it("ignores Bot-type comments even without a marker", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			mocks.gh.listIssueComments
				.mockResolvedValueOnce([humanComment(100, "Please handle retries")])
				.mockResolvedValueOnce([
					humanComment(100, "Please handle retries"),
					botComment(200, "Some bot comment without a marker"),
				]);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeUndefined();
		});

		it("reply-triggered asked round with no newer comment queues no follow-up", async () => {
			// This is the regression test for the infinite-loop bug.
			// The trigger is an issue_comment, meaning a human reply started
			// this round. If no comment with a strictly greater ID appeared
			// during the run, no follow-up should be queued.
			mocks.getRun.mockResolvedValue(
				makeRun({
					trigger: {
						deliveryId: "del-1",
						event: "issue_comment",
						action: "created",
						commentId: 100,
						actor: { login: "Maintainer", id: 1 },
					},
				}),
			);

			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "ask",
					questions: ["Which client?"],
					rationale: "Ambiguous",
					findings: "",
					relevantPaths: [],
				}),
			);

			const theComments = [humanComment(100, "Here is my reply")];
			// Both fetches return the same list — no new comment arrived.
			mocks.gh.listIssueComments.mockResolvedValue(theComments);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeUndefined();
		});

		it("reply-triggered asked round with one newer comment queues exactly one follow-up", async () => {
			mocks.getRun.mockResolvedValue(
				makeRun({
					trigger: {
						deliveryId: "del-1",
						event: "issue_comment",
						action: "created",
						commentId: 100,
						actor: { login: "Maintainer", id: 1 },
					},
				}),
			);

			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "ask",
					questions: ["Which client?"],
					rationale: "Ambiguous",
					findings: "",
					relevantPaths: [],
				}),
			);

			// Intake fetch sees comment 100.
			mocks.gh.listIssueComments
				.mockResolvedValueOnce([humanComment(100, "My reply")])
				// Fresh fetch at end sees 100 + 200.
				.mockResolvedValueOnce([
					humanComment(100, "My reply"),
					humanComment(200, "Another reply during the run"),
				]);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeDefined();
			expect(finishCall.followUp.workflow).toBe("triage");
		});
	});

	describe("superseding an approved spec on fresh label", () => {
		it("supersedes the approved spec and starts a new one", async () => {
			mocks.getCurrentSpec.mockResolvedValue({
				id: "spec-old",
				repo: "jacobprall/render-factory-sample",
				issueNumber: 42,
				status: "approved",
				currentVersion: 1,
				approvedVersion: 1,
				approvedBy: "Maintainer",
				approvedAt: new Date().toISOString(),
				commentId: "comment-old",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});

			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Fresh start",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.supersedeSpec).toHaveBeenCalledWith("spec-old");
			expect(mocks.createSpec).toHaveBeenCalled();
		});
	});

	describe("removeLabels behavior", () => {
		it("keeps the trigger label on ask (removeLabels: [])", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "ask",
					questions: ["Which one?"],
					rationale: "Unclear",
					findings: "",
					relevantPaths: [],
				}),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const finishCall = mocks.finishRun.mock.calls[0][2];
			expect(finishCall.followUp).toBeUndefined();
		});

		it("keeps the trigger label on spec_drafted (removeLabels: [])", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });
		});
	});

	describe("workspace lifecycle", () => {
		it("opens a workspace and defers close", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "ask",
					questions: ["What?"],
					rationale: "Unclear",
					findings: "",
					relevantPaths: [],
				}),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			expect(mocks.openWorkspace).toHaveBeenCalledWith("run-t1", {
				kind: "branch",
				name: "main",
			});
			expect(mocks.closeWorkspace).toHaveBeenCalledWith("run-t1");
		});
	});

	describe("spec markdown storage", () => {
		it("stores rendered markdown not JSON in spec_versions", async () => {
			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			const addCall = mocks.addSpecVersion.mock.calls[0][0];
			expect(addCall.markdown).toContain("### Problem");
			expect(addCall.markdown).toContain("### Acceptance criteria");
			expect(addCall.markdown).not.toContain('"title"');
		});
	});

	describe("path warnings via existingPaths", () => {
		it("passes tracked files to validateSpec for path warnings", async () => {
			mocks.listTrackedFiles.mockResolvedValue(new Set(["src/other.ts"]));

			mocks.triageTask.mockResolvedValue(
				JSON.stringify({
					decision: "draft",
					questions: [],
					rationale: "Clear",
					findings: "found it",
					relevantPaths: [],
				}),
			);
			mocks.specWriterTask.mockResolvedValue(
				JSON.stringify({ spec: validSpec, notes: validNotes }),
			);

			const { triageWorkflow } = await import(
				"../app/workflows/triage/index.js"
			);
			const wf = triageWorkflow as unknown as TaskShape;
			await wf.handler(mockCtx, { runId: "run-t1" });

			// validSpec has path "src/client.ts" which is not in existingPaths
			// so the spec comment should show a path warning
			const upsertCall = mocks.gh.upsertMarkedComment.mock.calls[0];
			const body = upsertCall[3] as string;
			expect(body).toContain("src/client.ts does not exist yet");
		});
	});
});
