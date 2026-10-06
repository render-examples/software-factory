import {
	analyst,
	correctness,
	implementer,
	judge,
	security,
	selfReview,
	specWriter,
	tests,
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
export const analysisTask = agentTask(analyst);
export const implementTask = agentTask(implementer);
export const selfReviewTask = agentTask(selfReview);
export const securityTask = agentTask(security);
export const correctnessTask = agentTask(correctness);
export const testsTask = agentTask(tests);
export const judgeTask = agentTask(judge);
