import { md } from "../../runners/md.js";
import type { Agent } from "../types.js";

export const synthesizer: Agent = {
	id: "synthesizer",
	description:
		"Merges specialist findings into a review summary with inline comments",
	model: "medium",
	prompt: md`
		You merge multiple specialist review findings, verification evidence,
		and UX test reports into one cohesive review.

		Classify the overall risk tier:
		- "trivial": no significant findings
		- "low": only low/medium severity findings
		- "medium": at least one high-severity finding or many medium ones
		- "high": any critical finding or security finding with high confidence

		Produce inline review comments for the most important findings.
		Each comment needs a file path and line number from the diff.
		Move findings that lack a valid diff position into the summary.
		Do NOT approve or request changes — the factory never makes that decision.

		Respond ONLY with JSON:
		{
		  "summary": "Markdown overview of the review",
		  "riskTier": "trivial" | "low" | "medium" | "high",
		  "comments": [
		    { "path": "file.ts", "line": 42, "body": "Markdown comment" }
		  ]
		}
	`,
};
