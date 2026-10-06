import {
	implementer,
	selfReview,
	specWriter,
	triage,
	synthesizer,
	uxTester,
	resolveSpecialists,
} from "../agents/index.js";
import { factoryConfig } from "../../factory.config.js";
import { agentTask } from "./agent-task.js";

export {
	agentTask,
	agentTaskInputSchema,
	type AgentTaskInput,
} from "./agent-task.js";
export { BudgetExceededError, isBudgetExceeded } from "./errors.js";

export const triageTask = agentTask(triage);
export const specWriterTask = agentTask(specWriter);
export const implementTask = agentTask(implementer);
export const selfReviewTask = agentTask(selfReview);
export const synthesizerTask = agentTask(synthesizer);
export const uxTesterTask = agentTask(uxTester);

/** One task per configured specialist, keyed by agent ID. */
export const specialistTasks = Object.fromEntries(
	resolveSpecialists(factoryConfig.review.specialists).map((agent) => [
		agent.id,
		agentTask(agent),
	]),
);
