import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { LoadError, ERR_DUPLICATE_KEY } from "./errors.js";

export interface DiscoveredItem {
  key: string;
  path: string;
}

export async function discoverDirectory(
  dir: string,
  opts: {
    pattern: "md" | "ts-index" | "ts-file" | "skill";
    skip?: string[];
  },
): Promise<DiscoveredItem[]> {
  try {
    await stat(dir);
  } catch {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const items: DiscoveredItem[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    let key: string | undefined;
    let itemPath: string | undefined;

    switch (opts.pattern) {
      case "md": {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (opts.skip?.includes(entry.name)) continue;
        key = basename(entry.name, ".md");
        itemPath = join(dir, entry.name);
        break;
      }
      case "ts-index": {
        if (!entry.isDirectory()) continue;
        const indexPath = join(dir, entry.name, "index.ts");
        try {
          await stat(indexPath);
          key = entry.name;
          itemPath = indexPath;
        } catch {
          continue;
        }
        break;
      }
      case "ts-file": {
        if (!entry.isFile()) continue;
        const ext = extname(entry.name);
        if (ext !== ".ts") continue;
        key = basename(entry.name, ext);
        itemPath = join(dir, entry.name);
        break;
      }
      case "skill": {
        if (!entry.isDirectory()) continue;
        const skillPath = join(dir, entry.name, "SKILL.md");
        try {
          await stat(skillPath);
          key = entry.name;
          itemPath = skillPath;
        } catch {
          continue;
        }
        break;
      }
    }

    if (!key || !itemPath) continue;

    const existingPath = seen.get(key);
    if (existingPath !== undefined) {
      throw new LoadError(
        ERR_DUPLICATE_KEY,
        `Duplicate key "${key}" in ${dir}: "${existingPath}" and "${itemPath}"`,
        { key, dir, paths: [existingPath, itemPath] },
      );
    }
    seen.set(key, itemPath);
    items.push({ key, path: itemPath });
  }

  return items;
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}
