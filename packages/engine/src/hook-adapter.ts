import type { RunEvent, EventInterceptor, EventCategory, Logger } from "@render-agents/store";
import { categoryOf } from "@render-agents/store";
import type { Hook, HookResult, HookContext, HookRegistry } from "./hooks.js";

const GATE_CATEGORIES: Set<EventCategory> = new Set(["tool"]);

/**
 * Adapt a HookRegistry into the store's EventInterceptor seam.
 *
 * Hooks run in registration order for each event whose type or category
 * matches the hook's `on` filter. Semantics:
 * - observe: { action: "continue" } — event passes unchanged
 * - transform: { action: "continue", event } — rewritten event persisted
 * - veto: { action: "reject", reason } — only for gate categories (tool)
 *
 * Fail policy:
 * - Gate hooks (matching gate categories) fail closed on throw → reject
 * - Observer hooks fail open on throw → continue
 */
export function buildHookInterceptor(
  registry: HookRegistry,
  logger: Logger,
  env: (name: string) => string | undefined,
): EventInterceptor {
  const hookIds = registry.ids();
  if (hookIds.length === 0) {
    return { intercept: async () => ({ action: "continue" }) };
  }

  const hooks: Hook[] = hookIds.map((id) => registry.get(id));

  return {
    async intercept(
      event: RunEvent,
      meta: { runId: string; agentName?: string },
    ): Promise<{ action: "continue"; event?: RunEvent } | { action: "reject"; reason: string }> {
      const category = categoryOf(event.type);
      let currentEvent = event;

      for (const hook of hooks) {
        if (!matchesFilter(hook, currentEvent.type, category)) continue;

        const ctx: HookContext = {
          runId: meta.runId,
          agentName: meta.agentName,
          logger,
          env,
        };

        const isGateCategory = GATE_CATEGORIES.has(category);

        let result: HookResult;
        try {
          result = await hook.handle(currentEvent, ctx);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isGateCategory) {
            logger.error(`Hook "${hook.name}" threw on gate category "${category}"; failing closed`, { error: msg });
            return { action: "reject", reason: `Hook "${hook.name}" error: ${msg}` };
          }
          logger.warn(`Hook "${hook.name}" threw; failing open (observer)`, { error: msg });
          continue;
        }

        if (result.action === "reject") {
          if (!isGateCategory) {
            logger.warn(
              `Hook "${hook.name}" returned reject for non-gate category "${category}"; treating as continue`,
            );
            continue;
          }
          return result;
        }

        if (result.event) {
          currentEvent = result.event;
        }
      }

      if (currentEvent !== event) {
        return { action: "continue", event: currentEvent };
      }
      return { action: "continue" };
    },
  };
}

function matchesFilter(hook: Hook, type: RunEvent["type"], category: EventCategory): boolean {
  for (const filter of hook.on) {
    if (filter === type) return true;
    if (filter === category) return true;
  }
  return false;
}
