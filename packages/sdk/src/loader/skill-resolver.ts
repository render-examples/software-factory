import { parse as parseYaml } from "yaml";
import type { SkillMetadata } from "@render-agents/engine";
import type { DiscoveredItem } from "./discovery.js";
import { readTextFile } from "./discovery.js";
import { LoadError, ERR_SKILL_NOT_FOUND } from "./errors.js";

export interface SkillRegistryData {
  skills: Map<string, SkillMetadata>;
}

export async function loadSkillRegistry(items: DiscoveredItem[]): Promise<SkillRegistryData> {
  const skills = new Map<string, SkillMetadata>();

  for (const item of items) {
    const content = await readTextFile(item.path);
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

    let frontmatter: Record<string, unknown> = {};
    let body = content.trim();

    if (match) {
      frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
      body = match[2].trim();
    }

    const metadata: SkillMetadata = {
      id: item.key,
      name: (frontmatter["name"] as string) ?? item.key,
      description: (frontmatter["description"] as string) ?? "",
      whenToUse: (frontmatter["whenToUse"] as string) ?? "",
      content: body,
    };

    skills.set(item.key, metadata);
  }

  return { skills };
}

export function resolveSkills(
  skillIds: string[] | undefined,
  registry: SkillRegistryData,
  agentName: string,
): SkillMetadata[] {
  if (!skillIds || skillIds.length === 0) return [];

  return skillIds.map(id => {
    const skill = registry.skills.get(id);
    if (!skill) {
      throw new LoadError(
        ERR_SKILL_NOT_FOUND,
        `Agent "${agentName}" references skill "${id}" which was not found in skills/`,
        { agent: agentName, skill: id },
      );
    }
    return skill;
  });
}
