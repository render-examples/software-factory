/** Gateway — Hono server for webhooks, threads, and health. */
import { Hono } from "hono";
import { appendMessage, getOrCreateThread } from "#factory-sdk";
import { slackHandler } from "./slack.js";
import { githubHandler } from "./github.js";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/threads/:id/messages", async (c) => {
    const threadId = c.req.param("id");
    const body = await c.req.json<{ content: string; userId?: string }>();
    if (!body.content) return c.json({ error: "content is required" }, 400);

    await getOrCreateThread(threadId, { userId: body.userId ?? "anonymous" });
    await appendMessage(threadId, "user", body.content);

    const slug = process.env.RENDER_WORKFLOW_SLUG;
    if (slug) {
      try {
        const { Render } = await import("@renderinc/sdk");
        const client = new Render();
        await client.workflows.startTask(`${slug}/assistant`, [
          { message: body.content, threadId },
        ]);
      } catch (err) {
        console.error("Failed to dispatch assistant task:", err);
        return c.json({ error: "dispatch failed" }, 502);
      }
    } else {
      console.warn("RENDER_WORKFLOW_SLUG not set — cannot dispatch agent task");
    }

    return c.json({ threadId, status: "accepted" }, 202);
  });

  app.route("/channels", slackHandler());
  app.route("/channels", githubHandler());

  return app;
}
