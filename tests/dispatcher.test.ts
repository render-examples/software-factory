import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claimForDispatch: vi.fn(),
	finishRun: vi.fn(),
	requeueForDispatch: vi.fn(),
	getRun: vi.fn(),
	appendEvent: vi.fn(),
}));

vi.mock("../app/store/index.js", () => ({
	claimForDispatch: mocks.claimForDispatch,
	finishRun: mocks.finishRun,
	requeueForDispatch: mocks.requeueForDispatch,
}));

vi.mock("../app/store/runs.js", () => ({
	getRun: mocks.getRun,
}));

vi.mock("../app/store/events.js", () => ({
	appendEvent: mocks.appendEvent,
}));

const { startDispatchLoop } = await import("../app/dispatcher/index.js");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.appendEvent.mockResolvedValue("1");
	mocks.finishRun.mockResolvedValue({
		finished: true,
		followUpCreated: false,
	});
});

describe("dispatcher loop", () => {
	it("claims runs and starts tasks", async () => {
		const startTask = vi.fn().mockResolvedValue({ taskRunId: "trn-1" });
		mocks.claimForDispatch.mockResolvedValueOnce([
			{ id: "run-1", workflow: "spec-to-pr" },
		]);
		mocks.claimForDispatch.mockResolvedValue([]);

		const loop = startDispatchLoop({
			workflowSlug: "wfs-1",
			startTask,
			pollIntervalMs: 50,
		});

		await new Promise((r) => setTimeout(r, 150));
		loop.stop();

		expect(startTask).toHaveBeenCalledWith("wfs-1/spec-to-pr", [
			{ runId: "run-1" },
		]);
	});

	it("requeues on retryable errors with exponential backoff", async () => {
		const startTask = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error("timeout"), { status: 503 }));
		mocks.claimForDispatch.mockResolvedValueOnce([
			{ id: "run-2", workflow: "triage" },
		]);
		mocks.claimForDispatch.mockResolvedValue([]);
		mocks.getRun.mockResolvedValue({ id: "run-2", dispatchAttempts: 1 });

		const loop = startDispatchLoop({
			workflowSlug: "wfs-1",
			startTask,
			pollIntervalMs: 50,
		});

		await new Promise((r) => setTimeout(r, 150));
		loop.stop();

		expect(mocks.requeueForDispatch).toHaveBeenCalledWith(
			"run-2",
			expect.any(Date),
		);
		expect(mocks.finishRun).not.toHaveBeenCalled();
	});

	it("fails permanently on terminal errors (4xx)", async () => {
		const startTask = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("not found"), { status: 404 }),
			);
		mocks.claimForDispatch.mockResolvedValueOnce([
			{ id: "run-3", workflow: "spec-to-pr" },
		]);
		mocks.claimForDispatch.mockResolvedValue([]);
		mocks.getRun.mockResolvedValue({ id: "run-3", dispatchAttempts: 1 });

		const loop = startDispatchLoop({
			workflowSlug: "wfs-1",
			startTask,
			pollIntervalMs: 50,
		});

		await new Promise((r) => setTimeout(r, 150));
		loop.stop();

		expect(mocks.finishRun).toHaveBeenCalledWith("run-3", "failed", {
			outcome: "dispatch_failed",
			summary: expect.stringContaining("not found"),
		});
	});

	it("fails after max attempts", async () => {
		const startTask = vi
			.fn()
			.mockRejectedValue(
				Object.assign(new Error("server error"), { status: 500 }),
			);
		mocks.claimForDispatch.mockResolvedValueOnce([
			{ id: "run-4", workflow: "triage" },
		]);
		mocks.claimForDispatch.mockResolvedValue([]);
		mocks.getRun.mockResolvedValue({ id: "run-4", dispatchAttempts: 8 });

		const loop = startDispatchLoop({
			workflowSlug: "wfs-1",
			startTask,
			pollIntervalMs: 50,
		});

		await new Promise((r) => setTimeout(r, 150));
		loop.stop();

		expect(mocks.finishRun).toHaveBeenCalledWith("run-4", "failed", {
			outcome: "dispatch_failed",
			summary: expect.stringContaining("server error"),
		});
	});
});
