/**
 * Graph-based factory boot. Takes an immutable `FactoryDef`, traverses
 * the reachable dependency graph (workflows -> agents -> tools/subagents),
 * validates the composition, and materializes a process-local runtime.
 *
 * No filesystem discovery, Markdown parsing, generated manifests, or
 * module-level mutation.
 */

import type { AgentDefinition, ModelClient, ToolSource, Hook, AgentRunner, ModelPricing } from "@render-factory/engine";
import { resolveModelSpec, resolveClient } from "@render-factory/engine";
import type { AgentRuntime, CreateRuntimeOptions } from "./runtime.js";
import { createRuntime } from "./runtime.js";
import type { AgentSet, Agent } from "./agents.js";
import type { WorkflowDefinition as LegacyWorkflowDef } from "./workflow.js";
import { workflow as legacyWorkflow, bindWorkflow } from "./workflow.js";
import type { Channel } from "./channel.js";
import type {
  FactoryDef,
  AgentDef,
  WorkflowDef,
  ChannelDef,
  FactorySpec,
  WorkflowTaskContext,
  TaskResult,
} from "./define.js";
import { isAgentDef, isWorkflowDef, isChannelDef } from "./define.js";

// ---------------------------------------------------------------------------
// BootedFactory — the process-local materialized factory
// ---------------------------------------------------------------------------

export interface BootedFactory {
  readonly runtime: AgentRuntime;
  readonly agents: AgentSet;
  readonly workflows: Map<string, LegacyWorkflowDef>;
  readonly channels: Map<string, Channel>;
  readonly config: FactorySpec["config"];
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Boot overrides
// ---------------------------------------------------------------------------

export interface BootFactoryOverrides {
  tenantId?: string;
  model?: ModelClient;
  pricing?: Record<string, ModelPricing>;
  runtime?: Omit<CreateRuntimeOptions, "tenantId" | "model" | "toolSources" | "hooks">;
}

// ---------------------------------------------------------------------------
// bootFactory
// ---------------------------------------------------------------------------

export async function bootFactory(
  factory: FactoryDef,
  overrides?: BootFactoryOverrides,
): Promise<BootedFactory> {
  if (!factory || factory.__brand !== "FactoryDef") {
    throw new Error("bootFactory: expected a FactoryDef created by defineFactory()");
  }

  const spec = factory.spec;

  // 1. Traverse the graph and collect all reachable definitions
  const graph = collectGraph(spec);

  // 2. Validate: no duplicate IDs, no cycles, all references resolved
  validateGraph(graph);

  // 3. Convert agent definitions to engine format
  const agentDefinitions = new Map<string, AgentDefinition>();
  for (const agent of graph.agents.values()) {
    agentDefinitions.set(agent.id, toEngineAgentDef(agent));
  }

  // 4. Collect tool sources
  const toolSources = new Map<string, ToolSource>();
  for (const [id, tool] of graph.tools) {
    toolSources.set(id, tool);
  }

  // 5. Build runtime
  const tenantId = overrides?.tenantId ?? process.env.TENANT_ID ?? "default";
  const model = overrides?.model ?? (() => {
    const { spec } = resolveModelSpec(process.env.MODEL_TIER ?? "medium");
    return resolveClient(spec);
  })();

  const runtime = await createRuntime({
    ...overrides?.runtime,
    tenantId,
    model,
    pricing: overrides?.pricing,
    toolSources,
    hooks: [...graph.hooks.values()],
  });

  // 6. Register agent definitions on the runtime
  for (const [name, def] of agentDefinitions) {
    runtime.agentDefinitions.set(name, def);
  }

  // 7. Bind legacy workflow definitions for gateway/dispatch compatibility
  const workflows = new Map<string, LegacyWorkflowDef>();
  for (const wfDef of graph.workflows.values()) {
    const legacyWf = wrapWorkflowDef(wfDef, graph, runtime);
    bindWorkflow(legacyWf, wfDef.id, runtime);
    workflows.set(wfDef.id, legacyWf);
  }

  // 8. Bind channels
  const channels = new Map<string, Channel>();
  for (const chDef of graph.channels.values()) {
    const channel = wrapChannelDef(chDef, graph);
    channels.set(chDef.id, channel);
    runtime.channels.set(chDef.id, channel);
  }

  // 9. Build the agent set (for gateway defaultAgent, etc.)
  const agents = buildAgentSet(agentDefinitions, runtime);

  return {
    runtime,
    agents,
    workflows,
    channels,
    config: spec.config,
    async close() {
      // Cleanup lifecycle placeholder
    },
  };
}

// ---------------------------------------------------------------------------
// Graph collection
// ---------------------------------------------------------------------------

interface FactoryGraph {
  agents: Map<string, AgentDef>;
  tools: Map<string, ToolSource>;
  workflows: Map<string, WorkflowDef>;
  channels: Map<string, ChannelDef>;
  hooks: Map<string, Hook>;
  runners: Map<string, AgentRunner>;
  publicWorkflows: Set<string>;
  interactiveAgents: Set<string>;
}

function collectGraph(spec: FactorySpec): FactoryGraph {
  const graph: FactoryGraph = {
    agents: new Map(),
    tools: new Map(),
    workflows: new Map(),
    channels: new Map(),
    hooks: new Map(),
    runners: new Map(),
    publicWorkflows: new Set(),
    interactiveAgents: new Set(),
  };

  for (const wf of spec.workflows ?? []) {
    collectWorkflow(wf, graph);
    graph.publicWorkflows.add(wf.id);
  }

  for (const ch of spec.channels ?? []) {
    collectChannel(ch, graph);
  }

  for (const agent of spec.interactive ?? []) {
    collectAgent(agent, graph);
    graph.interactiveAgents.add(agent.id);
  }

  return graph;
}

function collectWorkflow(wf: WorkflowDef, graph: FactoryGraph): void {
  if (graph.workflows.has(wf.id)) {
    if (graph.workflows.get(wf.id) !== wf) {
      throw new Error(`Duplicate workflow ID "${wf.id}" from distinct definitions`);
    }
    return;
  }
  graph.workflows.set(wf.id, wf);

  for (const agent of wf.spec.agents) {
    collectAgent(agent, graph);
  }
}

function collectAgent(agent: AgentDef, graph: FactoryGraph): void {
  if (graph.agents.has(agent.id)) {
    if (graph.agents.get(agent.id) !== agent) {
      throw new Error(`Duplicate agent ID "${agent.id}" from distinct definitions`);
    }
    return;
  }
  graph.agents.set(agent.id, agent);

  for (const tool of agent.spec.tools ?? []) {
    const id = (tool as ToolSource).id;
    if (graph.tools.has(id) && graph.tools.get(id) !== tool) {
      throw new Error(`Duplicate tool ID "${id}" from distinct sources`);
    }
    graph.tools.set(id, tool as ToolSource);
  }

  for (const sub of agent.spec.subagents ?? []) {
    collectAgent(sub, graph);
  }
}

function collectChannel(ch: ChannelDef, graph: FactoryGraph): void {
  if (graph.channels.has(ch.id)) {
    if (graph.channels.get(ch.id) !== ch) {
      throw new Error(`Duplicate channel ID "${ch.id}" from distinct definitions`);
    }
    return;
  }
  graph.channels.set(ch.id, ch);

  const target = ch.spec.target;
  if ("workflow" in target && isWorkflowDef(target.workflow)) {
    collectWorkflow(target.workflow, graph);
  }
  if ("agent" in target && isAgentDef(target.agent)) {
    collectAgent(target.agent, graph);
    graph.interactiveAgents.add(target.agent.id);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateGraph(graph: FactoryGraph): void {
  // Agent tool references must be in the collected tool set
  for (const [agentId, agent] of graph.agents) {
    for (const tool of agent.spec.tools ?? []) {
      const id = (tool as ToolSource).id;
      if (!graph.tools.has(id)) {
        throw new Error(`Agent "${agentId}" references unknown tool "${id}"`);
      }
    }
    for (const sub of agent.spec.subagents ?? []) {
      if (!graph.agents.has(sub.id)) {
        throw new Error(`Agent "${agentId}" references unknown subagent "${sub.id}"`);
      }
    }
  }

  // Workflow agents must be in the collected agent set
  for (const [wfId, wf] of graph.workflows) {
    for (const agent of wf.spec.agents) {
      if (!graph.agents.has(agent.id)) {
        throw new Error(`Workflow "${wfId}" references unknown agent "${agent.id}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Engine AgentDefinition conversion
// ---------------------------------------------------------------------------

function toEngineAgentDef(agent: AgentDef): AgentDefinition {
  const spec = agent.spec;
  const modelInput = spec.model ?? "medium";
  const { spec: modelSpec } = resolveModelSpec(modelInput, spec.provider);

  const toolIds = (spec.tools ?? []).map((t) => (t as ToolSource).id);
  const subagentIds = (spec.subagents ?? []).map((s) => s.id);

  const approvalToolIds = (spec.requireApproval ?? []).map((t) => (t as ToolSource).id);

  let outputSchema: Record<string, unknown> | undefined;
  if (spec.output) {
    outputSchema = convertZodToJsonSchemaSync(spec.output);
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

function convertZodToJsonSchemaSync(schema: import("zod/v4").ZodType): Record<string, unknown> {
  const internal = schema as unknown as { _zod?: { def?: Record<string, unknown> } };
  const def = internal._zod?.def;
  if (!def) return { type: "object" };
  const typeName = def.type ?? def.typeName;

  switch (typeName) {
    case "string": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "array": {
      const items = def.element ? convertZodToJsonSchemaSync(def.element as import("zod/v4").ZodType) : {};
      return { type: "array", items };
    }
    case "object": {
      const shape = def.shape as Record<string, import("zod/v4").ZodType> | undefined;
      if (!shape) return { type: "object" };
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertZodToJsonSchemaSync(value);
        const innerDef = (value as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
        if (innerDef?.type !== "optional" && innerDef?.typeName !== "optional") {
          required.push(key);
        }
      }
      return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
    }
    case "optional": {
      const inner = def.innerType as import("zod/v4").ZodType | undefined;
      return inner ? convertZodToJsonSchemaSync(inner) : {};
    }
    case "enum": {
      const values = def.entries ?? def.values;
      if (Array.isArray(values)) return { type: "string", enum: values };
      return { type: "string" };
    }
    default:
      return { type: "object" };
  }
}

// ---------------------------------------------------------------------------
// Workflow wrapping — adapt typed WorkflowDef to legacy WorkflowDefinition
// ---------------------------------------------------------------------------

function wrapWorkflowDef(wfDef: WorkflowDef, graph: FactoryGraph, runtime: AgentRuntime): LegacyWorkflowDef {
  const declaredAgentIds = new Set(wfDef.spec.agents.map((a) => a.id));
  const agentDefsById = new Map(
    wfDef.spec.agents.map((a) => [a.id, a]),
  );

  return legacyWorkflow({ name: wfDef.id, plan: wfDef.spec.agents[0]?.spec.plan }, async (ctx) => {
    const taskContext = createWorkflowTaskContext(ctx, declaredAgentIds, agentDefsById);
    return wfDef.spec.run(taskContext);
  });
}

function createWorkflowTaskContext(
  legacyCtx: import("./workflow.js").WorkflowContext,
  declaredAgentIds: Set<string>,
  agentDefsById: Map<string, AgentDef>,
): WorkflowTaskContext<readonly AgentDef[]> {
  let ordinals = new Map<string, number>();

  return {
    runId: legacyCtx.runId,
    input: legacyCtx.input,
    trigger: legacyCtx.trigger,
    signal: legacyCtx.signal,
    userId: legacyCtx.userId,
    runtime: legacyCtx.runtime,

    async task<T = unknown>(agent: AgentDef, input: unknown, opts?: { key?: string }): Promise<TaskResult<T>> {
      if (!declaredAgentIds.has(agent.id)) {
        throw new Error(
          `Workflow attempted to task undeclared agent "${agent.id}". ` +
          `Add it to the workflow's agents array.`,
        );
      }
      const count = (ordinals.get(agent.id) ?? 0) + 1;
      ordinals.set(agent.id, count);

      const result = await legacyCtx.agents.get(agent.id).task(input as string);
      return { text: result.text, data: result.data as T };
    },

    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      return legacyCtx.step(name, fn);
    },
  };
}

// ---------------------------------------------------------------------------
// Channel wrapping — adapt typed ChannelDef to legacy Channel
// ---------------------------------------------------------------------------

function wrapChannelDef(chDef: ChannelDef, graph: FactoryGraph): Channel {
  const spec = chDef.spec;
  const defaultTarget = resolveChannelTarget(spec.target);

  return {
    target: defaultTarget,
    verify: spec.verify,
    match: spec.match.bind(spec),
    async parse(req: Request) {
      const event = await spec.parse(req);
      const target = event.target ? resolveChannelTarget(event.target) : undefined;
      return {
        conversationId: event.conversationId,
        input: event.input,
        user: event.user,
        target,
      };
    },
    deliver: spec.deliver?.bind(spec),
  };
}

function resolveChannelTarget(
  target: import("./define.js").ChannelTargetDef,
): import("./channel.js").ChannelTarget {
  if ("workflow" in target) {
    return { workflow: target.workflow.id, trigger: target.trigger };
  }
  return { agent: target.agent.id };
}

// ---------------------------------------------------------------------------
// Agent set — for gateway and external consumers
// ---------------------------------------------------------------------------

function buildAgentSet(
  definitions: Map<string, AgentDefinition>,
  runtime: AgentRuntime,
): AgentSet {
  const getOne = (id: string): Agent => {
    const def = definitions.get(id);
    if (!def) throw new Error(`Agent "${id}" not found`);
    return {
      name: def.name,
      definition: def,
      run: () => { throw new Error("Use ctx.task() in workflows instead of agent.run()"); },
      task: () => { throw new Error("Use ctx.task() in workflows instead of agent.task()"); },
    } as Agent;
  };

  return {
    get(id: string | string[]): Agent | Agent[] {
      return Array.isArray(id) ? id.map(getOne) : getOne(id);
    },
    has: (id: string) => definitions.has(id),
    all: () => [...definitions.keys()].map(getOne),
  } as AgentSet;
}

