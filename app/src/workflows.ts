/**
 * Workflows process — registers every task with Render.
 *
 * Registration is a module side effect. These imports are dynamic so the
 * environment is validated before any task is defined, and agents are
 * registered before the workflow that calls them.
 */
import { assertWorkflowEnv } from "../config/index.js";

assertWorkflowEnv();

await import("../tasks/index.js");
await import("../workflows/index.js");

console.log("render-factory workflows ready");
