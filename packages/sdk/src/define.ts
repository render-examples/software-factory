/**
 * Typed authoring API for render-factory definitions.
 *
 * All factory composition is explicit TypeScript: agents, tools, workflows,
 * channels, and the factory root are immutable definition objects created by
 * `define*()` functions. `bootFactory()` traverses the resulting graph and
 * materializes a runtime — no filesystem discovery, Markdown frontmatter,
 * generated manifests, or module-level mutation.
 */

import type { z } from "zod/v4";
import type {
  RenderPlan,
  ModelTier,
  SamplingParams,
  Budget,
  ToolSource,
  DefineToolSpec,
  DefineMcpSpec,
  Hook,
  AgentRunner,
} from "@render-factory/engine";
import type { WebhookVerify } from "./webhook-verify.js";

// ---------------------------------------------------------------------------
// md tagged template — inline Markdown prompts with automatic dedenting
// ---------------------------------------------------------------------------

/**
 * Tagged template for inline Markdown prompts. Strips the leading indentation
 * common to all non-empty lines so prompts can be indented naturally inside
 * TypeScript without shipping whitespace to the model.
 */
export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  let raw = String.raw(strings, ...values);

  const lines = raw.split("\n");
  // Drop leading/trailing blank lines from the template boundaries
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^(\s*)/)?.[1].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;

  if (minIndent > 0) {
    return lines.map((l) => l.slice(minIndent)).join("\n");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export interface AgentDefinitionSpec<
  TInput = unknown,
  TOutput = unknown,
> {
  readonly id: string;
  readonly description?: string;

  /** Model tier (`"small"`, `"medium"`, `"large"`) or a specific model ID. */
  readonly model?: ModelTier | string;
  readonly provider?: "anthropic" | "openai";
  readonly sampling?: SamplingParams;
  readonly budget?: Budget;
  readonly plan?: RenderPlan;

  /** Zod schema for validating/typing agent input. */
  readonly input?: z.ZodType<TInput>;
  /** Zod schema for structured output. Converted to JSON Schema at the engine boundary. */
  readonly output?: z.ZodType<TOutput>;

  /** Tool sources this agent can access. */
  readonly tools?: readonly ToolSource[];
  /** Subagent definitions this agent can delegate to. */
  readonly subagents?: readonly AgentDef[];

  /** Tools that require human approval before execution. */
  readonly requireApproval?: readonly ToolSource[];

  /** Marks this agent as a conversational chat surface. */
  readonly interactive?: boolean;

  /** The system prompt, typically authored with the `md` tagged template. */
  readonly prompt: string;
}

/** An opaque, immutable agent definition. */
export interface AgentDef<TInput = unknown, TOutput = unknown> {
  readonly __brand: "AgentDef";
  readonly id: string;
  readonly spec: AgentDefinitionSpec<TInput, TOutput>;
}

export function defineAgent<TInput = unknown, TOutput = unknown>(
  spec: AgentDefinitionSpec<TInput, TOutput>,
): AgentDef<TInput, TOutput> {
  if (!spec.id) throw new Error("defineAgent: id is required");
  if (!spec.prompt) throw new Error("defineAgent: prompt is required");
  return Object.freeze({
    __brand: "AgentDef" as const,
    id: spec.id,
    spec,
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Options for tools that need runtime dependencies (store, workflows, etc.)
 * injected at boot time rather than captured from module scope.
 */
export interface ToolSetupContext {
  readonly env: (name: string) => string | undefined;
  readonly workflows: ReadonlyMap<string, { dispatch: (input: unknown, trigger?: string) => Promise<unknown> }>;
  readonly store: unknown;
}

export interface TypedToolSpec<TInput = unknown> {
  readonly id: string;
  readonly description: string;
  readonly input?: z.ZodType<TInput>;
  /** Raw JSON Schema — used when Zod is not desired. Mutually exclusive with `input`. */
  readonly inputSchema?: Record<string, unknown>;
  invoke(input: TInput, ctx: import("@render-factory/engine").ToolContext): Promise<import("@render-factory/store").ToolResult | string>;
}

export interface TypedToolWithSetup<TInput = unknown> {
  readonly id: string;
  readonly description: string;
  readonly input?: z.ZodType<TInput>;
  readonly inputSchema?: Record<string, unknown>;
  setup(ctx: ToolSetupContext): TypedToolSpec<TInput>;
}

export type ToolDef = ToolSource;

/**
 * Define a simple tool. If the tool needs runtime dependencies, pass an
 * object with a `setup()` method instead.
 */
export function defineTool<TInput = unknown>(
  spec: TypedToolSpec<TInput> | TypedToolWithSetup<TInput>,
): ToolSource {
  if ("setup" in spec) {
    return {
      id: spec.id,
      async resolve(env) {
        const resolved = spec.setup({
          env: (name) => process.env[name],
          workflows: new Map(),
          store: undefined,
        });
        const jsonSchema = resolved.inputSchema ?? await zodToJsonSchema(resolved.input) ?? { type: "object" };
        return {
          tools: [{
            name: resolved.id,
            description: resolved.description,
            inputSchema: jsonSchema,
            async invoke(input, ctx) {
              const raw = await resolved.invoke(input as TInput, ctx);
              if (typeof raw === "string") return { content: raw };
              return raw;
            },
          }],
          close: async () => {},
        };
      },
    };
  }

  return {
    id: spec.id,
    async resolve() {
      const jsonSchema = spec.inputSchema ?? await zodToJsonSchema(spec.input) ?? { type: "object" };
      return {
        tools: [{
          name: spec.id,
          description: spec.description,
          inputSchema: jsonSchema,
          async invoke(input, ctx) {
            const raw = await spec.invoke(input as TInput, ctx);
            if (typeof raw === "string") return { content: raw };
            return raw;
          },
        }],
        close: async () => {},
      };
    },
  };
}

export { defineMcpSource } from "@render-factory/engine";

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

export interface WorkflowTaskContext<TAgents extends readonly AgentDef[]> {
  readonly runId: string;
  readonly input: unknown;
  readonly trigger: string;
  readonly signal: AbortSignal;
  readonly userId?: string;

  /** Dispatch a durable isolated agent task. */
  task<T = unknown>(
    agent: TAgents[number],
    input: unknown,
    opts?: { key?: string },
  ): Promise<TaskResult<T>>;

  /** Memoized side-effect step (deterministic on replay). */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /** Access to runtime internals for advanced use cases. */
  readonly runtime: unknown;
}

export interface TaskResult<T = unknown> {
  readonly text: string;
  readonly data?: T;
}

export interface WorkflowDefinitionSpec<
  TAgents extends readonly AgentDef[] = readonly AgentDef[],
> {
  readonly id: string;
  readonly agents: TAgents;
  readonly input?: z.ZodType;
  readonly output?: z.ZodType;
  run(ctx: WorkflowTaskContext<TAgents>): Promise<unknown>;
}

/** An opaque, immutable workflow definition. */
export interface WorkflowDef<
  TAgents extends readonly AgentDef[] = readonly AgentDef[],
> {
  readonly __brand: "WorkflowDef";
  readonly id: string;
  readonly spec: WorkflowDefinitionSpec<TAgents>;
}

export function defineWorkflow<
  const TAgents extends readonly AgentDef[],
>(
  spec: WorkflowDefinitionSpec<TAgents>,
): WorkflowDef<TAgents> {
  if (!spec.id) throw new Error("defineWorkflow: id is required");
  if (!spec.agents || spec.agents.length === 0) throw new Error("defineWorkflow: agents is required");
  if (!spec.run) throw new Error("defineWorkflow: run handler is required");
  return Object.freeze({
    __brand: "WorkflowDef" as const,
    id: spec.id,
    spec,
  });
}

// ---------------------------------------------------------------------------
// Channel definitions
// ---------------------------------------------------------------------------

export type ChannelTargetDef =
  | { agent: AgentDef }
  | { workflow: WorkflowDef; trigger?: string };

export interface ChannelInboundEvent {
  conversationId: string;
  input: unknown;
  user?: string;
  target?: ChannelTargetDef;
}

export interface ChannelDefSpec {
  readonly id: string;
  readonly target: ChannelTargetDef;
  readonly verify?: WebhookVerify;
  match(req: Request): import("./channel.js").ChannelMatch | Promise<import("./channel.js").ChannelMatch>;
  parse(req: Request): ChannelInboundEvent | Promise<ChannelInboundEvent>;
  deliver?(ctx: import("./channel.js").ChannelDeliverContext): Promise<void>;
}

/** An opaque, immutable channel definition. */
export interface ChannelDef {
  readonly __brand: "ChannelDef";
  readonly id: string;
  readonly spec: ChannelDefSpec;
}

export function defineChannel(spec: ChannelDefSpec): ChannelDef {
  if (!spec.id) throw new Error("defineChannel: id is required");
  if (!spec.target) throw new Error("defineChannel: target is required");
  return Object.freeze({
    __brand: "ChannelDef" as const,
    id: spec.id,
    spec,
  });
}

// ---------------------------------------------------------------------------
// Factory root
// ---------------------------------------------------------------------------

export interface FactorySpec {
  /** Configuration (repo allowlist, etc.) */
  readonly config?: {
    repos?: string[];
  };
  /** Workflows dispatchable through the public HTTP API. */
  readonly workflows?: readonly WorkflowDef[];
  /** Inbound/outbound channel surfaces. */
  readonly channels?: readonly ChannelDef[];
  /** Interactive conversational agents exposed as chat entrypoints. */
  readonly interactive?: readonly AgentDef[];
}

/** An opaque, immutable factory definition. */
export interface FactoryDef {
  readonly __brand: "FactoryDef";
  readonly spec: FactorySpec;
}

export function defineFactory(spec: FactorySpec): FactoryDef {
  return Object.freeze({
    __brand: "FactoryDef" as const,
    spec,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function zodToJsonSchema(schema: z.ZodType | undefined): Promise<Record<string, unknown> | undefined> {
  if (!schema) return undefined;
  // Zod v4 does not ship a built-in toJSONSchema. We convert using the
  // schema's internal representation for common primitive/object/array shapes.
  // For complex schemas, authors should provide `inputSchema` directly.
  return convertZodToJsonSchema(schema);
}

function convertZodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const internal = schema as unknown as { _zod?: { def?: Record<string, unknown> } };
  const def = internal._zod?.def;
  if (!def) return { type: "object" };
  const typeName = def.type ?? def.typeName;

  switch (typeName) {
    case "string": return { type: "string" };
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "array": {
      const items = def.element ? convertZodToJsonSchema(def.element as z.ZodType) : {};
      return { type: "array", items };
    }
    case "object": {
      const shape = def.shape as Record<string, z.ZodType> | undefined;
      if (!shape) return { type: "object" };
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convertZodToJsonSchema(value);
        const innerDef = (value as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
        if (innerDef?.type !== "optional" && innerDef?.typeName !== "optional") {
          required.push(key);
        }
      }
      return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
    }
    case "optional": {
      const inner = def.innerType as z.ZodType | undefined;
      return inner ? convertZodToJsonSchema(inner) : {};
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
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isAgentDef(value: unknown): value is AgentDef {
  return typeof value === "object" && value !== null && (value as AgentDef).__brand === "AgentDef";
}

export function isWorkflowDef(value: unknown): value is WorkflowDef {
  return typeof value === "object" && value !== null && (value as WorkflowDef).__brand === "WorkflowDef";
}

export function isChannelDef(value: unknown): value is ChannelDef {
  return typeof value === "object" && value !== null && (value as ChannelDef).__brand === "ChannelDef";
}

export function isFactoryDef(value: unknown): value is FactoryDef {
  return typeof value === "object" && value !== null && (value as FactoryDef).__brand === "FactoryDef";
}
