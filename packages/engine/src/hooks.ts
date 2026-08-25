import type { RunEvent, EventCategory, Logger } from "@render-factory/store";

export type HookResult =
  | { action: "continue"; event?: RunEvent }
  | { action: "reject"; reason: string };

export interface HookContext {
  readonly runId: string;
  readonly agentName?: string;
  readonly logger: Logger;
  env(name: string): string | undefined;
}

export interface Hook {
  readonly name: string;
  readonly on: (EventCategory | RunEvent["type"])[];
  handle(event: RunEvent, ctx: HookContext): Promise<HookResult>;
}

export interface HookRegistry {
  get(name: string): Hook;
  has(name: string): boolean;
  ids(): string[];
}
