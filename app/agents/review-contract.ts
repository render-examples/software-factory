import { md } from "../claude/index.js";

/** Shared by the three reviewers so the judge gets one comparable shape. */
export const reviewerOutputContract = md`
	Respond ONLY with JSON:
	{
	  "findings": [
	    {
	      "severity": "critical" | "high" | "medium" | "low",
	      "confidence": number between 0 and 100,
	      "file": "path/to/file",
	      "description": "concise explanation"
	    }
	  ]
	}

	Return an empty findings array when there are no issues. Confidence is how
	certain you are the finding is real (100 = confirmed, 75 = very likely,
	50 = plausible, 25 = uncertain). Only report findings with confidence >= 50.
`;
