import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "@render-agents/store";

export interface WebhookMatch {
  workflow: string;
  trigger: string;
}

export interface ConnectorContext {
  env(name: string): string | undefined;
  readonly logger: Logger;
}

export interface ConnectorSpec {
  readonly key: string;
  readonly name: string;
  handle(req: Request, ctx: ConnectorContext): Promise<WebhookMatch | null>;
}

function isConnectorSpec(v: unknown): v is ConnectorSpec {
  return typeof v === "object" && v !== null
    && typeof (v as ConnectorSpec).key === "string"
    && typeof (v as ConnectorSpec).handle === "function";
}

/**
 * Discover package-contributed connectors from `tools/<dir>/index.{js,ts}` —
 * each tool module may add a named `connectors` export (a `ConnectorSpec` or an
 * array). They mount at `POST /connectors/:key`, sharing dispatch with webhooks
 * but in a separate namespace (key collisions error).
 */
export async function loadConnectors(dir: string): Promise<Map<string, ConnectorSpec>> {
  const root = join(dir, "tools");
  const out = new Map<string, ConnectorSpec>();
  let subdirs: string[];
  try {
    subdirs = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of subdirs.sort()) {
    const entry = await resolveToolIndex(join(root, name));
    if (!entry) continue;
    const mod = (await import(pathToFileURL(entry).href)) as { connectors?: unknown };
    const exported = mod.connectors;
    if (!exported) continue;
    for (const spec of Array.isArray(exported) ? exported : [exported]) {
      if (!isConnectorSpec(spec)) {
        throw new Error(`tools/${name}: \`connectors\` export is not a ConnectorSpec ({ key, name, handle })`);
      }
      if (out.has(spec.key)) {
        throw new Error(`Connector key collision: "${spec.key}" is contributed by more than one tool package`);
      }
      out.set(spec.key, spec);
    }
  }
  return out;
}

async function resolveToolIndex(dir: string): Promise<string | undefined> {
  for (const candidate of ["index.js", "index.mjs", "index.ts"]) {
    const p = join(dir, candidate);
    try {
      await stat(p);
      return p;
    } catch {
      // next
    }
  }
  return undefined;
}
