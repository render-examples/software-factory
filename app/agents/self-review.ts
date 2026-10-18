import { SelfReview } from "../contracts/index.js";
import { defineAgent } from "./define.js";

/** Placeholders in self-review.md. `repo`: "owner/name"; `baseRef`: the commit the implementation started from. */
export const selfReviewVars = ["repo", "baseRef"] as const;

/** Catches obvious defects in the implementer's working tree before publishing. Read-only, in the Spec-to-PR sandbox. */
export const selfReview = defineAgent({
	id: "self-review",
	prompt: "self-review.md",
	model: "medium",
	tools: ["read", "ls", "bash"],
	output: SelfReview,
	maxTurns: 40,
});
