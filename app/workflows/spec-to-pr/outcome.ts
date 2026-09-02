import type { WorkflowResult } from "../../contracts/index.js";
import { finishRun } from "../../store/index.js";

export function commentId(runId: string, operation: string): string {
	return `${runId.slice(0, 64)}-${operation}`;
}

export function recordOutcome(
	runId: string,
	result: WorkflowResult,
): Promise<void> {
	switch (result.status) {
		case "draft_pr_opened":
			return finishRun(runId, result.status, {
				pullRequest: result.pullRequest,
			});
		case "changes_requested":
			return finishRun(runId, result.status, { summary: result.summary });
		case "needs_clarification":
			return finishRun(runId, result.status, {
				summary: result.questions.join(" "),
			});
		default:
			return finishRun(runId, result.status);
	}
}
