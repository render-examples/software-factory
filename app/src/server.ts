/**
 * Gateway entrypoint — Hono web service.
 */
import { serve } from "@hono/node-server";
import { closeKv } from "#factory-sdk";
import { createApp } from "../gateway/server.js";
import { assertGatewayConfig } from "../lib/factory-config.js";

assertGatewayConfig();
const app = createApp();
const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
console.log(`gateway listening on :${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void closeKv().finally(() => process.exit(0));
    });
  });
}
