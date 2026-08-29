import { defineWorkflow, driveAgentTurn, notifyThreadSurfaces } from "@render-factory/sdk";
import type { AgentRuntime } from "@render-factory/sdk";
import { assistant } from "../../agents/index.js";
import { RunPaused } from "@render-factory/engine";

export default defineWorkflow({
  id: "chat-turn",
  agents: [assistant] as const,
  run: async (ctx) => {
  const rt = ctx.runtime as AgentRuntime;
  await ctx.step("drive", async () => {
    try {
      await driveAgentTurn(rt, ctx.runId);
    } catch (err) {
      if (!(err instanceof RunPaused)) throw err;
    }
    return { ok: true };
  });

  await ctx.step("notify", async () => {
    const run = await rt.store.getRun(ctx.runId);
    if (!run?.threadId) return { ok: false };

    const messages = await rt.store.getMessages(ctx.runId, run.workflow);
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    if (!lastAssistant) return { ok: false };

    const text = lastAssistant.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map(b => b.text)
      .join("\n");

    await rt.itemStore.appendItem({
      threadId: run.threadId,
      runId: ctx.runId,
      kind: "message",
      role: "assistant",
      content: text,
    });

    await notifyThreadSurfaces(rt, run.threadId, {
      kind: "message",
      role: "assistant",
      content: text,
    });

    return { ok: true };
  });

  return { status: "delivered" };
},
});
