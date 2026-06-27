import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "@render-agents/engine";
import { resolveModelSpec } from "@render-agents/engine";
import type { AgentSet } from "../agents.js";
import { discoverDirectory, readTextFile } from "./discovery.js";
import { parseAgentMarkdown, type ParsedFrontmatter } from "./frontmatter.js";
import { mergeFrontmatter, mergeBody } from "./shared-merge.js";
import { buildToolRegistry, resolveToolReferences, validateApprovalRefs } from "./tool-resolver.js";
import { loadSkillRegistry, resolveSkills } from "./skill-resolver.js";
import { validatePlan, validateBudget, validateOutput, validateSubagents, validateRunner } from "./validate.js";
import { LoadError, ERR_LIKELY_AGENTS_DIR } from "./errors.js";

/** Common top-level markdown files that are not agents — ignored by the misuse guard. */
const ROOT_MARKDOWN_DENYLIST = new Set([
  "readme",
  "changelog",
  "contributing",
  "license",
  "code_of_conduct",
  "security",
]);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `dir` is the **project root** (the directory that contains `agents/`,
 * `tools/`, `skills/`, …) — not the `agents/` folder itself.
 */
export async function loadAgentsFromDir(dir: string): Promise<AgentSet> {
  const agentsDir = join(dir, "agents");
  const toolsDir = join(dir, "tools");
  const skillsDir = join(dir, "skills");
  const runnersDir = join(dir, "runners");

  const toolItems = await discoverDirectory(toolsDir, { pattern: "ts-index" });
  const skillItems = await discoverDirectory(skillsDir, { pattern: "skill" });
  const runnerItems = await discoverDirectory(runnersDir, { pattern: "ts-file" });

  const toolRegistry = buildToolRegistry(toolItems);
  const skillRegistry = await loadSkillRegistry(skillItems);
  const runnerKeys = new Set(runnerItems.map(i => i.key));

  const agentItems = await discoverDirectory(agentsDir, { pattern: "md", skip: ["_shared.md"] });

  // Robustness guard: catch the most common misuse — passing the `agents/`
  // folder instead of the project root. If there's no `agents/` subdir but
  // `dir` itself directly holds agent-looking markdown (a `_shared.md`, or a
  // `.md` that isn't a common root doc like README), it's almost certainly the
  // agents folder. Fail loudly instead of returning a silent empty AgentSet.
  if (agentItems.length === 0 && !(await isDirectory(agentsDir))) {
    const directMd = await discoverDirectory(dir, { pattern: "md" });
    const looksLikeAgentsDir = directMd.some(
      i => i.key === "_shared" || !ROOT_MARKDOWN_DENYLIST.has(i.key.toLowerCase()),
    );
    if (looksLikeAgentsDir) {
      throw new LoadError(
        ERR_LIKELY_AGENTS_DIR,
        `No "agents/" directory found under "${dir}", but it contains agent-looking markdown directly. ` +
          `loadAgents() expects the project root (the directory that contains agents/, tools/, skills/, …), ` +
          `not the agents/ folder itself. Pass the parent directory instead.`,
        { dir },
      );
    }
  }

  let sharedFrontmatter: ParsedFrontmatter | undefined;
  let sharedBody = "";
  try {
    const sharedContent = await readTextFile(join(agentsDir, "_shared.md"));
    const sharedParsed = parseAgentMarkdown(sharedContent, "_shared.md");
    sharedFrontmatter = sharedParsed.frontmatter;
    sharedBody = sharedParsed.body;
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      // _shared.md not present — optional
    } else if (e instanceof Error && e.name === "LoadError") {
      throw e;
    } else if (e instanceof Error && "code" in e) {
      // Other fs error, skip
    } else {
      throw e;
    }
  }

  const definitions: AgentDefinition[] = [];
  const agentNames = new Set<string>();

  for (const item of agentItems) {
    agentNames.add(item.key);
  }

  for (const item of agentItems) {
    const content = await readTextFile(item.path);
    const parsed = parseAgentMarkdown(content, item.key);

    const frontmatter = sharedFrontmatter
      ? mergeFrontmatter(sharedFrontmatter, parsed.frontmatter)
      : parsed.frontmatter;
    const body = mergeBody(sharedBody, parsed.body);

    const { spec: modelSpec } = resolveModelSpec(
      frontmatter.model,
      frontmatter.provider,
    );

    const plan = validatePlan(frontmatter.plan, item.key);
    validateBudget(frontmatter.budget, item.key);
    validateOutput(frontmatter.output, item.key);
    validateRunner(frontmatter.runner, runnerKeys, item.key);

    const expandedTools = resolveToolReferences(
      frontmatter.tools ?? [],
      toolRegistry,
      item.key,
    );

    validateApprovalRefs(
      frontmatter.permissions?.requireApproval,
      expandedTools,
      item.key,
    );

    const resolvedSkills = resolveSkills(
      frontmatter.skills,
      skillRegistry,
      item.key,
    );

    const definition: AgentDefinition = {
      name: item.key,
      description: frontmatter.description,
      model: modelSpec,
      systemPrompt: body,
      tools: frontmatter.tools ?? [],
      subagents: frontmatter.subagents,
      skills: resolvedSkills.length > 0 ? resolvedSkills : undefined,
      sampling: frontmatter.sampling,
      budget: frontmatter.budget,
      permissions: frontmatter.permissions,
      output: frontmatter.output,
      context: frontmatter.context,
      plan,
      runner: frontmatter.runner,
    };

    definitions.push(definition);
  }

  for (const def of definitions) {
    validateSubagents(def.subagents, def.name, agentNames);
  }

  return createInertAgentSet(definitions);
}

function createInertAgentSet(definitions: AgentDefinition[]): AgentSet {
  const byName = new Map<string, AgentDefinition>();
  for (const def of definitions) {
    byName.set(def.name, def);
  }

  return {
    get(id: string | string[]): never {
      if (Array.isArray(id)) {
        return id.map(name => {
          const def = byName.get(name);
          if (!def) throw new Error(`Agent "${name}" not found`);
          return { name, definition: def, run: notBound, task: notBound };
        }) as never;
      }
      const def = byName.get(id);
      if (!def) throw new Error(`Agent "${id}" not found`);
      return { name: id, definition: def, run: notBound, task: notBound } as never;
    },
    has(id: string): boolean {
      return byName.has(id);
    },
    all(): never {
      return [...byName.entries()].map(([name, definition]) => ({
        name,
        definition,
        run: notBound,
        task: notBound,
      })) as never;
    },
  };
}

function notBound(): never {
  throw new Error("Agent not bound to a runtime. Call loadAgents(dir, runtime) with a runtime to enable run/task.");
}
