import { workflow, driveAgentTurn, deliverForRun } from "@render-factory/sdk";
import { RunPaused } from "@render-factory/engine";

/**
 * Drives a single interactive chat turn.
 *
 * The gateway has already recorded run.started + message.user in the event log
 * and dispatched this workflow. We drive the agent loop (which picks up
 * mid-stream via hasStarted() guard) and deliver the reply.
 */
export default workflow({ name: "chat-turn" }, async (ctx) => {
  await ctx.step("drive", async () => {
    try {
      await driveAgentTurn(ctx.runtime, ctx.runId);
    } catch (err) {
      if (!(err instanceof RunPaused)) throw err;
    }
    return { ok: true };
  });

  await ctx.step("deliver", async () => {
    await deliverForRun(ctx.runtime, ctx.runId);
    return { ok: true };
  });

  return { status: "delivered" };
});
