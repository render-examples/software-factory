import { type Agent, md } from "../claude/index.js";

export const judge: Agent = {
	id: "judge",
	description: "Synthesizes the three reviews into one decision",
	model: "medium",
	prompt: md`
		Synthesize the security, correctness, and test reviews of one diff. Each
		review contains structured findings with severity and confidence.

		Classify the overall risk:
		- "trivial": no findings, or all low severity with confidence < 75
		- "low": only low/medium severity findings, no critical or high
		- "medium": at least one high-severity finding, or many medium findings
		- "high": any critical finding, or security findings with confidence >= 75

		Respond ONLY with JSON:
		{
		  "decision": "approve" | "request_changes",
		  "riskTier": "trivial" | "low" | "medium" | "high",
		  "summary": string,
		  "topFindings": [
		    {
		      "source": "security" | "correctness" | "tests",
		      "severity": "critical" | "high" | "medium" | "low",
		      "confidence": number,
		      "file": string,
		      "description": string
		    }
		  ]
		}

		Include up to 5 top findings ranked by severity then confidence. Approve
		only when risk is trivial or low with no high-confidence issues. An empty
		topFindings array signals a clean review.
	`,
};
