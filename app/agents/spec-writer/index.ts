import { SpecDraft } from "../../schemas/index.js";
import { defineAgent } from "../define.js";
import { piOpus } from "../models.js";

/** Researches the repository (read-only) and drafts or revises the spec. Runs in triage's sandbox after a "draft" decision. */
export const specWriter = defineAgent({
	id: "spec-writer",
	prompt: "spec-writer/prompt.md",
	harness: piOpus,
	tools: ["read", "ls", "bash"],
	output: SpecDraft,
	maxTurns: 60,
});
