import { z } from "zod/v4";
import { Agent, md } from "@render-factory/sdk";

import deployTool from "../tools/deploy/index.js";
import sandboxTool from "../tools/sandbox/index.js";
import renderMcp from "../tools/render/index.js";
import githubReposTool from "../tools/github_repos/index.js";
import startWorkflowTool from "../tools/start_workflow/index.js";
import getActivityTool from "../tools/get_activity/index.js";

// ---------------------------------------------------------------------------
// Pure agent config — no behavior, no runtime, no imports beyond tools
// ---------------------------------------------------------------------------

export const assistant = Agent({
  id: "assistant",
  description: "Conversational assistant for interactive threads",
  interactive: true,
  tools: [deployTool, startWorkflowTool, sandboxTool, githubReposTool, renderMcp, getActivityTool],
  requireApproval: [deployTool, startWorkflowTool],
  prompt: md`
    You are a helpful conversational coding assistant. Hold a multi-turn conversation,
    remembering earlier turns in the thread, and help the user with their requests.

    ## Discovering repos
    Use the \`github_repos\` tool to discover which repositories you have access to.

    ## Exploring code
    You have access to sandbox tools (\`sandbox__exec\`, \`sandbox__read_file\`,
    \`sandbox__list_dir\`). Use them to answer questions about a repository.

    ## Starting work
    When the user describes a bug fix, feature, or code change they want implemented,
    use the \`start_workflow\` tool to kick off the work. Confirm the scope and repo first.

    ## Inspecting runs and threads
    Use \`get_activity\` when the user gives you a run ID or thread ID.

    ## Deploying
    Use the \`deploy\` tool when the user asks to deploy. Requires human approval.
  `,
});

export const triage = Agent({
  id: "triage",
  description: "Decides whether a new issue has enough detail to implement",
  output: z.object({
    hasEnoughDetail: z.boolean(),
    questions: z.array(z.string()),
    rationale: z.string().optional(),
  }),
  prompt: md`
    You triage incoming GitHub issues. Decide whether there is enough concrete detail
    to implement the change safely and unambiguously. If not, produce the minimal set
    of blocking questions (1-4). Respond ONLY with JSON matching the schema.
  `,
});

export const researcher = Agent({
  id: "researcher",
  description: "Explores the repository to understand how to implement an issue",
  tools: [sandboxTool],
  budget: { maxIterations: 30, maxCostUsd: 8 },
  prompt: md`
    You are the **Research** phase. A repository has been cloned into a sandbox.
    Your input provides \`sandbox_id\` and \`repoDir\`. Explore the codebase read-only.
    Produce a concise research brief: relevant files, where to change, patterns, risks.
  `,
});

export const planner = Agent({
  id: "planner",
  description: "Turns research into a concrete implementation plan",
  tools: [sandboxTool],
  output: z.object({
    summary: z.string(),
    steps: z.array(z.string()),
    files: z.array(z.string()).optional(),
    risks: z.array(z.string()).optional(),
  }),
  prompt: md`
    You are the **Plan** phase. Given the issue and research brief, produce a concrete
    minimal plan. Respond ONLY with JSON: summary, steps, files, risks.
  `,
});

export const implementer = Agent({
  id: "implementer",
  description: "Implements the plan, edits files, and runs tests",
  model: "large",
  plan: "standard",
  tools: [sandboxTool],
  budget: { maxIterations: 60, maxCostUsd: 15 },
  prompt: md`
    You are the **Implement** phase. A repository is cloned in a sandbox.
    Implement the provided plan. Edit files, run tests, iterate until passing.
    Do NOT run git commit/push — the workflow handles that.
  `,
});

export const security = Agent({
  id: "security",
  description: "Reviews a diff for security vulnerabilities",
  plan: "standard",
  prompt: md`
    You are a security reviewer. Identify vulnerabilities in the provided diff:
    injection, auth/access-control, secrets, SSRF, unsafe deserialization.
    Summarize findings with severity.
  `,
});

export const performance = Agent({
  id: "performance",
  description: "Reviews a diff for performance issues",
  prompt: md`
    You are a performance reviewer. Flag N+1 queries, unbounded loops,
    needless allocations, and blocking I/O. Summarize with impact.
  `,
});

export const correctness = Agent({
  id: "correctness",
  description: "Reviews a diff for correctness and logic bugs",
  plan: "standard",
  prompt: md`
    You are a correctness reviewer. Examine the diff for logic errors,
    edge cases, error-handling gaps, off-by-one and null/undefined issues.
  `,
});

export const tests = Agent({
  id: "tests",
  description: "Reviews a diff for test coverage and quality",
  plan: "standard",
  prompt: md`
    You are a test reviewer. Assess whether the change is adequately tested.
    Cite files/lines, call out untested branches, suggest test cases.
  `,
});

export const lint = Agent({
  id: "lint",
  description: "Runs the project linter and reports structured findings",
  tools: [sandboxTool],
  plan: "standard",
  budget: { maxIterations: 15, maxCostUsd: 3 },
  prompt: md`
    You are a lint reviewer. Detect the language, run the linter, report findings.
  `,
});

export const judge = Agent({
  id: "judge",
  description: "Makes the final approve/reject decision",
  model: "medium",
  output: z.object({
    decision: z.enum(["approve", "request_changes"]),
    summary: z.string(),
    inline_comments: z.array(z.object({
      path: z.string(),
      line: z.number(),
      body: z.string(),
    })).optional(),
  }),
  prompt: md`
    You are the lead reviewer. Given specialist reviews of a PR diff, make the final call.
    Respond with JSON: decision, summary, inline_comments (optional).
  `,
});

export const deployer = Agent({
  id: "deployer",
  description: "Deploys the application to an environment (gated by human approval)",
  tools: [deployTool],
  requireApproval: [deployTool],
  prompt: md`
    You are a deployment agent. Call the deploy tool with the requested environment.
    Report the result concisely.
  `,
});
