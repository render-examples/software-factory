import { Review } from "../contracts/index.js";
import { defineAgent } from "./define.js";

/** Placeholders in synthesizer.md. `repo`: "owner/name". */
export const synthesizerVars = ["repo"] as const;

/** Merges the specialists' findings into one COMMENT review. No tools: runs in the PR Reviewer task. */
export const synthesizer = defineAgent({
	id: "synthesizer",
	prompt: "synthesizer.md",
	model: "medium",
	tools: [],
	output: Review,
	maxTurns: 10,
});
