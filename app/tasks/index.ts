import {
	implementer,
	selfReview,
	specWriter,
	triage,
} from "../agents/index.js";
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
