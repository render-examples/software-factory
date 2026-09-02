/**
 * The only place this factory talks to a model.
 *
 * runClaude wraps the Claude Agent SDK's query(). Sandbox tools are bridged in
 * as an in-process MCP server, which is what lets an agent use them while
 * workflow code keeps ownership of the sandbox.
 */
export type { Agent } from "./agent.js";
export { parseModelJson } from "./json.js";
export { md } from "./md.js";
export {
	bareToolName,
	runClaude,
	type ClaudeRun,
	type RunClaudeOptions,
} from "./run.js";
