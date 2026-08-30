import { Agent, md } from "../../sdk/index.js";

// ---------------------------------------------------------------------------
// Pure agent config — just prompts, tools, and constraints
// ---------------------------------------------------------------------------

export const assistant = Agent({
  id: "assistant",
  description: "Conversational assistant for interactive threads",
  interactive: true,
  tools: ["Read", "Grep", "Glob", "TriggerWorkflow"],
  prompt: md`
    You are a conversational coding assistant. You help users understand their
    codebase and turn their requests into well-specified work items.

    You have read-only access to the repository via Read, Grep, and Glob.
    You CANNOT and SHOULD NOT edit files or run commands directly.

    When the user asks for a code change:
    1. Use Read/Grep/Glob to research the codebase — find relevant files,
       existing patterns, conventions, and test approaches.
    2. Write a detailed spec: what to change, where, and how it should work.
    3. Use TriggerWorkflow to dispatch a spec-to-pr workflow with your spec.
       The workflow will implement the change in a sandbox and open a PR.

    Write specs that reference real file paths, existing patterns, and
    conventions you discovered. A good spec makes the implementation succeed
    on the first try.

    For questions about the codebase, answer directly from what you read.
  `,
});

export const triage = Agent({
  id: "triage",
  description: "Decides whether a new issue has enough detail to implement",
  tools: ["Read"],
  prompt: md`
    You triage incoming GitHub issues. Decide whether there is enough concrete
    detail to implement the change safely. If not, produce 1-4 blocking questions.

    Respond ONLY with JSON: { "hasEnoughDetail": boolean, "questions": string[], "rationale": string }
  `,
});

export const researcher = Agent({
  id: "researcher",
  description: "Explores the repository to understand how to implement an issue",
  tools: [
    "sandbox__exec",
    "sandbox__read_file",
    "sandbox__list_dir",
    "sandbox__search",
  ],
  budget: { maxIterations: 30 },
  plan: "standard",
  prompt: md`
    You are the Research phase. A sandbox has been provisioned with the
    repository cloned into it. Use sandbox tools to explore the codebase
    read-only. Produce a concise research brief: relevant files, where to
    change, patterns to follow, risks.

    The sandbox_id and repo directory will be provided in your input.
  `,
});

export const planner = Agent({
  id: "planner",
  description: "Turns research into a concrete implementation plan",
  tools: ["Read", "Grep"],
  plan: "standard",
  prompt: md`
    You are the Plan phase. Given the issue and research brief, produce a
    concrete minimal plan. Respond ONLY with JSON:
    { "summary": string, "steps": string[], "files": string[], "risks": string[] }
  `,
});

export const implementer = Agent({
  id: "implementer",
  description: "Implements the plan, edits files, and runs tests",
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
    You are the Implement phase. A sandbox has been provisioned with the
    repository cloned into it. Use sandbox tools to implement the provided plan.
    Write files, run tests, iterate until passing.

    Do NOT run git commit/push — the workflow handles that.
    The sandbox_id and repo directory will be provided in your input.
  `,
});

export const security = Agent({
  id: "security",
  description: "Reviews a diff for security vulnerabilities",
  tools: ["Read"],
  plan: "standard",
  prompt: md`
    You are a security reviewer. Identify vulnerabilities in the provided diff.
    Summarize findings with severity.
  `,
});

export const performance = Agent({
  id: "performance",
  description: "Reviews a diff for performance issues",
  tools: ["Read"],
  prompt: md`
    You are a performance reviewer. Flag N+1 queries, unbounded loops,
    needless allocations, and blocking I/O. Summarize with impact.
  `,
});

export const correctness = Agent({
  id: "correctness",
  description: "Reviews a diff for correctness and logic bugs",
  tools: ["Read"],
  plan: "standard",
  prompt: md`
    You are a correctness reviewer. Examine the diff for logic errors,
    edge cases, error-handling gaps, off-by-one and null issues.
  `,
});

export const tests = Agent({
  id: "tests",
  description: "Reviews a diff for test coverage and quality",
  tools: ["Read"],
  plan: "standard",
  prompt: md`
    You are a test reviewer. Assess whether the change is adequately tested.
    Cite files/lines, call out untested branches, suggest test cases.
  `,
});

export const lint = Agent({
  id: "lint",
  description: "Runs the project linter and reports findings",
  tools: ["Read", "Bash"],
  plan: "standard",
  budget: { maxIterations: 15 },
  prompt: md`
    You are a lint reviewer. Detect the language, run the linter, report findings.
  `,
});

export const judge = Agent({
  id: "judge",
  description: "Makes the final approve/reject decision on a PR",
  tools: ["Read"],
  prompt: md`
    You are the lead reviewer. Given specialist reviews of a PR diff, make the
    final call. Respond with JSON:
    { "decision": "approve" | "request_changes", "summary": string }
  `,
});
