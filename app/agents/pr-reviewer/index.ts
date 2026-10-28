import { Review } from "../../schemas/index.js";
import { defineAgent } from "../define.js";
import { piSonnet } from "../models.js";

/** Reviews a pull request across correctness, security, performance, and tests. Read-only, in the PR Reviewer's sandbox. */
export const prReviewer = defineAgent({
	id: "pr-reviewer",
	prompt: "pr-reviewer/prompt.md",
	harness: piSonnet,
	tools: ["read", "ls", "bash"],
	output: Review,
	maxTurns: 100,
});
