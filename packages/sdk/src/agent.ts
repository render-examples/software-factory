/**
 * Render-native agent SDK. Agent() is pure config. agentTask() is the bridge.
 * Composition lives in bare Render workflow()/task() calls.
 */
import type { z } from "zod/v4";
import type {
  RenderPlan,
  ModelTier,
  SamplingParams,
  Budget,
  ToolSource,
} from "@render-factory/engine";
import type { WebhookVerify } from "./webhook-verify.js";

// ---------------------------------------------------------------------------
// md — inline Markdown prompts with automatic dedenting
// ---------------------------------------------------------------------------

export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
  let raw = String.raw(strings, ...values);
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^(\s*)/)?.[1].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  if (minIndent > 0) return lines.map((l) => l.slice(minIndent)).join("\n");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AgentDef — pure config, no behavior
// ---------------------------------------------------------------------------

export interface AgentSpec<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly description?: string;

  readonly input?: z.ZodType<TInput>;
  readonly output?: z.ZodType<TOutput>;

  readonly prompt: string;
  readonly model?: ModelTier | string;
  readonly provider?: "anthropic" | "openai";
  readonly sampling?: SamplingParams;
  readonly budget?: Budget;
  readonly plan?: RenderPlan;
  readonly tools?: readonly ToolSource[];
  readonly subagents?: readonly AgentDef[];
  readonly requireApproval?: readonly ToolSource[];
  readonly interactive?: boolean;

  /** Execution strategy. Default: built-in LLM loop. Future: "claude-code", custom fn. */
  readonly executor?: string;
}

export interface AgentDef<TInput = unknown, TOutput = unknown> {
  readonly __kind: "AgentDef";
  readonly id: string;
  readonly spec: AgentSpec<TInput, TOutput>;
}

export function Agent<TInput = unknown, TOutput = unknown>(
  spec: AgentSpec<TInput, TOutput>,
): AgentDef<TInput, TOutput> {
  if (!spec.id) throw new Error("Agent: id is required");
  if (!spec.prompt) throw new Error(`Agent "${spec.id}": prompt is required`);
  return Object.freeze({ __kind: "AgentDef" as const, id: spec.id, spec });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolSetupContext {
  readonly env: (name: string) => string | undefined;
  readonly store: import("@render-factory/store").RunStore;
  readonly runtime: import("./runtime.js").AgentRuntime;
}

export interface TypedToolSpec<TInput = unknown> {
  readonly id: string;
  readonly description: string;
  readonly input?: z.ZodType<TInput>;
  readonly inputSchema?: Record<string, unknown>;
  invoke(
    input: TInput,
    ctx: import("@render-factory/engine").ToolContext,
  ): Promise<import("@render-factory/store").ToolResult | string>;
}

export interface TypedToolWithSetup<TInput = unknown> {
  readonly id: string;
  readonly description: string;
  readonly input?: z.ZodType<TInput>;
  readonly inputSchema?: Record<string, unknown>;
  setup(ctx: ToolSetupContext): TypedToolSpec<TInput>;
}

const SETUP_BRAND = Symbol.for("rf.setup-tool");

interface SetupToolSource extends ToolSource {
  [SETUP_BRAND]: TypedToolWithSetup;
}

export function isSetupTool(source: ToolSource): source is SetupToolSource {
  return SETUP_BRAND in source;
}

export function getSetupSpec(source: SetupToolSource): TypedToolWithSetup {
  return source[SETUP_BRAND];
}

export function defineTool<TInput = unknown>(
  spec: TypedToolSpec<TInput> | TypedToolWithSetup<TInput>,
): ToolSource {
  if ("setup" in spec) {
    const source: SetupToolSource = {
      id: spec.id,
      [SETUP_BRAND]: spec as TypedToolWithSetup,
      async resolve() {
        throw new Error(
          `Tool "${spec.id}" requires setup. It will be materialized by agentTask() at execution time.`,
        );
      },
    };
    return Object.freeze(source);
  }
  return toolSpecToSource(spec);
}

export function toolSpecToSource<TInput>(spec: TypedToolSpec<TInput>): ToolSource {
  const jsonSchema = spec.inputSchema ?? { type: "object" };
  return {
    id: spec.id,
    async resolve() {
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
// Channel definitions
// ---------------------------------------------------------------------------

export type ChannelTargetDef = { agent: AgentDef; trigger?: string };

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
  match(
    req: Request,
  ): import("./channel.js").ChannelMatch | Promise<import("./channel.js").ChannelMatch>;
  parse(req: Request): ChannelInboundEvent | Promise<ChannelInboundEvent>;
  deliver?(ctx: import("./channel.js").ChannelDeliverContext): Promise<void>;
}

export interface ChannelDef {
  readonly __kind: "ChannelDef";
  readonly id: string;
  readonly spec: ChannelDefSpec;
}

export function defineChannel(spec: ChannelDefSpec): ChannelDef {
  if (!spec.id) throw new Error("defineChannel: id is required");
  if (!spec.target) throw new Error("defineChannel: target is required");
  return Object.freeze({ __kind: "ChannelDef" as const, id: spec.id, spec });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function matchesRepoAllowlist(
  repo: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]+");
    return new RegExp(`^${escaped}$`).test(repo);
  });
}
