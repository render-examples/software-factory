import type { DiscoveredItem } from "./discovery.js";
import { LoadError, ERR_TOOL_NOT_FOUND, ERR_APPROVAL_NOT_IN_TOOLS, ERR_RESERVED_TOOL_NAME } from "./errors.js";

const RESERVED_TOOL_NAMES = new Set(["load_skill"]);

export interface ToolRegistryData {
  sourceIds: Set<string>;
}

export function buildToolRegistry(items: DiscoveredItem[]): ToolRegistryData {
  const sourceIds = new Set<string>();

  for (const item of items) {
    if (RESERVED_TOOL_NAMES.has(item.key)) {
      throw new LoadError(
        ERR_RESERVED_TOOL_NAME,
        `Tool source "${item.key}" resolves to a reserved model-facing name`,
        { sourceId: item.key },
      );
    }
    sourceIds.add(item.key);
  }

  return { sourceIds };
}

export function resolveToolReferences(
  toolRefs: string[],
  registry: ToolRegistryData,
  agentName: string,
): string[] {
  const expandedNames: string[] = [];

  for (const ref of toolRefs) {
    if (ref.includes("__")) {
      const [sourceId] = ref.split("__");
      if (!registry.sourceIds.has(sourceId)) {
        throw new LoadError(
          ERR_TOOL_NOT_FOUND,
          `Agent "${agentName}" references tool "${ref}" but source "${sourceId}" was not found in tools/`,
          { agent: agentName, ref, sourceId },
        );
      }
      expandedNames.push(ref);
    } else {
      if (!registry.sourceIds.has(ref)) {
        throw new LoadError(
          ERR_TOOL_NOT_FOUND,
          `Agent "${agentName}" references tool source "${ref}" which was not found in tools/`,
          { agent: agentName, ref },
        );
      }
      expandedNames.push(ref);
    }
  }

  return expandedNames;
}

export function validateApprovalRefs(
  requireApproval: string[] | undefined,
  expandedTools: string[],
  agentName: string,
): void {
  if (!requireApproval || requireApproval.length === 0) return;

  const toolSet = new Set(expandedTools);
  for (const name of requireApproval) {
    if (approvalRefMatches(name, toolSet)) continue;
    throw new LoadError(
      ERR_APPROVAL_NOT_IN_TOOLS,
      `Agent "${agentName}" has requireApproval for "${name}" which is not in its tool set`,
      { agent: agentName, approval: name, tools: expandedTools },
    );
  }
}

/**
 * An approval ref is valid against an agent's tool references when it matches a
 * whole source, an explicitly-referenced expanded tool, OR a specific tool of a
 * whole-source mount (e.g. `requireApproval: [github__create_issue]` with
 * `tools: [github]`). Conversely, gating a whole source (`github`) is valid when
 * the agent referenced specific tools of that source (`github__create_issue`).
 */
function approvalRefMatches(name: string, toolSet: Set<string>): boolean {
  if (toolSet.has(name)) return true;
  if (name.includes("__")) {
    const sourcePrefix = name.slice(0, name.indexOf("__"));
    return toolSet.has(sourcePrefix);
  }
  // `name` is a source id — match if any referenced tool belongs to that source.
  for (const ref of toolSet) {
    if (ref.startsWith(`${name}__`)) return true;
  }
  return false;
}
