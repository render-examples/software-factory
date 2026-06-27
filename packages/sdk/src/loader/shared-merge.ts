import type { ParsedFrontmatter } from "./frontmatter.js";

/**
 * Deep-merge shared frontmatter into agent frontmatter.
 * - Nested objects (budget, permissions, sampling, context): deep-merge per leaf, agent wins
 * - Arrays (tools, skills, requireApproval): union + dedupe
 * - Scalars (model, plan, runner, description, provider): agent wins, then shared
 */
export function mergeFrontmatter(
  shared: ParsedFrontmatter,
  agent: ParsedFrontmatter,
): ParsedFrontmatter {
  return {
    model: agent.model ?? shared.model,
    provider: agent.provider ?? shared.provider,
    description: agent.description ?? shared.description,
    tools: unionDedupe(shared.tools ?? [], agent.tools ?? []),
    subagents: agent.subagents ?? shared.subagents,
    skills: unionDedupe(shared.skills ?? [], agent.skills ?? []),
    permissions: mergePermissions(shared.permissions, agent.permissions),
    output: agent.output ?? shared.output,
    context: mergeObject(shared.context, agent.context),
    budget: mergeObject(shared.budget, agent.budget),
    plan: agent.plan ?? shared.plan,
    sampling: mergeObject(shared.sampling, agent.sampling),
    runner: agent.runner ?? shared.runner,
  };
}

export function mergeBody(sharedBody: string, agentBody: string): string {
  if (!sharedBody) return agentBody;
  return `${sharedBody}\n\n${agentBody}`;
}

function unionDedupe(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function mergePermissions(
  shared?: { requireApproval?: string[] },
  agent?: { requireApproval?: string[] },
): { requireApproval?: string[] } | undefined {
  if (!shared && !agent) return undefined;
  const sharedApproval = shared?.requireApproval ?? [];
  const agentApproval = agent?.requireApproval ?? [];
  const merged = unionDedupe(sharedApproval, agentApproval);
  return merged.length > 0 ? { requireApproval: merged } : undefined;
}

function mergeObject<T extends Record<string, unknown>>(
  shared?: T,
  agent?: T,
): T | undefined {
  if (!shared && !agent) return undefined;
  if (!shared) return agent;
  if (!agent) return shared;
  return { ...shared, ...agent };
}
