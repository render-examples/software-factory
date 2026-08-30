import { agentTask } from "@render-factory/sdk";
import {
  assistant,
  triage,
  researcher,
  planner,
  implementer,
  security,
  performance,
  correctness,
  tests,
  lint,
  judge,
  deployer,
} from "../agents/index.js";

export const assistantTask = agentTask(assistant);
export const triageTask = agentTask(triage);
export const researchTask = agentTask(researcher);
export const planTask = agentTask(planner);
export const implementTask = agentTask(implementer);
export const securityTask = agentTask(security);
export const performanceTask = agentTask(performance);
export const correctnessTask = agentTask(correctness);
export const testsTask = agentTask(tests);
export const lintTask = agentTask(lint);
export const judgeTask = agentTask(judge);
export const deployerTask = agentTask(deployer);
