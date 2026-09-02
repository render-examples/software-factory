import { parseModelJson } from "../../claude/index.js";
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
	diff: string,
	workItem: string,
): Promise<SelfReview> {
	return agentJson(
		(message) => selfReviewTask({ message }),
		selfReviewSchema,
		`Work item:\n${workItem}\n\nComplete diff:\n${diff}`,
		"self-review",
	);
}

/** Fan out to three reviewers in parallel, then synthesize with the judge. */
export async function reviewDiff(
	diff: string,
	implementationSummary: string,
): Promise<Review> {
	const [securityRaw, correctnessRaw, testsRaw] = await Promise.all([
		securityTask({ message: diff }),
		correctnessTask({ message: diff }),
		testsTask({
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
		(message) => judgeTask({ message }),
		judgeSchema,
		`${details}\n\nComplete diff:\n${diff}`,
		"judge",
	);
	return { ...verdict, details };
}
