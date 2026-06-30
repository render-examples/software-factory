import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { CancelStore } from "@render-agents/store";
import { runRetention, buildEventRecord } from "@render-agents/store";
import type { AgentRuntime, WorkflowDefinition } from "@render-agents/sdk";
import { resumeRun, submitRootRun, driveAgentTurn, RunPaused } from "@render-agents/sdk";
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
  // HITL resume routing (two lanes). Classify the paused run by registry lookup:
  // - a **workflow** root → Lane A: re-trigger + replay (`dispatchRoot` →
  //   `startTask` on Render, or an in-process drive in dev). A container that
  //   deprovisioned between pause and resume reconnects via the event log.
  // - an **agent/chat** turn → Lane B: a durable `resume` job (queue, survives a
  //   gateway restart) or an inline `resumeRun` (inline mode). Same call site,
  //   mode chosen by `submitRootRun`.
  const resume =
    opts.resume ??
    (async (runId: string) => {
      const run = await store.getRun(runId);
      if (run && runtime.workflows.has(run.workflow)) {
        const def = runtime.workflows.get(run.workflow);
        const dispatcher = runtime.dispatcher;
        if (dispatcher?.dispatchRoot) {
          await dispatcher.dispatchRoot({ workflow: run.workflow, runId, plan: def?.options.plan });
        } else {
          await def?.drive(runId);
        }
        return;
      }
      await submitRootRun(runtime, { runId, kind: "resume", driveInline: async () => { await resumeRun(runId, runtime); } });
    });

  // Admin: retention cleanup (authed) — wired to a daily Render Cron.
  app.post("/admin/retention", async (c) => {
    const result = await runRetention(store);
    return c.json(result);
  });

  // Admin: chat-queue depth (Lane B observability). Returns job counts by status
  // so operators can watch backlog/dead-letters and size the chat worker. The
  // workflow lane (Lane A) is queued by Render, not here.
  app.get("/admin/jobs", async (c) => {
    const counts = await runtime.jobQueue.countByStatus();
    const backlog = counts.queued + counts.running;
    return c.json({ counts, backlog });
  });

  // Core run routes
  app.route("/", runRoutes({ store, cancelStore: cancel, workflows: wf }));

  // Runtime-managed schedules (CRUD + /admin/schedules/tick reconciler).
  app.route("/", scheduleRoutes({ scheduleStore: runtime.scheduleStore, workflows: wf }));

  // SSE streaming routes
  app.route("/", streamRoutes({ store }));

  const awaitResume = opts.awaitResume ?? false;

  // Open a new chat turn for a thread (Lane B): each user message is its own
  // short run, joined to the thread by `threadId`; multi-turn memory comes from
  // the thread transcript (not a parked run). A turn completes normally — only
  // HITL *within* the turn parks (RunPaused), which is expected, not an error.
  const startAgentRun = async (agentName: string, input: string, o: { runId: string; threadId: string; userId?: string }): Promise<void> => {
    // Record the opening turn in the log up front (both modes): the run row is
    // the job's FK target and carries input/identity, and the runner's
    // hasStarted() guard then drives without duplicating these events. This keeps
    // inline and queue identical except for where the drive happens.
    const def = runtime.agentDefinitions.get(agentName);
    await store.events.append(
      buildEventRecord(
        o.runId,
        { type: "run.started", input, trigger: "thread_message", threadId: o.threadId, userId: o.userId, agentVersion: def?.version, model: def?.model.model },
        { agentName, spanId: o.runId },
      ),
    );
    await store.events.append(
      buildEventRecord(o.runId, { type: "message.user", content: [{ type: "text", text: input }] }, { agentName }),
    );

    await submitRootRun(runtime, {
      runId: o.runId,
      kind: "agent",
      payload: { agent: agentName },
      // Inline (no worker): drive the turn warm in-process now. Queue: a chat
      // worker claims the `agent` job and calls the same `driveAgentTurn`.
      driveInline: async () => {
        try {
          await driveAgentTurn(runtime, o.runId);
        } catch (err) {
          if (!(err instanceof RunPaused)) throw err;
        }
      },
    });
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

  // The gateway is a front door only. In `queue` mode a separate `runWorker`
  // service drives execution (see the scaffolded runner entrypoint); the gateway
  // never runs the loop itself, keeping ingestion decoupled from compute.
  return {
    port,
    close: () => {
      if (typeof (server as { close?: () => void }).close === "function") {
        (server as { close: () => void }).close();
      }
    },
  };
}
