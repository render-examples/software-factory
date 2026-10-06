import { md } from "../../runners/md.js";

/** Shared output contract for PR Reviewer specialist agents. */
export const specialistContract = md`
	Respond ONLY with JSON:
	{
	  "findings": [
	    {
	      "path": "relative/path/to/file",
	      "line": <line number in the file>,
	      "severity": "critical" | "high" | "medium" | "low",
	      "confidence": <number 0–100>,
	      "title": "short one-line title",
	      "body": "detailed explanation with evidence",
	      "evidence": "the specific code or pattern that supports this finding"
	    }
	  ]
	}

	Return an empty findings array when there are no issues. Only report
	findings with confidence >= 50. Confidence scale: 100 = confirmed,
	75 = very likely, 50 = plausible. Line numbers must reference actual
	lines in the diff or the checked-out files.
`;
