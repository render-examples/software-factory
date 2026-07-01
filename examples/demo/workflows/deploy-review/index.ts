import { workflow } from "@render-agents/sdk";

// A workflow that hits a human-approval gate. The `deployer` child agent calls
// the gated `deploy` tool; with RENDER_AGENTS_STRICT_APPROVAL set, that parks
// the child (approval.requested + run.paused), and the RunPaused propagates so
// the workflow root itself settles as `paused` (reason: approval). Resolving the
// approval resumes the child; re-triggering the root replays it to completion.
export default workflow({ name: "deploy-review" }, async (ctx) => {
  const input = ctx.input as { environment?: string; message?: string } | string;
  const environment =
    typeof input === "string" ? input : input.environment ?? "production";

  const deploy = await ctx.agents.get("deployer").task(
    `Deploy the application to ${environment}.`,
  );

  return ctx.step("summary", async () => ({
    environment,
    result: deploy.text,
  }));
});
