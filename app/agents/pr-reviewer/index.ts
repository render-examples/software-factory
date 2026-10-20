import { Review } from "../../schemas/index.js";
import { defineAgent } from "../define.js";

/** Placeholders in prompt.md. `repo`: "owner/name"; `baseRef`: the PR's merge base. */
export const prReviewerVars = ["repo", "baseRef"] as const;

/** Reviews a pull request across correctness, security, performance, and tests. Read-only, in the PR Reviewer's sandbox. */
export const prReviewer = defineAgent({
	id: "pr-reviewer",
	prompt: "pr-reviewer/prompt.md",
	model: "medium",
	tools: ["read", "ls", "bash"],
	output: Review,
	maxTurns: 100,
});
