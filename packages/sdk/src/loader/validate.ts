import type { RenderPlan } from "@render-agents/engine";
import type { ParsedFrontmatter } from "./frontmatter.js";
import {
  LoadError,
  ERR_INVALID_PLAN,
  ERR_INVALID_BUDGET,
  ERR_INVALID_OUTPUT,
  ERR_SUBAGENT_NOT_FOUND,
  ERR_SUBAGENT_SELF_REF,
  ERR_RUNNER_NOT_FOUND,
} from "./errors.js";

const VALID_PLANS: Set<string> = new Set([
  "starter", "standard", "pro", "pro_plus", "pro_max", "pro_ultra",
]);

export function validatePlan(plan: string | undefined, agentName: string): RenderPlan | undefined {
  if (!plan) return undefined;
  if (!VALID_PLANS.has(plan)) {
    throw new LoadError(
      ERR_INVALID_PLAN,
      `Agent "${agentName}" has plan "${plan}" which is not a known RenderPlan`,
      { agent: agentName, plan },
    );
  }
  return plan as RenderPlan;
}

export function validateBudget(
  budget: ParsedFrontmatter["budget"],
  agentName: string,
): void {
  if (!budget) return;
  const { maxIterations, maxTokens, maxWallSeconds, maxCostUsd } = budget;

  if (maxIterations !== undefined && maxIterations <= 0) {
    throw new LoadError(ERR_INVALID_BUDGET, `Agent "${agentName}": maxIterations must be positive`, { agent: agentName });
  }
  if (maxTokens !== undefined && maxTokens <= 0) {
    throw new LoadError(ERR_INVALID_BUDGET, `Agent "${agentName}": maxTokens must be positive`, { agent: agentName });
  }
  if (maxWallSeconds !== undefined && maxWallSeconds <= 0) {
    throw new LoadError(ERR_INVALID_BUDGET, `Agent "${agentName}": maxWallSeconds must be positive`, { agent: agentName });
  }
  if (maxCostUsd !== undefined && maxCostUsd !== null && maxCostUsd < 0) {
    throw new LoadError(ERR_INVALID_BUDGET, `Agent "${agentName}": maxCostUsd cannot be negative`, { agent: agentName });
  }
}

export function validateOutput(output: Record<string, unknown> | undefined, agentName: string): void {
  if (!output) return;
  if (typeof output !== "object" || output === null) {
    throw new LoadError(ERR_INVALID_OUTPUT, `Agent "${agentName}": output must be a valid JSON Schema object`, { agent: agentName });
  }
}

export function validateSubagents(
  subagents: string[] | undefined,
  agentName: string,
  allAgentNames: Set<string>,
): void {
  if (!subagents || subagents.length === 0) return;

  for (const sub of subagents) {
    if (sub === agentName) {
      throw new LoadError(
        ERR_SUBAGENT_SELF_REF,
        `Agent "${agentName}" lists itself as a subagent`,
        { agent: agentName },
      );
    }
    if (!allAgentNames.has(sub)) {
      throw new LoadError(
        ERR_SUBAGENT_NOT_FOUND,
        `Agent "${agentName}" references subagent "${sub}" which is not in the AgentSet`,
        { agent: agentName, subagent: sub },
      );
    }
  }
}

export function validateRunner(
  runner: string | undefined,
  runnerKeys: Set<string>,
  agentName: string,
): void {
  if (!runner || runner === "default") return;
  if (!runnerKeys.has(runner)) {
    throw new LoadError(
      ERR_RUNNER_NOT_FOUND,
      `Agent "${agentName}" references runner "${runner}" which was not found in runners/`,
      { agent: agentName, runner },
    );
  }
}
