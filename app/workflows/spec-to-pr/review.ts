import type { TaskContext } from "@renderinc/sdk/workflows";
import { type SelfReview, selfReviewSchema } from "../../contracts/index.js";
import { selfReviewTask } from "../../tasks/index.js";
import { agentJson } from "../agent-json.js";

export function runSelfReview(
	ctx: TaskContext,
	diff: string,
	workItem: string,
	runId: string,
): Promise<SelfReview> {
	return agentJson(
		(message) => ctx.run(selfReviewTask, { runId, message }),
		selfReviewSchema,
		`Work item:\n${workItem}\n\nComplete diff:\n${diff}`,
		"self-review",
	);
}
