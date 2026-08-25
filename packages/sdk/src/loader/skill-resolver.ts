import { parse as parseYaml } from "yaml";
import type { SkillMetadata } from "@render-factory/engine";
import type { DiscoveredItem } from "./discovery.js";
import { readTextFile } from "./discovery.js";
import { LoadError, ERR_SKILL_NOT_FOUND } from "./errors.js";

export interface SkillRegistryData {
  skills: Map<string, SkillMetadata>;
}

/** Coerce a frontmatter value to a string, ignoring non-string YAML values
 *  (e.g. a numeric `name:`) rather than mis-casting them (CR-13). */
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

const MAX_FRONTMATTER_BYTES = 64 * 1024;

export async function loadSkillRegistry(items: DiscoveredItem[]): Promise<SkillRegistryData> {
  const skills = new Map<string, SkillMetadata>();

  for (const item of items) {
    // Normalize CRLF so Windows-authored skills parse frontmatter identically (CR-13).
    const content = (await readTextFile(item.path)).replace(/\r\n/g, "\n");
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

    let frontmatter: Record<string, unknown> = {};
    let body = content.trim();

    if (match && match[1].length <= MAX_FRONTMATTER_BYTES) {
      frontmatter = (parseYaml(match[1]) as Record<string, unknown>) ?? {};
      body = match[2].trim();
    } else if (match) {
      // Oversized frontmatter — skip parsing it, keep the body after the fence.
      body = match[2].trim();
    }

    const metadata: SkillMetadata = {
      id: item.key,
      name: asString(frontmatter["name"], item.key),
      description: asString(frontmatter["description"], ""),
      whenToUse: asString(frontmatter["whenToUse"], ""),
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
