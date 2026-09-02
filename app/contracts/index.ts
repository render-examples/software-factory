/**
 * What the workflow accepts, and what each agent must return.
 *
 * Model output is never trusted unparsed. Every agent that emits JSON has a
 * schema here, and the workflow fails closed when output does not match.
 */
export {
	implementationSchema,
	selfReviewSchema,
	type Implementation,
	type SelfReview,
} from "./implementation.js";
export { workflowInputSchema, type WorkflowInput } from "./input.js";
export type { WorkflowResult } from "./result.js";
export {
	findingSchema,
	judgeSchema,
	reviewerOutputSchema,
	type Finding,
	type JudgeVerdict,
	type Review,
	type ReviewerOutput,
} from "./review.js";
export { triageSchema, type Triage } from "./triage.js";
