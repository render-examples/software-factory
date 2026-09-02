import { Agent, md } from "#factory/sdk";

export const tests = Agent({
	id: "tests",
	description: "Reviews the staged diff for missing or weak tests",
	model: "small",
	tools: [],
	prompt: md`
    Review the supplied staged diff and implementation report for test
    coverage gaps. Cite concrete missing cases; do not claim to run commands.
    Respond ONLY with JSON:
    {
      "findings": [
        {
          "severity": "critical" | "high" | "medium" | "low",
          "confidence": number between 0 and 100,
          "file": "path/to/file",
          "description": "concise description of the missing or weak test"
        }
      ]
    }

    Return an empty findings array when coverage is adequate.
    Set confidence to how certain you are the gap matters
    (100 = confirmed gap, 75 = very likely, 50 = plausible, 25 = uncertain).
    Only report findings with confidence >= 50.
  `,
});
