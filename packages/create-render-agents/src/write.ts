import { mkdir, writeFile, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ScaffoldOptions } from "./blueprint.js";
import { buildFileMap } from "./blueprint.js";

export interface WriteResult {
  targetDir: string;
  files: string[];
}

/**
 * Materialize the blueprint to disk under `targetDir`. Refuses to write into a
 * non-empty directory unless `force` is set.
 */
export async function writeProject(targetDir: string, opts: ScaffoldOptions, force = false): Promise<WriteResult> {
  if (!force && (await isNonEmptyDir(targetDir))) {
    throw new Error(`Target directory "${targetDir}" is not empty. Use --force to overwrite.`);
  }
  const fileMap = buildFileMap(opts);
  const base = resolve(targetDir);
  const written: string[] = [];
  for (const [rel, contents] of fileMap) {
    const abs = resolve(base, rel);
    // Defense in depth: never let a blueprint key escape the project dir (CR-27).
    if (abs !== base && !abs.startsWith(base + sep)) {
      throw new Error(`Refusing to write outside the project directory: "${rel}"`);
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
    written.push(rel);
  }
  return { targetDir, files: written.sort() };
}

async function isNonEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false; // missing dir → fine to create
  }
}
