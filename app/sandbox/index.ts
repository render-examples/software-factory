/**
 * Render Sandboxes — the isolated VM where a run's checkout lives.
 *
 * Workflow code creates a sandbox, passes the ID to agent tasks, and
 * terminates it in a finally block. Agents never create or select one.
 */
export { collectExecOutput, shellEscape } from "./exec.js";
export { createSandbox, connectSandbox } from "./lifecycle.js";
export { Sandbox } from "./sandbox.js";
export type {
	CreateSandboxOptions,
	ExecEvent,
	ExecResult,
	UploadData,
} from "./types.js";
