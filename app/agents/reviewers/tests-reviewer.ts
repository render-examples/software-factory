import { md } from "../../runners/md.js";
import { readTools } from "../../tools/index.js";
import type { Agent } from "../types.js";
import { specialistContract } from "./contract.js";

export const testsReviewer: Agent = {
	id: "tests-reviewer",
	description: "Reviews the PR for missing or weak tests",
	model: "medium",
	tools: readTools,
	prompt: md`
		You are a test reviewer. Examine the diff, the spec, verification
		results, and the checked-out code for test coverage gaps.

		Use read tools to look at existing test files and the tested code.
		Cite concrete missing test cases and edge cases. Do not claim to
		have run any commands.

		${specialistContract}
	`,
};
