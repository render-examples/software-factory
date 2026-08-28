import { join } from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { resolveClient, resolveModelSpec } from "@render-factory/engine";
import type { AgentRuntime } from "./runtime.js";
import type { AgentSet } from "./agents.js";
import type { WorkflowDefinition } from "./workflow.js";
import type { Channel } from "./channel.js";
import { loadProject, type LoadProjectOptions } from "./project.js";
import { lateBindToolSources } from "./loader/load-project.js";

const FactoryConfigSchema = z.object({
  repos: z.array(z.string()).optional(),
});

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

export interface BootFactoryResult {
  runtime: AgentRuntime;
  agents: AgentSet;
  workflows: Map<string, WorkflowDefinition>;
  channels: Map<string, Channel>;
  config: FactoryConfig;
}

const CONFIG_CANDIDATES = ["factory.config.ts", "factory.config.js", "factory.config.mjs"];

async function loadFactoryConfig(root: string): Promise<FactoryConfig> {
  for (const filename of CONFIG_CANDIDATES) {
    const configPath = join(root, filename);
    try {
      await stat(configPath);
    } catch {
      continue;
    }
    const mod = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
    const raw = mod.default ?? {};
    const result = FactoryConfigSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`${filename}: invalid factory config — ${issues}`);
    }
    return result.data;
  }
  return {};
}

/**
 * Match a repo string ("owner/repo") against a list of glob patterns.
 * Supports `*` as a wildcard for a single path segment.
 */
export function matchesRepoAllowlist(repo: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]+") + "$",
    );
    return regex.test(repo);
  });
}

/**
 * `defineFactory` is a typed identity function for factory config authoring.
 * It provides autocomplete and validation in `factory.config.ts`.
 */
export function defineFactory(config: FactoryConfig): FactoryConfig {
  return config;
}

/**
 * Load and wire the full factory from a project root. Discovers agents, tools,
 * workflows, channels, hooks, and runners by convention, builds the runtime,
 * late-binds tool sources, and loads the factory config.
 *
 * Replaces the 80-line explicit-import entrypoints with a single call:
 *
 * ```ts
 * const { runtime, workflows, channels } = await bootFactory(root);
 * ```
 */
export async function bootFactory(
  root: string,
  overrides?: Omit<LoadProjectOptions, "tenantId" | "model"> & {
    tenantId?: string;
    model?: import("@render-factory/engine").ModelClient;
  },
): Promise<BootFactoryResult> {
  const config = await loadFactoryConfig(root);

  const tenantId = overrides?.tenantId ?? process.env.TENANT_ID ?? "default";
  const model = overrides?.model ?? (() => {
    const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
    return resolveClient(spec);
  })();

  const { runtime, agents, workflows, channels } = await loadProject(root, {
    tenantId,
    model,
    runtime: overrides?.runtime,
  });

  await lateBindToolSources(root, { runtime, workflows, channels });

  return { runtime, agents, workflows, channels, config };
}
