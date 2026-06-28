import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { CancelStore } from "@render-agents/store";
import type { AgentRuntime, WorkflowDefinition } from "@render-agents/sdk";
import { apiKeyAuth } from "./auth.js";
import { runRoutes } from "./routes/runs.js";
import { streamRoutes } from "./routes/stream.js";
import { threadRoutes } from "./routes/threads.js";
import { hitlRoutes } from "./routes/hitl.js";
import { oauthRoutes, type OAuthProviderConfig } from "./routes/oauth.js";
import { webhookRoutes, type WebhookAdapter } from "./routes/webhooks.js";
import type { ConnectorSpec } from "./connector.js";

export interface GatewayOptions {
  runtime: AgentRuntime;
  workflows?: Map<string, WorkflowDefinition>;
  cancelStore?: CancelStore;
  port?: number;
  defaultWorkflow?: string;
  baseUrl?: string;
  oauthProviders?: Map<string, OAuthProviderConfig>;
  webhooks?: Map<string, WebhookAdapter>;
  connectors?: Map<string, ConnectorSpec>;
  /** Disable auth for local dev (NOT for production). */
  disableAuth?: boolean;
}

/**
 * Create and configure the gateway Hono app. Call `startGateway()` to
 * also boot the HTTP server, or use `createGatewayApp()` for testing.
 */
export function createGatewayApp(opts: GatewayOptions) {
  const app = new Hono();
  const { runtime, workflows, cancelStore } = opts;

  // Health check (no auth)
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Auth middleware on all routes except health
  if (!opts.disableAuth) {
    app.use("/*", apiKeyAuth());
  }

  const store = runtime.store;
  const cancel = cancelStore ?? { requestCancel: async () => {}, isCancelled: async () => false, clearCancel: async () => {} };
  const wf = workflows ?? new Map();

  // Core run routes
  app.route("/", runRoutes({ store, cancelStore: cancel, workflows: wf }));

  // SSE streaming routes
  app.route("/", streamRoutes({ store }));

  // Thread routes
  app.route("/", threadRoutes({ store, workflows: wf, defaultWorkflow: opts.defaultWorkflow }));

  // HITL routes (approvals + resume)
  app.route("/", hitlRoutes({ store }));

  // OAuth routes
  if (opts.oauthProviders && opts.oauthProviders.size > 0) {
    app.route("/", oauthRoutes({
      providers: opts.oauthProviders,
      baseUrl: opts.baseUrl ?? `http://localhost:${opts.port ?? 3000}`,
    }));
  }

  // Webhook + connector routes
  if ((opts.webhooks && opts.webhooks.size > 0) || (opts.connectors && opts.connectors.size > 0)) {
    app.route("/", webhookRoutes({
      webhooks: opts.webhooks ?? new Map(),
      connectors: opts.connectors ?? new Map(),
      workflows: wf,
    }));
  }

  return app;
}

/**
 * Boot the gateway HTTP server. Initializes the runtime, loads agents,
 * and starts serving on the configured port.
 */
export async function startGateway(opts: GatewayOptions): Promise<{ port: number; close: () => void }> {
  const app = createGatewayApp(opts);
  const port = opts.port ?? Number(process.env.PORT ?? 3000);

  const server = serve({ fetch: app.fetch, port });

  return {
    port,
    close: () => {
      if (typeof (server as { close?: () => void }).close === "function") {
        (server as { close: () => void }).close();
      }
    },
  };
}
