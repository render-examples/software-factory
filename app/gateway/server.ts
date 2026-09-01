/** Gateway — Hono server for GitHub intake and health. */
import { Hono } from "hono";
import {
	configureFactoryStore,
	type FactoryStore,
} from "#factory/store";
import { githubHandler } from "./github.js";

export function createApp(options: { store: FactoryStore }): Hono {
  configureFactoryStore(options.store);
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    try {
      await options.store.health();
      return c.json({ status: "ready" });
    } catch {
      return c.json({ status: "unavailable" }, 503);
    }
  });
  app.route("/channels", githubHandler({ store: options.store }));

  return app;
}
