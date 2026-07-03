import type { EventCategory, RunEvent } from "./events.js";

/**
 * Maps each concrete event type to its category. Consumers subscribe by
 * category, not by individual name (AG-UI-aligned), so this table is the single
 * source for category resolution used by `events.append` when building a record.
 */
const EVENT_CATEGORY: Record<RunEvent["type"], EventCategory> = {
  "run.started": "lifecycle",
  "run.completed": "lifecycle",
  "run.failed": "lifecycle",
  "run.paused": "lifecycle",
  "run.cancelled": "lifecycle",
  "message.user": "message",
  "message.assistant": "message",
  "message.tool": "message",
  "text.delta": "message",
  "tool.called": "tool",
  "tool.result": "tool",
  "step.started": "step",
  "step.completed": "step",
  "llm.call": "model",
  "input.requested": "input",
  "input.provided": "input",
  "input.auto": "input",
  "subagent.spawned": "delegation",
  "context.compacted": "context",
};

export function categoryOf(type: RunEvent["type"]): EventCategory {
  return EVENT_CATEGORY[type];
}
