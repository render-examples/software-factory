import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolSource, DefineToolSpec, Hook, AgentRunner } from "@render-factory/engine";
import { defineTool, defineToolSource } from "@render-factory/engine";
import type { AgentRuntime } from "../runtime.js";
import type { WorkflowDefinition } from "../workflow.js";
import type { Channel } from "../channel.js";
import { bindWorkflow } from "../workflow.js";

/**
 * Convention discovery + dynamic import for the code-bearing project
 * directories (`workflows/`, `channels/`, `tools/`). Unlike markdown agents,
 * these are TypeScript/JavaScript modules, so they must be `import()`ed.
 *
 * The entry resolver accepts both source (`.ts`, run via tsx/vitest) and built
 * (`.js`/`.mjs`) layouts so the same project runs in dev and production.
 */

const INDEX_CANDIDATES = ["index.js", "index.mjs", "index.ts"];
const FILE_EXTS = [".js", ".mjs", ".ts"];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function listModuleFiles(dir: string): Promise<Array<{ key: string; path: string }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: Array<{ key: string; path: string }> = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = FILE_EXTS.find((x) => e.name.endsWith(x));
      // Skip declaration/sourcemap files and non-modules.
      if (!ext || e.name.endsWith(".d.ts")) continue;
      out.push({ key: e.name.slice(0, -ext.length), path: join(dir, e.name) });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  } catch {
    return [];
  }
}

/** Resolve a directory's entry module (`index.{js,mjs,ts}`), preferring built output. */
async function resolveIndex(dir: string): Promise<string | undefined> {
  for (const candidate of INDEX_CANDIDATES) {
    const p = join(dir, candidate);
    if (await exists(p)) return p;
  }
  return undefined;
}

async function importDefault(path: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  return mod.default ?? mod;
}

function isWorkflowDefinition(v: unknown): v is WorkflowDefinition {
  return typeof v === "object" && v !== null && typeof (v as WorkflowDefinition).dispatch === "function";
}

function isChannel(v: unknown): v is Channel {
  return typeof v === "object" && v !== null
    && (v as Channel).target !== undefined
    && typeof (v as Channel).match === "function"
    && typeof (v as Channel).parse === "function";
}

function isToolSource(v: unknown): v is ToolSource {
  return typeof v === "object" && v !== null
    && typeof (v as ToolSource).id === "string"
    && typeof (v as ToolSource).resolve === "function";
}

/**
 * Discover and bind workflows from `workflows/<dir>/index.{js,ts}`. The key is
 * the directory name (the workflow name); each default-exported
 * `WorkflowDefinition` is bound to the runtime so `dispatch` is callable.
 */
export async function loadWorkflows(dir: string, runtime: AgentRuntime): Promise<Map<string, WorkflowDefinition>> {
  const root = join(dir, "workflows");
  const out = new Map<string, WorkflowDefinition>();
  for (const name of await listSubdirs(root)) {
    const entry = await resolveIndex(join(root, name));
    if (!entry) continue;
    const def = await importDefault(entry);
    if (!isWorkflowDefinition(def)) {
      throw new Error(`workflows/${name}: default export is not a workflow() definition`);
    }
    bindWorkflow(def, name, runtime);
    out.set(name, def);
  }
  return out;
}

/**
 * Discover channels from `channels/*.{js,ts}`. The key is the filename (the
 * channel id); each default-exported `Channel` is mounted by the gateway at
 * `POST /channels/:id`. A channel is the single inbound/outbound message
 * surface (it supersedes the old `webhooks/` + `connectors/` concepts); an
 * inbound-only channel simply omits `deliver`.
 */
export async function loadChannels(dir: string): Promise<Map<string, Channel>> {
  const root = join(dir, "channels");
  const out = new Map<string, Channel>();
  for (const { key, path } of await listModuleFiles(root)) {
    const channel = await importDefault(path);
    if (!isChannel(channel)) {
      throw new Error(`channels/${key}: default export is not a Channel ({ target, match, parse, deliver? })`);
    }
    out.set(key, channel);
  }
  return out;
}

/**
 * Discover tool sources from `tools/<dir>/index.{js,ts}`. The convention key is
 * the directory name (what agents reference). A module may default-export a
 * `ToolSource` (from `defineTool`/`defineMcpSource`/`defineToolSource`), a
 * single `DefineToolSpec`, or an array of specs (a multi-tool source).
 */
export async function loadToolSources(dir: string): Promise<Map<string, ToolSource>> {
  const root = join(dir, "tools");
  const out = new Map<string, ToolSource>();
  for (const name of await listSubdirs(root)) {
    const entry = await resolveIndex(join(root, name));
    if (!entry) continue;
    const exported = await importDefault(entry);
    out.set(name, coerceToolSource(name, exported));
  }
  return out;
}

function isHook(v: unknown): v is Hook {
  return typeof v === "object" && v !== null
    && typeof (v as Hook).name === "string"
    && Array.isArray((v as Hook).on)
    && typeof (v as Hook).handle === "function";
}

function isAgentRunner(v: unknown): v is AgentRunner {
  return typeof v === "object" && v !== null && typeof (v as AgentRunner).run === "function";
}

/**
 * Discover event hooks from `hooks/*.{js,ts}`. Each default-exported `Hook`
 * (`{ name, on, handle }`) is auto-applied to every run via `createRuntime({ hooks })`.
 */
export async function loadHooks(dir: string): Promise<Hook[]> {
  const root = join(dir, "hooks");
  const hooks: Hook[] = [];
  for (const { key, path } of await listModuleFiles(root)) {
    const exported = await importDefault(path);
    if (!isHook(exported)) {
      throw new Error(`hooks/${key}: default export is not a Hook ({ name, on, handle })`);
    }
    hooks.push(exported);
  }
  return hooks;
}

/**
 * Discover custom agent runners from `runners/*.{js,ts}`. The key (filename) is
 * the runner name agents reference via frontmatter `runner:`; each default
 * export must implement `AgentRunner`. Pass the result to
 * `createRuntime({ runners })` so `runner: <name>` resolves at run time.
 */
export async function loadRunners(dir: string): Promise<Map<string, AgentRunner>> {
  const root = join(dir, "runners");
  const out = new Map<string, AgentRunner>();
  for (const { key, path } of await listModuleFiles(root)) {
    const exported = await importDefault(path);
    if (!isAgentRunner(exported)) {
      throw new Error(`runners/${key}: default export is not an AgentRunner ({ run })`);
    }
    out.set(key, exported);
  }
  return out;
}

/**
 * Context passed to a tool source's optional `bind()` export after the full
 * project is assembled. Tool sources that need runtime state (e.g.
 * `start_workflow` needs the workflow map, `get_activity` needs the store)
 * export a `bind(ctx)` function instead of relying on manual late-binding in
 * every entrypoint.
 */
export interface ToolBindContext {
  runtime: AgentRuntime;
  workflows: Map<string, WorkflowDefinition>;
  channels: Map<string, Channel>;
}

/**
 * Call `bind(ctx)` on every tool source module that exports one. This replaces
 * manual `bindWorkflows()` / `bindStore()` / `bindActivityRuntime()` calls in
 * entrypoints. Safe to call on sources that don't export `bind` — they're
 * silently skipped.
 */
export async function lateBindToolSources(
  root: string,
  ctx: ToolBindContext,
): Promise<void> {
  const toolsDir = join(root, "tools");
  for (const name of await listSubdirs(toolsDir)) {
    const entry = await resolveIndex(join(toolsDir, name));
    if (!entry) continue;
    const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    if (typeof mod.bind === "function") {
      (mod.bind as (ctx: ToolBindContext) => void)(ctx);
    }
  }
}

function coerceToolSource(key: string, exported: unknown): ToolSource {
  if (isToolSource(exported)) return exported;
  if (Array.isArray(exported)) return defineToolSource(key, exported as DefineToolSpec[]);
  if (exported && typeof exported === "object" && typeof (exported as DefineToolSpec).invoke === "function") {
    return defineTool(exported as DefineToolSpec);
  }
  throw new Error(`tools/${key}: default export is not a tool source, DefineToolSpec, or spec array`);
}
