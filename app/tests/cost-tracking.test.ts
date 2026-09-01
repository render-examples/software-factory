import { describe, expect, it, vi } from "vitest";
import { costTrackingHook } from "../hooks/cost-tracking.js";
import type { AgentEvent } from "#factory/sdk";

const ctx = { runId: "run-1", agentId: "implementer" };

function usageEvent(
	inputTokens: number,
	outputTokens: number,
	model = "claude-sonnet-5",
): Extract<AgentEvent, { type: "usage" }> {
	return {
		type: "usage",
		usage: { inputTokens, outputTokens, model },
	};
}

function resultEvent(result = "done"): Extract<AgentEvent, { type: "result" }> {
	return { type: "result", result };
}

describe("cost-tracking hook", () => {
	it("accumulates usage across multiple turns and logs on result", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await costTrackingHook.handle(usageEvent(1000, 500), ctx);
		await costTrackingHook.handle(usageEvent(800, 300), ctx);

		expect(logSpy).not.toHaveBeenCalled();

		await costTrackingHook.handle(resultEvent(), ctx);

		expect(logSpy).toHaveBeenCalledOnce();
		const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
		expect(logged).toMatchObject({
			event: "agent_usage_summary",
			agentId: "implementer",
			runId: "run-1",
			totalInputTokens: 1800,
			totalOutputTokens: 800,
			turns: 2,
			model: "claude-sonnet-5",
		});

		logSpy.mockRestore();
	});

	it("always returns continue (never blocks)", async () => {
		const usageResult = await costTrackingHook.handle(
			usageEvent(100, 50),
			{ runId: "run-2", agentId: "triage" },
		);
		expect(usageResult.action).toBe("continue");

		const resultResult = await costTrackingHook.handle(
			resultEvent(),
			{ runId: "run-2", agentId: "triage" },
		);
		expect(resultResult.action).toBe("continue");
	});

	it("handles result without prior usage gracefully", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await costTrackingHook.handle(resultEvent(), {
			runId: "run-no-usage",
			agentId: "judge",
		});

		expect(logSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("tracks separate runs independently", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const ctx1 = { runId: "run-a", agentId: "security" };
		const ctx2 = { runId: "run-b", agentId: "correctness" };

		await costTrackingHook.handle(usageEvent(500, 200), ctx1);
		await costTrackingHook.handle(usageEvent(700, 300), ctx2);

		await costTrackingHook.handle(resultEvent(), ctx1);
		const logged1 = JSON.parse(logSpy.mock.calls[0][0] as string);
		expect(logged1.totalInputTokens).toBe(500);
		expect(logged1.agentId).toBe("security");

		await costTrackingHook.handle(resultEvent(), ctx2);
		const logged2 = JSON.parse(logSpy.mock.calls[1][0] as string);
		expect(logged2.totalInputTokens).toBe(700);
		expect(logged2.agentId).toBe("correctness");

		logSpy.mockRestore();
	});
});
