import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	markStarted: vi.fn(),
	getRun: vi.fn(),
	heartbeat: vi.fn(),
	finishRun: vi.fn(),
	setRunStage: vi.fn(),
	appendEvent: vi.fn(),
	getIssue: vi.fn(),
	getPermission: vi.fn(),
	ensureIssueComment: vi.fn(),
	removeLabel: vi.fn(),
	addLabels: vi.fn(),
}));

vi.mock("@renderinc/sdk/workflows", () => ({
	task: (_config: { name: string }, handler: unknown) => ({
		name: _config.name,
		handler,
	}),
}));

vi.mock("../app/store/index.js", () => ({
	markStarted: mocks.markStarted,
	getRun: mocks.getRun,
	heartbeat: mocks.heartbeat,
	finishRun: mocks.finishRun,
	setRunStage: mocks.setRunStage,
	appendEvent: mocks.appendEvent,
}));

const fakeGitHub = {
	getIssue: mocks.getIssue,
	getPermission: mocks.getPermission,
	ensureIssueComment: mocks.ensureIssueComment,
	removeLabel: mocks.removeLabel,
	addLabels: mocks.addLabels,
	listIssueComments: vi.fn().mockResolvedValue([]),
};

vi.mock("../app/github/index.js", () => ({
	githubFromEnv: () => fakeGitHub,
	githubToken: () => Promise.resolve("fake-token"),
}));

function makeRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		repo: "render-examples/render-factory-example-target",
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

type TaskShape = {
	handler: (ctx: unknown, input: unknown) => Promise<unknown>;
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ shouldAdvanceTime: true });

	mocks.markStarted.mockResolvedValue(true);
	mocks.getRun.mockResolvedValue(makeRun());
	mocks.heartbeat.mockResolvedValue(undefined);
	mocks.finishRun.mockResolvedValue({
		finished: true,
		followUpCreated: false,
	});
	mocks.setRunStage.mockResolvedValue(undefined);
	mocks.appendEvent.mockResolvedValue("1");
	mocks.getIssue.mockResolvedValue({
		number: 42,
		title: "Test issue",
		body: "Body",
		state: "open",
		labels: ["factory:spec-approved"],
		user: "Maintainer",
		htmlUrl: "https://github.com/test/test/issues/42",
	});
	mocks.getPermission.mockResolvedValue("admin");
	mocks.ensureIssueComment.mockResolvedValue(undefined);
	mocks.removeLabel.mockResolvedValue(undefined);
	mocks.addLabels.mockResolvedValue(undefined);

	return () => {
		vi.useRealTimers();
	};
});

describe("lifecycle", () => {
	it("duplicate start returns stored result", async () => {
		mocks.markStarted.mockResolvedValue(false);
		mocks.getRun.mockResolvedValue(
			makeRun({ result: { pullRequest: "https://pr" } }),
		);

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-workflow", {}, async () => ({
			status: "completed" as const,
			outcome: "test_done",
		})) as unknown as TaskShape;

		const result = await workflow.handler({}, { runId: "run-1" });
		expect(result).toEqual({ pullRequest: "https://pr" });
		expect(mocks.finishRun).not.toHaveBeenCalled();
	});

	it("rejects when actor has insufficient permission", async () => {
		mocks.getPermission.mockResolvedValue("read");

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const handler = vi.fn();
		const workflow = runWorkflow(
			"test-wf",
			{},
			handler,
		) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		expect(handler).not.toHaveBeenCalled();
		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "completed", {
			outcome: "rejected",
			summary: expect.stringContaining("Insufficient permission"),
		});
	});

	it("removes the trigger label on rejection", async () => {
		mocks.getPermission.mockResolvedValue("read");

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow(
			"test-wf",
			{},
			vi.fn(),
		) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		expect(mocks.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:spec-approved",
		);
	});

	it("rejects when trigger has no actor (fail closed)", async () => {
		mocks.getRun.mockResolvedValue(
			makeRun({
				trigger: {
					deliveryId: "del-1",
					event: "issues",
					action: "labeled",
					label: "factory:spec-approved",
				},
			}),
		);

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const handler = vi.fn();
		const workflow = runWorkflow(
			"test-wf",
			{},
			handler,
		) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		expect(handler).not.toHaveBeenCalled();
		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "completed", {
			outcome: "rejected",
			summary: "No actor login in the trigger",
		});
		expect(mocks.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:spec-approved",
		);
	});

	it("maps GitHub 404 on permission check to rejected", async () => {
		mocks.getPermission.mockResolvedValue("none");

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const handler = vi.fn();
		const workflow = runWorkflow(
			"test-wf",
			{},
			handler,
		) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		expect(handler).not.toHaveBeenCalled();
		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "completed", {
			outcome: "rejected",
			summary: expect.stringContaining("none"),
		});
	});

	it("checks trigger label is still present", async () => {
		mocks.getIssue.mockResolvedValue({
			number: 42,
			title: "Test",
			body: "",
			state: "open",
			labels: [],
			user: "Maintainer",
			htmlUrl: "https://github.com/test/test/issues/42",
		});

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const handler = vi.fn();
		const workflow = runWorkflow(
			"test-wf",
			{},
			handler,
		) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		expect(handler).not.toHaveBeenCalled();
		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "completed", {
			outcome: "trigger_removed",
			summary: expect.stringContaining("no longer present"),
		});
	});

	it("handles cancellation at stage boundary", async () => {
		let callCount = 0;
		mocks.getRun.mockImplementation(() => {
			callCount++;
			if (callCount > 1) {
				return Promise.resolve(
					makeRun({ cancelRequestedAt: new Date().toISOString() }),
				);
			}
			return Promise.resolve(makeRun());
		});

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async (lc) => {
			await lc.throwIfCancelled();
			return { status: "completed" as const, outcome: "done" };
		}) as unknown as TaskShape;

		const result = await workflow.handler({}, { runId: "run-1" });
		expect(result).toEqual({ status: "cancelled" });

		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "cancelled", {
			outcome: "cancelled",
			summary: "Run was cancelled by user",
		});
	});

	it("runs deferred cleanup in reverse order", async () => {
		const order: number[] = [];

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async (lc) => {
			lc.defer(async () => {
				order.push(1);
			});
			lc.defer(async () => {
				order.push(2);
			});
			lc.defer(async () => {
				order.push(3);
			});
			return { status: "completed" as const, outcome: "done" };
		}) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		expect(order).toEqual([3, 2, 1]);
	});

	it("redacts secrets in error comments", async () => {
		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async () => {
			throw new Error("Something went wrong with sk-ant-api0123456789012345");
		}) as unknown as TaskShape;

		await expect(workflow.handler({}, { runId: "run-1" })).rejects.toThrow();

		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "failed", {
			outcome: "error",
			summary: expect.stringContaining("[REDACTED]"),
		});
	});

	it("removes the trigger label on error (failed)", async () => {
		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async () => {
			throw new Error("boom");
		}) as unknown as TaskShape;

		await expect(workflow.handler({}, { runId: "run-1" })).rejects.toThrow();

		expect(mocks.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:spec-approved",
		);
	});

	it("creates a follow-up run when specified", async () => {
		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async () => ({
			status: "completed" as const,
			outcome: "spec_drafted",
			followUp: {
				id: "follow-up-1",
				repo: "render-examples/render-factory-example-target",
				subjectKind: "issue" as const,
				subjectNumber: 42,
				workflow: "triage",
			},
		})) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "completed", {
			outcome: "spec_drafted",
			result: undefined,
			followUp: expect.objectContaining({
				id: "follow-up-1",
				workflow: "triage",
			}),
		});
	});

	it("follow-up inherits actor from the current trigger", async () => {
		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async () => ({
			status: "completed" as const,
			outcome: "asked",
			followUp: {
				id: "follow-up-2",
				repo: "render-examples/render-factory-example-target",
				subjectKind: "issue" as const,
				subjectNumber: 42,
				workflow: "triage",
				trigger: {
					deliveryId: "del-2",
					event: "issue_comment",
					action: "created",
				},
			},
		})) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		const finishCall = mocks.finishRun.mock.calls[0];
		const followUpTrigger = finishCall[2].followUp.trigger;
		expect(followUpTrigger.actor).toEqual({ login: "Maintainer", id: 1 });
	});

	it("handles budget exceeded as completed with budget_exceeded outcome", async () => {
		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async () => {
			throw new Error(
				"[BUDGET_EXCEEDED] Run run-1 has spent $20.0500, which meets or exceeds the $20.00 per-run limit",
			);
		}) as unknown as TaskShape;

		const result = await workflow.handler({}, { runId: "run-1" });
		expect(result).toEqual({ status: "budget_exceeded" });

		expect(mocks.finishRun).toHaveBeenCalledWith("run-1", "completed", {
			outcome: "budget_exceeded",
			summary: expect.stringContaining("BUDGET_EXCEEDED"),
		});

		expect(mocks.ensureIssueComment).toHaveBeenCalledWith(
			expect.anything(),
			42,
			expect.stringContaining("budget"),
			expect.stringContaining("per-run cost budget"),
		);

		expect(mocks.removeLabel).toHaveBeenCalledWith(
			expect.anything(),
			42,
			"factory:spec-approved",
		);
	});

	it("ends stage spans when the next stage starts", async () => {
		const spanEvents: Array<{
			type: string;
			phase: string;
			stage?: string;
		}> = [];
		mocks.appendEvent.mockImplementation(
			(input: { type: string; phase: string; stage?: string }) => {
				spanEvents.push({
					type: input.type,
					phase: input.phase,
					stage: input.stage,
				});
				return Promise.resolve("1");
			},
		);

		const { runWorkflow } = await import("../app/workflows/lifecycle.js");
		const workflow = runWorkflow("test-wf", {}, async (lc) => {
			await lc.stage("intake");
			await lc.stage("implement");
			await lc.stage("verify");
			return { status: "completed" as const, outcome: "done" };
		}) as unknown as TaskShape;

		await workflow.handler({}, { runId: "run-1" });

		const stageSpans = spanEvents.filter((e) => e.type === "stage");
		expect(stageSpans).toEqual([
			{ type: "stage", phase: "start", stage: "intake" },
			{ type: "stage", phase: "end", stage: "intake" },
			{ type: "stage", phase: "start", stage: "implement" },
			{ type: "stage", phase: "end", stage: "implement" },
			{ type: "stage", phase: "start", stage: "verify" },
			{ type: "stage", phase: "end", stage: "verify" },
		]);
	});
});
