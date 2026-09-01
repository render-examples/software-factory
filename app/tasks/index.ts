import { agentTask } from "#factory/sdk";
import {
  triage,
  analyst,
  implementer,
  selfReview,
  security,
  correctness,
  tests,
  judge,
} from "../agents/index.js";

export const triageTask = agentTask(triage);
export const analysisTask = agentTask(analyst);
export const implementTask = agentTask(implementer);
export const selfReviewTask = agentTask(selfReview);
export const securityTask = agentTask(security);
export const correctnessTask = agentTask(correctness);
export const testsTask = agentTask(tests);
export const judgeTask = agentTask(judge);
