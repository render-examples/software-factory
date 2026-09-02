/**
 * Hook system — event interceptors for the AgentEvent stream.
 *
 * Hooks observe, transform, or veto events flowing out of any runner.
 * They attach inside agentTask() and are SDK-agnostic.
 */
import type { Environment } from "./environment.js";
import type { AgentEvent } from "./runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookResult =
  | { action: "continue"; event?: AgentEvent }
  | { action: "reject"; reason: string };

export interface HookContext {
  readonly runId: string;
  readonly agentId: string;
  /** Workflow-owned execution environment, when the agent run has one. */
  readonly environment?: Environment;
}

export interface Hook {
  readonly name: string;
  readonly on: AgentEvent["type"][];
  handle(event: AgentEvent, ctx: HookContext): Promise<HookResult>;
}

// ---------------------------------------------------------------------------
// HookInterceptor — runs hooks in order against each event
// ---------------------------------------------------------------------------

const GATE_TYPES = new Set<AgentEvent["type"]>(["tool_call"]);

export class HookInterceptor {
  private readonly hooks: Hook[];

  constructor(hooks: Hook[]) {
    this.hooks = hooks;
  }

  async intercept(
    event: AgentEvent,
    ctx: HookContext,
  ): Promise<HookResult> {
    if (this.hooks.length === 0) {
      return { action: "continue" };
    }

    let current = event;
    const isGate = GATE_TYPES.has(event.type);

    for (const hook of this.hooks) {
      if (!hook.on.includes(current.type)) continue;

      let result: HookResult;
      try {
        result = await hook.handle(current, ctx);
      } catch (err) {
        if (isGate) {
          const msg = err instanceof Error ? err.message : String(err);
          return { action: "reject", reason: `Hook "${hook.name}" error: ${msg}` };
        }
        continue;
      }

      if (result.action === "reject") {
        if (!isGate) continue;
        return result;
      }

      if (result.event) {
        current = result.event;
      }
    }

    if (current !== event) {
      return { action: "continue", event: current };
    }
    return { action: "continue" };
  }
}
