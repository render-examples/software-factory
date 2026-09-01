/**
 * Gateway entrypoint — Hono web service.
 */
import { serve } from "@hono/node-server";
import {
	configureFactoryStore,
	createPostgresFactoryStore,
} from "#factory/store";
import { createApp } from "../gateway/server.js";
import { assertGatewayConfig } from "../lib/factory-config.js";

assertGatewayConfig();
const store = createPostgresFactoryStore({
	applicationName: "render-factory-gateway",
});
await store.verifySchema();
configureFactoryStore(store);
const app = createApp({ store });
const port = Number(process.env.PORT ?? 3000);

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
console.log(`gateway listening on :${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    });
  });
}
