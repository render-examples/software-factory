/**
 * Workflow manifest.
 *
 * Exporting a workflow here evaluates its task() definition and registers it
 * with Render. app/src/workflows.ts imports this module after the agent tasks,
 * so every task name a workflow calls already exists by then.
 *
 * A task name is its dispatch address: renaming one changes where the gateway
 * must send work.
 */
export { agentJson, type AgentCall } from "./agent-json.js";
export { specToPr } from "./spec-to-pr/index.js";
