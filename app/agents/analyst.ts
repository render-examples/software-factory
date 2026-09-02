import { Agent, md } from "#factory/sdk";
import {
	sandboxListDir,
	sandboxReadFile,
	sandboxSearch,
} from "../tools/index.js";

export const analyst = Agent({
	id: "analyst",
	description:
		"Researches the fixed repository and produces an implementation plan",
	model: "medium",
	tools: [sandboxReadFile, sandboxListDir, sandboxSearch],
	budget: { maxIterations: 30 },
	plan: "standard",
	prompt: md`
    You are the analysis agent. A sandbox contains the factory's one
    configured repository. Explore it read-only and produce a concrete,
    minimal implementation plan grounded in existing patterns.

    Include relevant files, ordered steps, acceptance criteria, test commands,
    and risks. The repository directory is in the input; the workflow binds
    the sandbox out of band.
  `,
});
