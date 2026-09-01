import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startTask } = vi.hoisted(() => ({ startTask: vi.fn() }));

vi.mock("@renderinc/sdk", () => ({
	Render: class {
		workflows = { startTask };
	},
}));

import { dispatchWorkflowTask } from "../gateway/dispatch.js";

beforeEach(() => {
	startTask.mockReset();
	startTask.mockResolvedValue({ taskRunId: "run-1" });
	process.env.RENDER_WORKFLOW_SLUG = "acme/factory";
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.RENDER_WORKFLOW_SLUG;
});

describe("dispatchWorkflowTask", () => {
	it("sends the small issue reference unchanged", async () => {
		const payload = { issueNumber: 42, runId: "run-123456" };
		const result = await dispatchWorkflowTask("spec-to-pr", payload);

		expect(result).toEqual({
			ok: true,
			taskName: "spec-to-pr",
			taskRunId: "run-1",
		});
		expect(startTask).toHaveBeenCalledWith("acme/factory/spec-to-pr", [
			payload,
		]);
	});

	it("fails without a workflow slug", async () => {
		delete process.env.RENDER_WORKFLOW_SLUG;
		const result = await dispatchWorkflowTask("spec-to-pr", {
			issueNumber: 42,
			runId: "run-123456",
		});
		expect(result).toEqual({
			ok: false,
			reason: "no-slug",
			taskName: "spec-to-pr",
		});
		expect(startTask).not.toHaveBeenCalled();
	});

	it("returns the dispatch error", async () => {
		const error = new Error("boom");
		startTask.mockRejectedValue(error);
		const result = await dispatchWorkflowTask("spec-to-pr", {
			issueNumber: 42,
			runId: "run-123456",
		});
		expect(result).toEqual({
			ok: false,
			reason: "error",
			taskName: "spec-to-pr",
			error,
		});
	});
});
