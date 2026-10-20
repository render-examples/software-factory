import { ImplementationReview } from "../../schemas/index.js";
import { defineAgent } from "../define.js";

/** Placeholders in prompt.md. `repo`: "owner/name"; `baseRef`: the commit the implementation started from. */
export const implementationReviewerVars = ["repo", "baseRef"] as const;

/** Reviews the implementation before publishing. Read-only, in the Spec-to-PR sandbox. */
export const implementationReviewer = defineAgent({
	id: "implementation-reviewer",
	prompt: "implementation-reviewer/prompt.md",
	model: "medium",
	tools: ["read", "ls", "bash"],
	output: ImplementationReview,
	maxTurns: 40,
});
