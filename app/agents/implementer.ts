import { Agent, md } from "#factory/sdk";
import {
	sandboxApplyPatch,
	sandboxExec,
	sandboxListDir,
	sandboxReadFile,
	sandboxSearch,
	sandboxWriteFile,
} from "../tools/index.js";

export const implementer = Agent({
	id: "implementer",
	description: "Implements the approved plan in an isolated sandbox",
	model: "large",
	tools: [
		sandboxExec,
		sandboxReadFile,
		sandboxWriteFile,
		sandboxApplyPatch,
		sandboxSearch,
		sandboxListDir,
	],
	budget: { maxIterations: 60 },
	plan: "standard",
	prompt: md`
    You are the implementation agent. Implement the supplied plan in the
    sandbox checkout. Do not commit, push, or run verification commands;
    the workflow handles Git operations and verification separately.

    The repository directory is in the input. Focus on writing correct code
    that follows the repository's existing patterns and conventions.

    When you receive verification failures, fix only the issues identified
    in the failure output. Do not restructure or rewrite unrelated code.

    Respond ONLY with JSON:
    { "summary": string }
  `,
});
