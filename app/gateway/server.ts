/** Gateway — Hono server for webhooks, threads, and health. */
import { Hono } from "hono";
import { appendMessage, getOrCreateThread } from "#factory-sdk";
import { dispatchWorkflowTask } from "./dispatch.js";
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

    const result = await dispatchWorkflowTask("assistant", {
      message: body.content,
      threadId,
    });

    // A missing slug is a config gap, not a client error — the message is
    // still persisted, so the request is accepted either way.
    if (!result.ok && result.reason === "error") {
      return c.json({ error: "dispatch failed" }, 502);
    }

    return c.json({ threadId, status: "accepted" }, 202);
  });

  app.route("/channels", slackHandler());
  app.route("/channels", githubHandler());

  return app;
}
