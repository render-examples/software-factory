import { Agent, md } from "#factory/sdk";

export const security = Agent({
	id: "security",
	description: "Reviews the staged diff for security vulnerabilities",
	model: "small",
	tools: [],
	prompt: md`
    Review the supplied staged diff for exploitable security problems.
    Report only actionable findings. Respond ONLY with JSON:
    {
      "findings": [
        {
          "severity": "critical" | "high" | "medium" | "low",
          "confidence": number between 0 and 100,
          "file": "path/to/file",
          "description": "concise explanation of the vulnerability"
        }
      ]
    }

    Return an empty findings array when there are no issues.
    Set confidence to how certain you are this is a real exploitable problem
    (100 = confirmed, 75 = very likely, 50 = plausible, 25 = uncertain).
    Only report findings with confidence >= 50.
  `,
});
