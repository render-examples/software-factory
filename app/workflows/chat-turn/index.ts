import { workflow, driveAgentTurn, notifyThreadSurfaces } from "@render-factory/sdk";
import { RunPaused } from "@render-factory/engine";

export default workflow({ name: "chat-turn" }, async (ctx) => {
  // Drive the agent turn
  await ctx.step("drive", async () => {
    try {
      await driveAgentTurn(ctx.runtime, ctx.runId);
    } catch (err) {
      if (!(err instanceof RunPaused)) throw err;
    }
    return { ok: true };
  });

  // Get the assistant's reply from the run events and append as thread item
  await ctx.step("notify", async () => {
    const run = await ctx.runtime.store.getRun(ctx.runId);
    if (!run?.threadId) return { ok: false };

    // Get the last assistant message from the run
    const messages = await ctx.runtime.store.getMessages(ctx.runId, run.workflow);
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    if (!lastAssistant) return { ok: false };

    const text = lastAssistant.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map(b => b.text)
      .join("\n");

    // Append assistant reply as thread item
    await ctx.runtime.itemStore.appendItem({
      threadId: run.threadId,
      runId: ctx.runId,
      kind: "message",
      role: "assistant",
      content: text,
    });

    // Notify all surfaces (Slack, etc)
    await notifyThreadSurfaces(ctx.runtime, run.threadId, {
      kind: "message",
      role: "assistant",
      content: text,
    });

    return { ok: true };
  });

  return { status: "delivered" };
});
