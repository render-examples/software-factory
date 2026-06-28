import { randomUUID } from "node:crypto";
import type { RunStore, Tracer, CancelStore, Logger } from "@render-agents/store";
import { idempotencyKey } from "@render-agents/store";
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  ContextManager,
  DelegationLimits,
  ToolSource,
} from "@render-agents/engine";
import { InProcessRunContext, buildSubagentToolSource } from "@render-agents/engine";
import type { RunnerRegistry, TaskDispatcher } from "./runtime.js";

const inProcessLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => console.warn(msg, meta ?? ""),
  error: (msg, meta) => console.error(msg, meta ?? ""),
};

export interface RunInProcessDeps {
  store: RunStore;
  tracer: Tracer;
  runners: RunnerRegistry;
  contextManager: ContextManager;
  cancelStore: CancelStore;
  toolSources: Map<string, ToolSource>;
  getDefinition: (name: string) => AgentDefinition | undefined;
  /** Dispatcher used for any subagent child runs (depth/idempotency propagation). */
  childDispatcher: TaskDispatcher;
  delegation?: Partial<DelegationLimits>;
}

export interface RunInProcessOptions {
  runId?: string;
  parentSpanId?: string;
  userId?: string;
  depth?: number;
  signal?: AbortSignal;
  approvedToolCallIds?: ReadonlySet<string>;
}

/**
 * Run an agent definition in the current process, wiring cooperative
 * cancellation, the resolved tool sources, and — when the agent declares
 * subagents — a `subagents__<name>` delegation tool source. The subagent
 * dispatcher emits `subagent.spawned` on the parent run and routes child runs
 * through the provided dispatcher so depth/fanout limits and idempotency hold.
 *
 * Shared by `agent.run()`, `agent.task()` (in-process), the InProcessDispatcher,
 * and the Render Workflows task handler so they behave identically.
 */
export function runAgentInProcess<T = unknown>(
  definition: AgentDefinition,
  input: AgentInput,
  deps: RunInProcessDeps,
  opts?: RunInProcessOptions,
): Promise<AgentOutput<T>> {
  const runId = opts?.runId ?? randomUUID();
  const depth = opts?.depth ?? 0;
  const parentAgentSpanId = idempotencyKey(runId, `agent-span:${definition.name}`);

  // Shared map (same reference held by the ctx) so the subagent source can be
  // registered after the ctx is constructed and still be visible at mount time.
  const toolSources = new Map(deps.toolSources);

  const ctx = new InProcessRunContext({
    runId,
    store: deps.store,
    tracer: deps.tracer,
    model: definition.model,
    agentName: definition.name,
    contextManager: deps.contextManager,
    signal: opts?.signal ?? new AbortController().signal,
    parentSpanId: opts?.parentSpanId,
    userId: opts?.userId,
    depth,
    maxContextTokens: definition.context?.maxContextTokens,
    toolSources,
    cancelStore: deps.cancelStore,
    approvedToolCallIds: opts?.approvedToolCallIds,
  });

  if (definition.subagents && definition.subagents.length > 0) {
    let fanout = 0;
    const subagentDefs = definition.subagents
      .map((name) => {
        const def = deps.getDefinition(name);
        return def ? { name, description: def.description, definition: def } : undefined;
      })
      .filter((x): x is { name: string; description: string | undefined; definition: AgentDefinition } => x !== undefined);

    if (subagentDefs.length > 0) {
      const source = buildSubagentToolSource(subagentDefs, {
        currentDepth: depth,
        parentSpanId: parentAgentSpanId,
        userId: opts?.userId,
        logger: inProcessLogger,
        limits: deps.delegation,
        getFanoutCount: async () => fanout,
        dispatcher: {
          async dispatch(agentName, childInput, dOpts) {
            fanout += 1;
            const childRunId = idempotencyKey(runId, `subagent:${dOpts.toolCallId}`);
            await ctx.emit({
              type: "subagent.spawned",
              agentName,
              childRunId,
              toolCallId: dOpts.toolCallId,
            });
            return deps.childDispatcher.dispatch(agentName, childInput as AgentInput, {
              runId: childRunId,
              parentSpanId: dOpts.parentSpanId,
              userId: dOpts.userId,
              depth: dOpts.depth,
              idempotencyKey: childRunId,
              plan: deps.getDefinition(agentName)?.plan,
              signal: opts?.signal,
            });
          },
        },
      });
      toolSources.set("subagents", source);
    }
  }

  const runner = deps.runners.get(definition.runner ?? "default");
  return runner.run(definition, input, ctx) as Promise<AgentOutput<T>>;
}
