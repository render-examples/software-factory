/**
 * agentTask() — the bridge between pure Agent config and a Render task.
 *
 * Takes an AgentDef (pure data) and returns a function compatible with
 * Render's task() registration. The function resolves all dependencies
 * from the environment at execution time: model client, store, tools.
 *
 * A lazily-initialized shared runtime avoids re-creating expensive resources
 * (Postgres connections, model clients) on every task execution within the
 * same long-lived Render Workflows process.
 */
import type { AgentDefinition, AgentInput, AgentOutput, ModelClient, ToolSource } from "@render-factory/engine";
import { resolveModelSpec, resolveClient } from "@render-factory/engine";
import { task } from "@renderinc/sdk/workflows";
import type { AgentDef } from "./agent.js";
import { isSetupTool, getSetupSpec, toolSpecToSource } from "./agent.js";
import type { AgentRuntime } from "./runtime.js";
import { createRuntime } from "./runtime.js";
import { runAgentInProcess } from "./run-in-process.js";

// ---------------------------------------------------------------------------
// Lazy shared runtime — created once per process, reused across task runs
// ---------------------------------------------------------------------------

let _runtime: AgentRuntime | undefined;
let _runtimePromise: Promise<AgentRuntime> | undefined;

async function getSharedRuntime(): Promise<AgentRuntime> {
  if (_runtime) return _runtime;
  if (_runtimePromise) return _runtimePromise;

  _runtimePromise = (async () => {
    const tenantId = process.env.TENANT_ID ?? "default";
    const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
    const model = resolveClient(spec);

    const runtime = await createRuntime({
      tenantId,
      model,
      hooks: [],
    });
    _runtime = runtime;
    return runtime;
  })();

  return _runtimePromise;
}

/** @internal Reset for tests. */
export function _resetSharedRuntime(): void {
  _runtime = undefined;
  _runtimePromise = undefined;
}

/** @internal Inject a runtime for tests. */
export function _setSharedRuntime(runtime: AgentRuntime): void {
  _runtime = runtime;
  _runtimePromise = undefined;
}

// ---------------------------------------------------------------------------
// agentTask() — the sole bridge function
// ---------------------------------------------------------------------------

/**
 * Turn an Agent config into a Render Workflows task.
 *
 * ```ts
 * const researcher = Agent({ id: "researcher", prompt: md`...`, tools: [sandbox] });
 * const researchTask = agentTask(researcher);
 * ```
 *
 * The returned value can be used with `ctx.run()` inside a Render workflow,
 * or triggered externally via `render.workflows.startTask()`.
 */
export function agentTask(agent: AgentDef): ReturnType<typeof task> {
  return task(
    { name: agent.id, plan: agent.spec.plan },
    async function agentTaskFn(input: AgentInput): Promise<AgentOutput> {
      const runtime = await getSharedRuntime();

      const engineDef = lowerToEngine(agent, runtime.model);
      runtime.agentDefinitions.set(agent.id, engineDef);

      materializeTools(agent, runtime);

      return runAgentInProcess(engineDef, input, {
        store: runtime.store,
        tracer: runtime.tracer,
        runners: runtime.runners,
        contextManager: runtime.contextManager,
        cancelStore: runtime.cancelStore,
        toolSources: runtime.toolSources,
        getDefinition: (name) => runtime.agentDefinitions.get(name),
        childDispatcher: runtime.dispatcher,
        delegation: runtime.delegation,
        oauthStore: runtime.oauthStore,
        oauthRefreshers: runtime.oauthRefreshers,
        deltaBus: runtime.deltaBus,
        suspender: runtime.suspender,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Lower AgentDef to engine AgentDefinition
// ---------------------------------------------------------------------------

function lowerToEngine(agent: AgentDef, defaultModel: ModelClient): AgentDefinition {
  const spec = agent.spec;
  const modelInput = spec.model ?? "medium";
  const { spec: modelSpec } = resolveModelSpec(modelInput, spec.provider);

  const toolIds = (spec.tools ?? []).map((t) => t.id);
  const subagentIds = (spec.subagents ?? []).map((s) => s.id);
  const approvalToolIds = (spec.requireApproval ?? []).map((t) => t.id);

  let outputSchema: Record<string, unknown> | undefined;
  if (spec.output) {
    try {
      outputSchema = { type: "object" };
    } catch {
      outputSchema = { type: "object" };
    }
  }

  return {
    name: agent.id,
    description: spec.description,
    model: modelSpec,
    systemPrompt: spec.prompt,
    tools: toolIds,
    subagents: subagentIds.length > 0 ? subagentIds : undefined,
    sampling: spec.sampling,
    budget: spec.budget,
    permissions: approvalToolIds.length > 0 ? { requireApproval: approvalToolIds } : undefined,
    output: outputSchema,
    plan: spec.plan,
    interactive: spec.interactive,
  };
}

// ---------------------------------------------------------------------------
// Materialize setup tools into the shared runtime
// ---------------------------------------------------------------------------

function materializeTools(agent: AgentDef, runtime: AgentRuntime): void {
  for (const source of agent.spec.tools ?? []) {
    if (runtime.toolSources.has(source.id)) continue;

    if (isSetupTool(source)) {
      const setupSpec = getSetupSpec(source as Parameters<typeof getSetupSpec>[0]);
      const resolved = setupSpec.setup({
        env: (name) => process.env[name],
        store: runtime.store,
        runtime,
      });
      runtime.toolSources.set(source.id, toolSpecToSource(resolved));
    } else {
      runtime.toolSources.set(source.id, source);
    }
  }
}
