/**
 * Audit hook — logs every tool call, tool result, and final result.
 */
import type { Hook } from "#factory/sdk";

export const auditHook: Hook = {
  name: "audit",
  on: ["tool_call", "tool_result", "result"],
  async handle(event, ctx) {
    const entry = {
      hook: "audit",
      ts: new Date().toISOString(),
      runId: ctx.runId,
      agentId: ctx.agentId,
      eventType: event.type,
      ...(event.type === "tool_call" && { tool: event.name }),
      ...(event.type === "tool_result" && {
        tool: event.name,
        isError: event.isError,
      }),
    };
    console.log(JSON.stringify(entry));
    return { action: "continue" };
  },
};
