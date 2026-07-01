import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { CancelStore, RunRecord } from "@render-agents/store";
import { runRetention, reapRuns, buildEventRecord } from "@render-agents/store";
import type { AgentRuntime, WorkflowDefinition } from "@render-agents/sdk";
import { resumeRun, submitRootRun, driveAgentTurn, RunPaused } from "@render-agents/sdk";
import {
  apiKeyAuth,
  defaultPublicPath,
  allowsQueryKey,
  getPrincipal,
  DEFAULT_OPERATOR_ID,
  bearerKeyResolver,
  type AuthResolver,
} from "./auth.js";
import { buildCookieConfig, registerLoginRoutes, wrapWithSession } from "./ui-session.js";
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
  /**
   * Custom auth resolver — derive the caller's identity from a JWT, session, or
   * per-tenant key. Return `null` to reject. Defaults to shared-key bearer auth,
   * mapping the key to a single operator identity. Override for true
   * multi-tenancy.
   */
  auth?: AuthResolver;
  /** userId assigned to the shared-key operator (default `RENDER_AGENTS_OPERATOR_ID` env → `"operator"`). */
  operatorUserId?: string;
}

/**
 * Create and configure the gateway Hono app. Call `startGateway()` to
 * also boot the HTTP server, or use `createGatewayApp()` for testing.
 */
export function createGatewayApp(opts: GatewayOptions) {
  const app = new Hono();
  const { runtime, workflows, cancelStore } = opts;
  const operatorUserId =
    opts.operatorUserId ?? process.env.RENDER_AGENTS_OPERATOR_ID ?? DEFAULT_OPERATOR_ID;

  // Production-readiness config audit: OAuth token encryption falls back to an
  // insecure dev key when this is unset — warn loudly so it isn't shipped.
  if (!opts.disableAuth && !process.env.RENDER_AGENTS_ENCRYPTION_KEY) {
    console.warn(
      "[render-agents] RENDER_AGENTS_ENCRYPTION_KEY is not set; OAuth tokens use an INSECURE dev key. " +
        "Set a strong 32+ char secret in production.",
    );
  }
  if (!opts.disableAuth && !opts.auth && !process.env.RENDER_AGENTS_API_KEY) {
    console.warn(
      "[render-agents] RENDER_AGENTS_API_KEY is not set; all authenticated routes will reject (401). " +
        "Set the key, pass a custom `auth` resolver, or use disableAuth for local dev.",
    );
  }

  // Health check (no auth)
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Operator UI shell (no auth on the static shell + assets). Registered before
  // the auth middleware so it stays unauthenticated.
  const uiEnabled = opts.serveUI !== false;
  if (uiEnabled) {
    app.route("/", uiRoutes());
  }

  // Identity resolution. The browser UI logs in once (POST /ui/login) and rides a
  // signed, httpOnly cookie thereafter — so the raw key never lives in JS or in a
  // URL. `curl`/API callers keep using `Authorization: Bearer`. A custom resolver
  // (JWT/session/per-tenant) can be injected for true multi-tenancy.
  const cookieCfg = buildCookieConfig();
  const baseResolver: AuthResolver =
    opts.auth ?? bearerKeyResolver("RENDER_AGENTS_API_KEY", operatorUserId);
  const resolver: AuthResolver = uiEnabled ? wrapWithSession(baseResolver, cookieCfg) : baseResolver;

  if (uiEnabled && !opts.disableAuth) {
    // Public login/logout — must precede the auth middleware.
    registerLoginRoutes(app, cookieCfg, { envKey: "RENDER_AGENTS_API_KEY", operatorUserId });
  }

  if (opts.disableAuth) {
    // Local dev: still give every handler a principal so tenant scoping works.
    app.use("/*", async (c, next) => {
      c.set("principal", { userId: operatorUserId, role: "operator" });
      await next();
    });
  } else {
    // Auth middleware on all routes except health + the UI shell/login. Carve-outs
    // baked into the middleware (not route ordering) so they survive refactors:
    //   - `isPublicPath`: OAuth callback (authed by signed `state`) and inbound
    //     webhooks/connectors (authed by adapter signatures) — CR-01.
    //   - `allowQueryKey`: SSE + OAuth authorize only, since EventSource / full-page
    //     navigations can't set headers; rejected elsewhere so the key can't leak
    //     via logs/history/Referer (CR-05).
    app.use(
      "/*",
      apiKeyAuth({
        resolver,
        operatorUserId,
        isPublicPath: (p) => defaultPublicPath(p) || p === "/ui/login" || p === "/ui/logout",
        allowQueryKey: allowsQueryKey,
      }),
    );
  }

  // Who am I — lets the UI check auth state (cookie is httpOnly, unreadable by JS).
  app.get("/whoami", (c) => c.json(getPrincipal(c)));

  const store = runtime.store;
  // Cancellation is cooperative: the loop polls `runtime.cancelStore` each
  // iteration, so the gateway's cancel route MUST write to that same store
  // (BUG-01). Default to it; an explicit `cancelStore` override still wins (tests).
  const cancel = cancelStore ?? runtime.cancelStore;
  const wf = workflows ?? new Map();
  // HITL resume routing (two lanes). Classify the paused run by registry lookup:
  // - a **workflow** root → Lane A: re-trigger + replay (`dispatchRoot` →
  //   `startTask` on Render, or an in-process drive in dev). A container that
  //   deprovisioned between pause and resume reconnects via the event log.
  // - an **agent/chat** turn → Lane B: a durable `resume` job (queue, survives a
  //   gateway restart) or an inline `resumeRun` (inline mode). Same call site,
  //   mode chosen by `submitRootRun`.
  // Re-trigger a paused workflow root (Lane A): `dispatchRoot` on Render, or an
  // in-process drive in dev. The handler is replay-safe (memoized `ctx.step` +
  // deterministic child ids), so re-driving resumes from where it parked.
  const redriveRoot = async (root: RunRecord): Promise<void> => {
    const def = runtime.workflows.get(root.workflow);
    const dispatcher = runtime.dispatcher;
    if (dispatcher?.dispatchRoot) {
      // Fail-fast (E6, mode 1): if re-triggering Lane A throws (workflows host
      // down), don't leave the resumed root stranded — record `run.failed` so
      // it's terminal and observable.
      try {
        await dispatcher.dispatchRoot({ workflow: root.workflow, runId: root.id, plan: def?.options.plan });
      } catch (err) {
        await store.events.append(
          buildEventRecord(
            root.id,
            { type: "run.failed", error: `failed to dispatch root to workflows host: ${err instanceof Error ? err.message : String(err)}` },
            { agentName: root.workflow, spanId: root.id },
          ),
        );
      }
    } else {
      await def?.drive(root.id);
    }
  };

  // Child→parent HITL bubble: an approval gate fires inside a *child* agent run
  // (`.task()`/`.run()`), so the resolved run is the child, but the run that
  // parked is the workflow root above it. Walk `parentSpanId` up to the nearest
  // paused workflow root so resolving the child's approval re-drives that root
  // (its replay re-dispatches the still-paused child past the now-resolved gate).
  // Interim until native Workflows pause/resume lands (see docs/bug-bash.md).
  const findPausedWorkflowRoot = async (run: RunRecord): Promise<RunRecord | undefined> => {
    const seen = new Set<string>();
    let cursor: RunRecord | undefined = run;
    while (cursor?.parentSpanId && !seen.has(cursor.parentSpanId)) {
      seen.add(cursor.parentSpanId);
      const parent = await store.getRun(cursor.parentSpanId);
      if (!parent) return undefined;
      if (runtime.workflows.has(parent.workflow) && parent.status === "paused") return parent;
      cursor = parent;
    }
    return undefined;
  };

  const resume =
    opts.resume ??
    (async (runId: string) => {
      const run = await store.getRun(runId);
      // A paused workflow root resolved directly → re-drive it (Lane A).
      if (run && runtime.workflows.has(run.workflow)) {
        await redriveRoot(run);
        return;
      }
      // A child agent run gated inside a workflow → re-drive its paused root.
      if (run) {
        const root = await findPausedWorkflowRoot(run);
        if (root) {
          await redriveRoot(root);
          return;
        }
      }
      // Otherwise an agent/chat turn → Lane B: durable `resume` job (queue) or
      // an inline `resumeRun` (inline mode). Same call site, mode via submitRootRun.
      await submitRootRun(runtime, { runId, kind: "resume", driveInline: async () => { await resumeRun(runId, runtime); } });
    });

  // Admin: retention cleanup (authed) — wired to a daily Render Cron.
  app.post("/admin/retention", async (c) => {
    const result = await runRetention(store);
    return c.json(result);
  });

  // Admin: stranded-run reaper (authed) — wired to a periodic Render Cron. Fails
  // Lane A roots whose hand-off to the workflows host was accepted but never
  // progressed (host died / task lost), so they don't sit `running` forever (E6).
  app.post("/admin/runs/reap", async (c) => {
    const result = await reapRuns(store);
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

  // Registered workflow names (read-only) — powers the operator UI's dispatch
  // and schedule pickers. The dispatch POST lives in runRoutes; this is the
  // matching list route so the UI doesn't have to hardcode workflow names.
  app.get("/workflows", (c) => {
    const list = [...wf.keys()].map((name) => ({ name }));
    return c.json({ workflows: list, defaultWorkflow: opts.defaultWorkflow });
  });

  // Core run routes
  app.route("/", runRoutes({ store, cancelStore: cancel, workflows: wf }));

  // Runtime-managed schedules (CRUD + /admin/schedules/tick reconciler).
  app.route("/", scheduleRoutes({ scheduleStore: runtime.scheduleStore, workflows: wf }));

  // SSE streaming routes — merge the durable event tail with the transient
  // token-delta bus (D13) for live streaming.
  app.route("/", streamRoutes({ store, threadStore: runtime.threadStore, deltaBus: runtime.deltaBus }));

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
    // Read-only connection status for the caller: the configured providers plus
    // whether the authenticated user has a live connection. The userId comes from
    // auth (never a client param), so a caller can only see their own connections.
    const providers = opts.oauthProviders;
    app.get("/connections", async (c) => {
      const { userId } = getPrincipal(c);
      const out = [];
      for (const name of providers.keys()) {
        const conn = await runtime.oauthStore.getConnection(userId, name);
        out.push({ provider: name, connected: !!conn, scopes: conn?.scopes, expiresAt: conn?.expiresAt });
      }
      return c.json({ providers: out });
    });

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
