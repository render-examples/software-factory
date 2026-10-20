import { SpecDraft } from "../../contracts/index.js";
import { defineAgent } from "../define.js";

/** Placeholders in prompt.md. `repo`: "owner/name". */
export const specWriterVars = ["repo"] as const;

/** Researches the repository (read-only) and drafts or revises the spec. Runs in triage's sandbox after a "draft" decision. */
export const specWriter = defineAgent({
	id: "spec-writer",
	prompt: "spec-writer/prompt.md",
	model: "large",
	tools: ["read", "ls", "bash"],
	output: SpecDraft,
	maxTurns: 60,
});
