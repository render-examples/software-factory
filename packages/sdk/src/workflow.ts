import type {
  Logger,
  Tracer,
  RunRecord,
} from "@render-agents/store";
import type {
  RenderPlan,
} from "@render-agents/engine";
import type { AgentSet } from "./agents.js";

export interface WorkflowOptions {
  timeout?: number;
  retries?: number;
  plan?: RenderPlan;
}

export interface WorkflowContext {
  readonly runId: string;
  readonly trigger: string;
  readonly input: unknown;
  readonly agents: AgentSet;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly userId?: string;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly options: WorkflowOptions;
  dispatch(input: unknown, trigger?: string): Promise<RunRecord>;
}

export function workflow(
  handler: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;
export function workflow(
  opts: WorkflowOptions,
  handler: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition;
export function workflow(
  _optsOrHandler: WorkflowOptions | ((ctx: WorkflowContext) => Promise<unknown>),
  _handler?: (ctx: WorkflowContext) => Promise<unknown>,
): WorkflowDefinition {
  throw new Error("not implemented");
}

export interface WebhookAdapter {
  readonly name: string;
  match(req: Request): WebhookMatch | null;
  parse(req: Request): Promise<unknown>;
}

export interface WebhookMatch {
  workflow: string;
  trigger: string;
}
