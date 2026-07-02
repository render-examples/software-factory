// One-call project loader. Every service entrypoint in the two-lane topology
// (gateway / chat worker / workflows host) otherwise repeats the same
// convention-discovery block: load the code-bearing directories, build the
// runtime, then bind agents/workflows/webhooks. `loadProject` is that block, so
// an entrypoint is just "load the project, then start my role".

import type { AgentRuntime, CreateRuntimeOptions } from "./runtime.js";
import { createRuntime } from "./runtime.js";
import type { AgentSet } from "./agents.js";
import { loadAgents } from "./agents.js";
import type { WorkflowDefinition, WebhookAdapter } from "./workflow.js";
import { loadToolSources, loadRunners, loadHooks, loadWorkflows, loadWebhooks } from "./loader/load-project.js";

/** Runtime options `loadProject` derives from the project itself (callers can't double-set them). */
type DerivedRuntimeOptions = "toolSources" | "extraRunners" | "hooks";

export interface LoadProjectOptions {
  /**
   * Extra options forwarded to `createRuntime`, merged over the ones
   * `loadProject` derives from the project (`toolSources`, `extraRunners`,
   * `hooks`). Use it for the overrides a host/test needs — e.g. a mock `model`,
   * an explicit `store`, or `autoDetectDispatcher: false`.
   */
  runtime?: Omit<CreateRuntimeOptions, DerivedRuntimeOptions>;
}

export interface LoadedProject {
  /** The composition root (D5): store, model, dispatcher, hooks, tool sources — auto-detected from the environment. */
  runtime: AgentRuntime;
  /** Agents discovered from `agents/*.md`, bound to the runtime. */
  agents: AgentSet;
  /** Workflows discovered from `workflows/<name>/index.ts`, bound to the runtime. */
  workflows: Map<string, WorkflowDefinition>;
  /** Webhook adapters discovered from `webhooks/*.ts` (the gateway mounts them at `POST /webhooks/:name`). */
  webhooks: Map<string, WebhookAdapter>;
}

/**
 * Discover and wire a project rooted at `root` (the directory holding the
 * convention dirs: `agents/`, `tools/`, `workflows/`, `webhooks/`, `hooks/`,
 * `runners/`). It loads the code-bearing sources (`tools/`, `runners/`,
 * `hooks/`), builds the runtime via `createRuntime` (which auto-detects the
 * store, model client, and dispatcher from the environment), then binds
 * `agents/`, `workflows/`, and `webhooks/` to it.
 *
 * Loading is uniform across services (a worker also imports/validates the
 * workflows + webhooks it doesn't itself serve) — cheap, and it fails fast on a
 * malformed module in any service rather than only in the gateway.
 *
 * `connectors/` is intentionally NOT loaded here: connectors live in
 * `@render-agents/gateway` and the SDK must not depend on the gateway. The
 * gateway entrypoint calls `loadConnectors(root)` alongside this.
 */
export async function loadProject(root: string, opts?: LoadProjectOptions): Promise<LoadedProject> {
  const [toolSources, extraRunners, hooks] = await Promise.all([
    loadToolSources(root),
    loadRunners(root),
    loadHooks(root),
  ]);
  const runtime = await createRuntime({ ...opts?.runtime, toolSources, extraRunners, hooks });
  const agents = await loadAgents(root, runtime);
  const [workflows, webhooks] = await Promise.all([loadWorkflows(root, runtime), loadWebhooks(root)]);
  return { runtime, agents, workflows, webhooks };
}
