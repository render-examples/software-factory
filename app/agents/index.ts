import { Agent, md } from "#factory/sdk";

export const triage = Agent({
	id: "triage",
	description: "Decides whether a labeled issue is actionable",
	model: "small",
	tools: [],
	prompt: md`
    You triage one GitHub issue for an unattended software factory.
    Decide whether it has enough concrete detail to implement safely.

    Respond ONLY with JSON:
    { "hasEnoughDetail": boolean, "questions": string[], "rationale": string }
  `,
});

export const analyst = Agent({
	id: "analyst",
	description:
		"Researches the fixed repository and produces an implementation plan",
	model: "medium",
	tools: ["sandbox__read_file", "sandbox__list_dir", "sandbox__search"],
	budget: { maxIterations: 30 },
	plan: "standard",
	prompt: md`
    You are the analysis agent. A sandbox contains the factory's one
    configured repository. Explore it read-only and produce a concrete,
    minimal implementation plan grounded in existing patterns.

    Include relevant files, ordered steps, acceptance criteria, test commands,
    and risks. The repository directory is in the input; the workflow binds
    the sandbox out of band.
  `,
});

export const implementer = Agent({
	id: "implementer",
	description: "Implements the approved plan in an isolated sandbox",
	model: "large",
	tools: [
		"sandbox__exec",
		"sandbox__read_file",
		"sandbox__write_file",
		"sandbox__apply_patch",
		"sandbox__search",
		"sandbox__list_dir",
	],
	budget: { maxIterations: 60 },
	plan: "standard",
	prompt: md`
    You are the implementation agent. Implement the supplied plan in the
    sandbox checkout, run the repository's own checks, and iterate until they
    pass. Do not commit or push; the workflow owns Git and GitHub side effects.

    The repository directory is in the input. Respond ONLY with JSON:
    {
      "summary": string,
      "verification": [
        { "command": string, "result": string, "passed": boolean }
      ]
    }

    Include every check you ran. Set passed=false when a check remains failing;
    never claim a command ran when it did not.
  `,
});

export const selfReview = Agent({
	id: "self-review",
	description:
		"Lightweight self-review of the implementation diff before the full review fan-out",
	model: "small",
	tools: [],
	prompt: md`
    You are a quick self-review agent. You receive a diff produced by the
    implementation agent and the original work item. Check for obvious issues
    that should be fixed before a full review:

    - Debug artifacts (console.log, TODO/FIXME/HACK left behind, commented-out code)
    - Broken imports or missing exports
    - Obvious type errors or syntax mistakes
    - Files that were changed but shouldn't have been
    - Missing or clearly wrong test assertions

    Respond ONLY with JSON:
    {
      "needsRevision": boolean,
      "issues": [string]
    }

    Set needsRevision to true only if you found concrete, fixable problems.
    An empty issues array means the diff is clean enough for full review.
  `,
});

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

export const judge = Agent({
	id: "judge",
	description: "Synthesizes the three internal reviews",
	model: "medium",
	tools: [],
	prompt: md`
    Synthesize the security, correctness, and test reviews of one staged diff.
    Each review contains structured findings with severity and confidence.

    Classify the overall change risk:
    - "trivial": no findings or all findings are low severity with confidence < 75
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

    Include up to 5 top findings ranked by severity then confidence.
    Approve only when risk is trivial or low with no high-confidence issues.
    An empty topFindings array signals a clean review.
  `,
});
