import { SpecialistReport } from "../contracts/index.js";
import { defineAgent } from "./define.js";

/** Placeholders in every specialist's prompt. `repo`: "owner/name"; `baseRef`: the PR's base commit, for `git diff baseRef...HEAD`. */
export const specialistVars = ["repo", "baseRef"] as const;

const specialist = (name: string) =>
	defineAgent({
		id: `${name}-reviewer`,
		prompt: `${name}-reviewer.md`,
		model: "medium",
		tools: ["read", "ls", "bash"],
		output: SpecialistReport,
		maxTurns: 60,
	});

/** PR Reviewer's specialists: read-only, run in parallel in one sandbox at the PR head. */
export const securityReviewer = specialist("security");
export const correctnessReviewer = specialist("correctness");
export const performanceReviewer = specialist("performance");
export const testsReviewer = specialist("tests");
