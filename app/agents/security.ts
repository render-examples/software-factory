import { md } from "../runners/index.js";
import { reviewerOutputContract } from "./review-contract.js";
import type { Agent } from "./types.js";

export const security: Agent = {
	id: "security",
	description: "Reviews the diff for security vulnerabilities",
	model: "small",
	prompt: md`
		Review the supplied diff for exploitable security problems. Report only
		actionable findings.

		${reviewerOutputContract}
	`,
};
