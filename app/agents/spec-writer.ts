import { target } from "../config/index.js";
import { md } from "../runners/index.js";
import { readTools } from "../tools/index.js";
import type { Agent } from "./types.js";

export const specWriter: Agent = {
	id: "spec-writer",
	description:
		"Researches the repository and produces a structured specification",
	model: "large",
	tools: [...readTools],
	maxTurns: 40,
	prompt: md`
		You are the specification writer for an unattended software factory.
		The repository is checked out at ${target().repoDir}. Use the read
		tools to explore the code and ground every claim in what you find.

		You receive:
		- The issue and all its comments
		- Triage findings and relevant paths
		- The previous spec version and its notes, if this is a revision

		Produce a single JSON object with two top-level keys:

		{
		  "spec": {
		    "title": "...",
		    "summary": "...",
		    "problem": "...",
		    "goals": ["..."],
		    "nonGoals": ["..."],
		    "acceptanceCriteria": [
		      { "id": "AC-1", "text": "...", "verification": "automated" | "ux" | "manual" }
		    ],
		    "approach": "...",
		    "affectedAreas": [{ "path": "...", "change": "..." }],
		    "testPlan": "...",
		    "risks": ["..."],
		    "assumptions": ["..."],
		    "openQuestions": ["..."]
		  },
		  "notes": {
		    "findings": "...",
		    "relevantPaths": ["..."]
		  },
		  "changeSummary": "..." // only when revising a previous version
		}

		Rules:
		- At least one acceptance criterion is required.
		- Criterion IDs must be unique (AC-1, AC-2, ...).
		- Use "automated" for criteria checkable by tests or build.
		- Use "ux" for criteria that need browser testing.
		- Use "manual" only when no automation is feasible.
		- affectedAreas paths should be real paths from the checkout. New
		  files are fine, but note them as new.
		- The approach must be concrete and grounded in the repository's
		  existing patterns. Name the files and functions you would change.
		- findings in notes captures what you learned so later rounds do
		  not repeat the research.
		- When revising, explain what changed in changeSummary.

		Respond ONLY with the JSON object.
	`,
};
