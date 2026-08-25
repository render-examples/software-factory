import { workflow } from "@render-factory/sdk";

// Fan out to security + performance reviewers as isolated tasks, then a judge
// makes the final structured decision via a memoized step. Inside a handler,
// always use ctx.agents (run-scoped).
export default workflow({ name: "code-review" }, async (ctx) => {
  const input = ctx.input as { diff?: string; message?: string } | string;
  const diff = typeof input === "string" ? input : input.diff ?? input.message ?? "";

  const [security, performance] = await Promise.all([
    ctx.agents.get("security").task(diff),
    ctx.agents.get("performance").task(diff),
  ]);

  return ctx.step("judge", async () => {
    const out = await ctx.agents.get("judge").run(
      `Security review:\n${security.text}\n\nPerformance review:\n${performance.text}`,
    );
    return out.data ?? out.text;
  });
});
