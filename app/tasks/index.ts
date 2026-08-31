import { agentTask } from "#factory/sdk";
import {
  assistant,
  triage,
  analyst,
  implementer,
  security,
  correctness,
  tests,
  judge,
} from "../agents/index.js";

export const assistantTask = agentTask(assistant);
export const triageTask = agentTask(triage);
export const analysisTask = agentTask(analyst);
export const implementTask = agentTask(implementer);
export const securityTask = agentTask(security);
export const correctnessTask = agentTask(correctness);
export const testsTask = agentTask(tests);
export const judgeTask = agentTask(judge);
