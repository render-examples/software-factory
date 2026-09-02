import { type Agent, md } from "../claude/index.js";
import { reviewerOutputContract } from "./review-contract.js";

export const correctness: Agent = {
	id: "correctness",
	description: "Reviews the diff for correctness defects",
	model: "medium",
	prompt: md`
		Review the supplied diff for logic errors, broken edge cases,
		error-handling gaps, and violations of the requested behavior.

		${reviewerOutputContract}
	`,
};
