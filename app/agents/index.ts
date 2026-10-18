import { correctnessReviewer, performanceReviewer, securityReviewer, testsReviewer } from "./reviewers.js";

export type { Usage } from "../runner/protocol.js";
export { type Agent, type AgentSpec, defineAgent, type OutputSchema, type ThinkingLevel } from "./define.js";
export { implementer, implementerVars, verifyCommandsVar } from "./implementer.js";
export { correctnessReviewer, performanceReviewer, securityReviewer, specialistVars, testsReviewer } from "./reviewers.js";
export {
	AgentError,
	type AgentErrorCode,
	type AgentRun,
	type BaseRunOptions,
	type RunAgentInput,
	type RunAgentOptions,
	renderPrompt,
	runAgent,
} from "./run.js";
export { selfReview, selfReviewVars } from "./self-review.js";
export { specWriter, specWriterVars } from "./spec-writer.js";
export { synthesizer, synthesizerVars } from "./synthesizer.js";
export { triage, triageVars } from "./triage.js";

/** PR Reviewer's specialists by name. They share an output schema and the placeholders in `specialistVars`. */
export const specialists = {
	security: securityReviewer,
	correctness: correctnessReviewer,
	performance: performanceReviewer,
	tests: testsReviewer,
} as const;
export type SpecialistName = keyof typeof specialists;
