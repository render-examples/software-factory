import { Agent, md } from "#factory-sdk";

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
  description: "Researches the fixed repository and produces an implementation plan",
  model: "medium",
  tools: [
    "sandbox__read_file",
    "sandbox__list_dir",
    "sandbox__search",
  ],
  budget: { maxIterations: 30 },
  plan: "standard",
  prompt: md`
    You are the analysis station. A sandbox contains the factory's one
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
    You are the implementation station. Implement the supplied plan in the
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

export const security = Agent({
  id: "security",
  description: "Reviews the staged diff for security vulnerabilities",
  model: "small",
  tools: [],
  prompt: md`
    Review the supplied staged diff for exploitable security problems.
    Report only actionable findings, with severity and file context.
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
  `,
});

export const judge = Agent({
  id: "judge",
  description: "Synthesizes the three internal reviews",
  model: "medium",
  tools: [],
  prompt: md`
    Synthesize the security, correctness, and test reviews of one staged diff.
    Respond ONLY with JSON:
    { "decision": "approve" | "request_changes", "summary": string }
  `,
});
