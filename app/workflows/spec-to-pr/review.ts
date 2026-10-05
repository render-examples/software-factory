import type { TaskContext } from "@renderinc/sdk/workflows";
import { parseModelJson } from "../../runners/index.js";
import {
	judgeSchema,
	type Review,
	reviewerOutputSchema,
	type SelfReview,
	selfReviewSchema,
} from "../../contracts/index.js";
import { reviewerSection } from "../../format/index.js";
import {
	correctnessTask,
	judgeTask,
	securityTask,
	selfReviewTask,
	testsTask,
} from "../../tasks/index.js";
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

/** Fan out to three reviewers in parallel, then synthesize with the judge. */
export async function reviewDiff(
	ctx: TaskContext,
	diff: string,
	implementationSummary: string,
	runId: string,
): Promise<Review> {
	const [securityRaw, correctnessRaw, testsRaw] = await Promise.all([
		ctx.run(securityTask, { runId, message: diff }),
		ctx.run(correctnessTask, { runId, message: diff }),
		ctx.run(testsTask, {
			runId,
			message: `${implementationSummary}\n\nComplete diff:\n${diff}`,
		}),
	]);

	const details = [
		reviewerSection(
			"Security",
			parseModelJson(reviewerOutputSchema, securityRaw),
			securityRaw,
		),
		reviewerSection(
			"Correctness",
			parseModelJson(reviewerOutputSchema, correctnessRaw),
			correctnessRaw,
		),
		reviewerSection(
			"Tests",
			parseModelJson(reviewerOutputSchema, testsRaw),
			testsRaw,
		),
	].join("\n\n");

	const verdict = await agentJson(
		(message) => ctx.run(judgeTask, { runId, message }),
		judgeSchema,
		`${details}\n\nComplete diff:\n${diff}`,
		"judge",
	);
	return { ...verdict, details };
}
