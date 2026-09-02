import { Agent, md } from "#factory/sdk";

export const triage = Agent({
	id: "triage",
	description: "Decides whether a labeled issue is actionable",
	model: "small",
	tools: [],
	prompt: md`
    You triage one GitHub issue for an unattended software factory.
    Decide whether it has enough concrete detail to implement safely.

    Respond ONLY with JSON:
    { "hasEnoughDetail": boolean, "questions": string[], "rationale": string }
  `,
});
