/**
 * Render Workflows entrypoint — imports all tasks and workflows to register them.
 */

// Agent tasks
import "../tasks/index.js";

// Composition workflows
import "../workflows/spec-to-pr.js";
import "../workflows/pr-review.js";
import "../workflows/pr-fix.js";

console.log("workflows host ready — tasks registered");
