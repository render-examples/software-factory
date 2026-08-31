import { agentTask } from "#factory-sdk";
import {
  triage,
  analyst,
  implementer,
  security,
  correctness,
  tests,
  judge,
} from "#factory-agents";

export const triageTask = agentTask(triage);
export const analysisTask = agentTask(analyst);
export const implementTask = agentTask(implementer);
export const securityTask = agentTask(security);
export const correctnessTask = agentTask(correctness);
export const testsTask = agentTask(tests);
export const judgeTask = agentTask(judge);
