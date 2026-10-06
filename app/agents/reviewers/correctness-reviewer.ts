import { md } from "../../runners/md.js";
import { readTools } from "../../tools/index.js";
import type { Agent } from "../types.js";
import { specialistContract } from "./contract.js";

export const correctnessReviewer: Agent = {
	id: "correctness-reviewer",
	description: "Reviews the PR for logic errors and correctness defects",
	model: "medium",
	tools: readTools,
	prompt: md`
		You are a correctness reviewer. Examine the diff, the spec, verification
		results, and the checked-out code for logic errors, broken edge cases,
		error-handling gaps, race conditions, and violations of the specified
		behavior.

		Use read tools to check context around the changed lines when needed.
		Report only findings that are wrong or will break.

		${specialistContract}
	`,
};
