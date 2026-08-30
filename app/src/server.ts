/**
 * Gateway entrypoint — Hono web service.
 */
import { serve } from "@hono/node-server";
import { createApp } from "../gateway/server.js";

const app = createApp();
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port });
console.log(`gateway listening on :${port}`);
