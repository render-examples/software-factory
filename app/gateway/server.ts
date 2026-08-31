/** Gateway — Hono server for GitHub intake and health. */
import { Hono } from "hono";
import { kv } from "#factory/sdk";
import { githubHandler } from "./github.js";
import { slackConfigured, slackHandler } from "./slack.js";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    try {
      await (await kv()).ping();
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });
  app.route("/channels", githubHandler());
  if (slackConfigured()) app.route("/channels", slackHandler());

  return app;
}
