import type { WorkflowResult } from "../../contracts/index.js";
import { finishRun } from "../../store/index.js";

export function commentId(runId: string, operation: string): string {
	return `${runId.slice(0, 64)}-${operation}`;
}

export async function recordOutcome(
	runId: string,
	result: WorkflowResult,
): Promise<void> {
	switch (result.status) {
		case "draft_pr_opened":
			await finishRun(runId, "completed", {
				outcome: "draft_pr_opened",
				result: { pullRequest: result.pullRequest },
			});
			return;
		case "changes_requested":
			await finishRun(runId, "completed", {
				outcome: "changes_requested",
				summary: result.summary,
			});
			return;
		case "needs_clarification":
			await finishRun(runId, "completed", {
				outcome: "needs_clarification",
				summary: result.questions.join(" "),
			});
			return;
		case "no_changes":
			await finishRun(runId, "completed", {
				outcome: "no_changes",
			});
			return;
	}
}
