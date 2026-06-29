import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { CancelStore } from "@render-agents/store";
import { runRetention } from "@render-agents/store";
import type { AgentRuntime, WorkflowDefinition } from "@render-agents/sdk";
import { resumeRun, RunPaused } from "@render-agents/sdk";
import { apiKeyAuth } from "./auth.js";
import { runRoutes } from "./routes/runs.js";
import { streamRoutes } from "./routes/stream.js";
import { threadRoutes } from "./routes/threads.js";
import { hitlRoutes } from "./routes/hitl.js";
import { oauthRoutes, buildRefresher, type OAuthProviderConfig } from "./routes/oauth.js";
import { webhookRoutes, type WebhookAdapter } from "./routes/webhooks.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { uiRoutes } from "./routes/ui.js";
import type { ConnectorSpec } from "./connector.js";

export interface GatewayOptions {
  runtime: AgentRuntime;
  workflows?: Map<string, WorkflowDefinition>;
  cancelStore?: CancelStore;
  port?: number;
  defaultWorkflow?: string;
  /**
   * Conversational agent for threads. When set, a thread's first message
   * dispatches this (interactive) agent run; subsequent messages resume it. When
   * unset, threads fall back to `defaultWorkflow`.
   */
  defaultAgent?: string;
  baseUrl?: string;
  oauthProviders?: Map<string, OAuthProviderConfig>;
  webhooks?: Map<string, WebhookAdapter>;
  connectors?: Map<string, ConnectorSpec>;
  /**
   * Resume driver for paused runs. Defaults to the in-process `resumeRun` over
   * the provided runtime. Injectable for tests / a workflow-service dispatch.
   */
  resume?: (runId: string) => Promise<unknown>;
  /**
   * Await the resume driver before responding to resolve/input requests. Default
   * false (fire-and-forget) so an operator's HTTP call isn't blocked for the
   * full run; tests set true for deterministic assertions.
   */
  awaitResume?: boolean;
  /** Serve the operator UI SPA at `/ui` (default true). */
  serveUI?: boolean;
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

  // Production-readiness config audit: OAuth token encryption falls back to an
  // insecure dev key when this is unset — warn loudly so it isn't shipped.
  if (!opts.disableAuth && !process.env.RENDER_AGENTS_ENCRYPTION_KEY) {
    console.warn(
      "[render-agents] RENDER_AGENTS_ENCRYPTION_KEY is not set; OAuth tokens use an INSECURE dev key. " +
        "Set a strong 32+ char secret in production.",
    );
  }

  // Health check (no auth)
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Operator UI shell (no auth on the static shell + assets; data fetches carry
  // the API key). Registered before the auth middleware so it stays unauthenticated.
  if (opts.serveUI !== false) {
    app.route("/", uiRoutes());
  }

  // Auth middleware on all routes except health + the UI shell
  if (!opts.disableAuth) {
    app.use("/*", apiKeyAuth());
  }

  const store = runtime.store;
  const cancel = cancelStore ?? { requestCancel: async () => {}, isCancelled: async () => false, clearCancel: async () => {} };
  const wf = workflows ?? new Map();
  // Resolving an approval / delivering input must re-drive the paused run.
  const resume = opts.resume ?? ((runId: string) => resumeRun(runId, runtime));

  // Admin: retention cleanup (authed) — wired to a daily Render Cron.
  app.post("/admin/retention", async (c) => {
    const result = await runRetention(store);
    return c.json(result);
  });

  // Core run routes
  app.route("/", runRoutes({ store, cancelStore: cancel, workflows: wf }));

  // Runtime-managed schedules (CRUD + /admin/schedules/tick reconciler).
  app.route("/", scheduleRoutes({ scheduleStore: runtime.scheduleStore, workflows: wf }));

  // SSE streaming routes
  app.route("/", streamRoutes({ store }));

  const awaitResume = opts.awaitResume ?? false;

  // Start an interactive chat agent run for a thread's first message. The agent
  // parks on awaitInput after replying (throws RunPaused) — expected, not an error.
  const startAgentRun = async (agentName: string, input: string, o: { runId: string; threadId: string; userId?: string }): Promise<void> => {
    if (!runtime.dispatcher) throw new Error("No dispatcher configured for conversational threads");
    try {
      await runtime.dispatcher.dispatch(agentName, input, {
        runId: o.runId, threadId: o.threadId, userId: o.userId,
        idempotencyKey: o.runId, plan: runtime.agentDefinitions.get(agentName)?.plan,
      });
    } catch (err) {
      if (!(err instanceof RunPaused)) throw err;
    }
  };

  // Thread routes
  app.route("/", threadRoutes({ store, threadStore: runtime.threadStore, workflows: wf, defaultWorkflow: opts.defaultWorkflow, defaultAgent: opts.defaultAgent, startAgentRun, resume, awaitResume }));

  // HITL routes (approvals + resume)
  app.route("/", hitlRoutes({ store, resume, awaitResume }));

  // OAuth routes
  if (opts.oauthProviders && opts.oauthProviders.size > 0) {
    // Register token refreshers so the loop can refresh expired tokens mid-run.
    for (const [name, config] of opts.oauthProviders) {
      if (!runtime.oauthRefreshers.has(name)) {
        runtime.oauthRefreshers.set(name, buildRefresher(config));
      }
    }
    app.route("/", oauthRoutes({
      providers: opts.oauthProviders,
      baseUrl: opts.baseUrl ?? `http://localhost:${opts.port ?? 3000}`,
      oauthStore: runtime.oauthStore,
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
