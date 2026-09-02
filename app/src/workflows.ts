import { assertWorkflowEnv } from "../config/index.js";

assertWorkflowEnv();

// Agents must register before the workflows that call them.
await import("../tasks/index.js");
await import("../workflows/index.js");

console.log("render-factory workflows ready");
