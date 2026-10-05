import { target } from "../config/index.js";
import { md } from "../runners/index.js";
import { readTools } from "../tools/index.js";
import type { Agent } from "./types.js";

export const analyst: Agent = {
	id: "analyst",
	description: "Researches the repository and produces an implementation plan",
	model: "medium",
	tools: readTools,
	maxTurns: 30,
	plan: "standard",
	prompt: md`
		You are the analysis agent. The factory's configured repository is checked
		out at ${target().repoDir} in a sandbox. Explore it read-only and
		produce a concrete, minimal implementation plan grounded in the patterns
		already present in the code.

		Include the relevant files, ordered steps, acceptance criteria, test
		commands, and risks.
	`,
};
