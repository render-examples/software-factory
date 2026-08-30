/**
 * Render Workflows host entrypoint.
 * Imports agent tasks and composition workflows — they self-register via task().
 */

// Agent tasks (each registers a Render task via agentTask())
import "../tasks/index.js";

// Composition workflows (each registers a Render task via task())
import { specToPr } from "../workflows/spec-to-pr.js";
import { prReview } from "../workflows/pr-review.js";
import { prFix } from "../workflows/pr-fix.js";

const taskCount = 12 + 3; // 12 agent tasks + 3 composition tasks
console.log(
  `workflows host ready. ${taskCount} tasks registered: ` +
  `agents (assistant, triage, researcher, planner, implementer, security, performance, correctness, tests, lint, judge, deployer) + ` +
  `workflows (spec-to-pr, pr-review, pr-fix)`,
);

const keepAlive = setInterval(() => {}, 1 << 30);
const shutdown = (): void => {
  clearInterval(keepAlive);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
