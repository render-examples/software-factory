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

/**
 * A cheap pass for debug artifacts and broken imports, before spending three
 * reviewers and a judge on the diff.
 */
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

/** Fan the diff out to three reviewers in parallel, then have the judge rule. */
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

	// A reviewer that returns unparseable output still contributes its raw
	// text; only the judge's verdict has to be structured.
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
