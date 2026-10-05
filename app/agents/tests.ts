import { md } from "../runners/index.js";
import { reviewerOutputContract } from "./review-contract.js";
import type { Agent } from "./types.js";

export const tests: Agent = {
	id: "tests",
	description: "Reviews the diff for missing or weak tests",
	model: "small",
	prompt: md`
		Review the supplied diff and implementation report for test coverage gaps.
		Cite concrete missing cases; do not claim to have run any commands.

		${reviewerOutputContract}
	`,
};
