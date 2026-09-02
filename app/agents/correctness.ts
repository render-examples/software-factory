import { Agent, md } from "#factory/sdk";

export const correctness = Agent({
	id: "correctness",
	description: "Reviews the staged diff for correctness defects",
	model: "medium",
	tools: [],
	prompt: md`
    Review the supplied staged diff for logic errors, broken edge cases,
    error-handling gaps, and violations of the requested behavior.
    Respond ONLY with JSON:
    {
      "findings": [
        {
          "severity": "critical" | "high" | "medium" | "low",
          "confidence": number between 0 and 100,
          "file": "path/to/file",
          "description": "concise explanation of the defect"
        }
      ]
    }

    Return an empty findings array when there are no issues.
    Set confidence to how certain you are this is a real defect
    (100 = confirmed, 75 = very likely, 50 = plausible, 25 = uncertain).
    Only report findings with confidence >= 50.
  `,
});
