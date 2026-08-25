import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { CancelStore, RunRecord } from "@render-factory/store";
import { runRetention, reapRuns, buildEventRecord } from "@render-factory/store";
import type { AgentRuntime, WorkflowDefinition, Channel } from "@render-factory/sdk";
import { resumeRun, submitRootRun, driveAgentTurn, RunPaused, idempotencyKey, deliverForRun } from "@render-factory/sdk";
import {
  apiKeyAuth,
  defaultPublicPath,
  allowsQueryKey,
  getPrincipal,
  requireOperator,
  DEFAULT_OPERATOR_ID,
  bearerKeyResolver,
  type AuthResolver,
} from "./auth.js";
import { buildCookieConfig, registerLoginRoutes, wrapWithSession } from "./ui-session.js";
import { issueStreamToken, verifyStreamToken } from "./stream-token.js";
import { runRoutes } from "./routes/runs.js";
import { streamRoutes } from "./routes/stream.js";
import { threadRoutes } from "./routes/threads.js";
import { hitlRoutes } from "./routes/hitl.js";
import { oauthRoutes, buildRefresher, type OAuthProviderConfig } from "./routes/oauth.js";
import { channelRoutes } from "./routes/channels.js";
import { scheduleRoutes } from "./routes/schedules.js";
import { uiRoutes } from "./routes/ui.js";

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
  /** Inbound/outbound message surfaces (Slack/GitHub/…), mounted at `POST /channels/:id`. */
  channels?: Map<string, Channel>;
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
  /** userId assigned to the shared-key operator (default `RENDER_FACTORY_OPERATOR_ID` env → `"operator"`). */
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
    opts.operatorUserId ?? process.env.RENDER_FACTORY_OPERATOR_ID ?? DEFAULT_OPERATOR_ID;

  // Production-readiness config audit: OAuth token encryption falls back to an
  // insecure dev key when this is unset — warn loudly so it isn't shipped.
  if (!opts.disableAuth && !process.env.RENDER_FACTORY_ENCRYPTION_KEY) {
    console.warn(
      "[render-factory] RENDER_FACTORY_ENCRYPTION_KEY is not set; OAuth tokens use an INSECURE dev key. " +
        "Set a strong 32+ char secret in production.",
    );
  }
  if (!opts.disableAuth && !opts.auth && !process.env.RENDER_FACTORY_API_KEY) {
    console.warn(
      "[render-factory] RENDER_FACTORY_API_KEY is not set; all authenticated routes will reject (401). " +
        "Set the key, pass a custom `auth` resolver, or use disableAuth for local dev.",
    );
  }

  // Last-resort safety net: an uncaught exception anywhere in a route handler
  // (e.g. a store/driver failure that wasn't anticipated) must still return a
  // structured JSON error instead of Hono's bare-text 500, so API/channel
  // callers always get a parseable response. The real error is logged
  // server-side with a correlation id; callers get an opaque message.
  app.onError((err, c) => {
    const errorId = randomUUID();
    console.error(`[render-factory] unhandled error (${errorId}) on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "internal server error", errorId }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // UI shell registered before auth middleware so it stays unauthenticated.
  const uiEnabled = opts.serveUI !== false;
  if (uiEnabled) {
    app.route("/", uiRoutes());
  }

  // Browser UI authenticates once (POST /ui/login) then rides a signed httpOnly
  // cookie, so the raw key never lives in JS/URL; API callers use Bearer.
  const cookieCfg = buildCookieConfig();
  const baseResolver: AuthResolver =
    opts.auth ?? bearerKeyResolver("RENDER_FACTORY_API_KEY", operatorUserId);
  const resolver: AuthResolver = uiEnabled ? wrapWithSession(baseResolver, cookieCfg) : baseResolver;

  if (uiEnabled && !opts.disableAuth) {
    // Must precede the auth middleware.
    registerLoginRoutes(app, cookieCfg, { envKey: "RENDER_FACTORY_API_KEY", operatorUserId });
  }

  if (opts.disableAuth) {
    // Local dev: still set a principal so tenant scoping works.
    app.use("/*", async (c, next) => {
      c.set("principal", { userId: operatorUserId, role: "operator" });
      await next();
    });
  } else {
    // Public-path/query-key carve-outs live in the middleware (not route
    // ordering) so they survive refactors: OAuth callback + inbound channels
    // (own auth) via isPublicPath; SSE/OAuth-authorize via allowQueryKey since
    // they can't set headers (key still rejected elsewhere to avoid leaking
    // via logs/history/Referer — CR-05).
    app.use(
      "/*",
      apiKeyAuth({
        resolver,
        operatorUserId,
        isPublicPath: (p) => defaultPublicPath(p) || p === "/ui/login" || p === "/ui/logout",
        allowQueryKey: allowsQueryKey,
        // Per-user SSE token, minted at POST /auth/stream-token.
        streamTokenResolver: (t) => verifyStreamToken(t, cookieCfg.secret),
      }),
    );
  }

  // Every `/admin/*` route gated here at one choke point so a per-user
  // principal can never drive global maintenance (CR-D1).
  app.use("/admin/*", requireOperator());

  app.get("/whoami", (c) => c.json(getPrincipal(c)));

  // Short-lived per-user SSE token: caller authenticates normally here, then
  // opens EventSource(...?token=...) since it can't carry headers otherwise.
  app.post("/auth/stream-token", (c) => c.json(issueStreamToken(getPrincipal(c), cookieCfg.secret)));

  const store = runtime.store;
  // The loop polls runtime.cancelStore, so cancel routes must write to the same
  // store (BUG-01); an explicit override still wins (tests).
  const cancel = cancelStore ?? runtime.cancelStore;
  const wf = workflows ?? new Map();
  // HITL resume has two lanes: a paused **workflow** root re-drives via
  // dispatch/replay (Lane A); a paused **agent/chat** turn resumes via a
  // durable job or inline resumeRun (Lane B, mode chosen by submitRootRun).
  //
  // Lane A: replay-safe (memoized ctx.step + deterministic child ids), so
  // re-driving resumes from where it parked even after a container recycled.
  const redriveRoot = async (root: RunRecord): Promise<void> => {
    const def = runtime.workflows.get(root.workflow);
    const dispatcher = runtime.dispatcher;
    if (dispatcher?.dispatchRoot) {
      // Fail-fast (E6): don't leave the root stranded if the workflows host is down.
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

  // Child→parent HITL bubble: an approval gate inside a child run resolves the
  // child, but the parked run is the workflow root above it. Walk parentSpanId
  // up to the nearest paused root so its replay re-dispatches past the now-
  // resolved gate. Interim until native Workflows pause/resume lands
  // (docs/sprints/native-pause-resume.md).
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
      if (run && runtime.workflows.has(run.workflow)) {
        await redriveRoot(run);
        return;
      }
      if (run) {
        const root = await findPausedWorkflowRoot(run);
        if (root) {
          await redriveRoot(root);
          return;
        }
      }
      // Otherwise Lane B: durable resume job (queue) or inline resumeRun.
      await submitRootRun(runtime, { runId, kind: "resume", driveInline: async () => { await resumeRun(runId, runtime); } });
    });

  // Wired to a daily Render Cron.
  app.post("/admin/retention", async (c) => {
    const result = await runRetention(store);
    return c.json(result);
  });

  // Wired to a periodic Render Cron. Fails Lane A roots whose hand-off to the
  // workflows host was accepted but never progressed, so they don't sit
  // running forever (E6).
  app.post("/admin/runs/reap", async (c) => {
    const result = await reapRuns(store);
    return c.json(result);
  });

  // Lane B queue depth for operator observability; Lane A is queued by Render.
  app.get("/admin/jobs", async (c) => {
    const counts = await runtime.jobQueue.countByStatus();
    const backlog = counts.queued + counts.running;
    return c.json({ counts, backlog });
  });

  // Powers the operator UI's dispatch/schedule pickers; dispatch POST lives in runRoutes.
  app.get("/workflows", (c) => {
    const list = [...wf.keys()].map((name) => ({ name }));
    return c.json({ workflows: list, defaultWorkflow: opts.defaultWorkflow });
  });

  app.route("/", runRoutes({ store, cancelStore: cancel, workflows: wf }));

  app.route("/", scheduleRoutes({ scheduleStore: runtime.scheduleStore, workflows: wf }));

  // Merges the durable event tail with the transient token-delta bus (D13) for live streaming.
  app.route("/", streamRoutes({ store, threadStore: runtime.threadStore, deltaBus: runtime.deltaBus }));

  const awaitResume = opts.awaitResume ?? false;

  // Inline mode drives in-process and awaits here so the channel route can
  // deliver the reply in the same request. Queue mode enqueues a resume job
  // (awaited only when awaitResume is set, e.g. tests); worker delivers out of band.
  const driveResume = async (runId: string): Promise<void> => {
    const p = Promise.resolve(resume(runId)).then(() => {}).catch((err) => console.error(`resume(${runId}) failed`, err));
    if (awaitResume || runtime.executionMode === "inline") await p;
  };

  // Each user message is its own short run joined to the thread by threadId;
  // multi-turn memory comes from the thread transcript, not a parked run.
  // RunPaused (HITL within the turn) is expected, not an error.
  const startAgentRun = async (agentName: string, input: string, o: { runId: string; threadId: string; userId?: string; channel?: string; externalConversationId?: string; trigger?: string }): Promise<void> => {
    // Record the run row up front (both modes) so it's the job's FK target;
    // hasStarted() guard then avoids duplicating these events on drive.
    const def = runtime.agentDefinitions.get(agentName);
    await store.events.append(
      buildEventRecord(
        o.runId,
        { type: "run.started", input, trigger: o.trigger ?? "thread_message", threadId: o.threadId, userId: o.userId, agentVersion: def?.version, model: def?.model.model, channel: o.channel, externalConversationId: o.externalConversationId },
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
      // Inline: drive now in-process. Queue: a chat worker claims the job and
      // calls the same driveAgentTurn.
      driveInline: async () => {
        try {
          await driveAgentTurn(runtime, o.runId);
        } catch (err) {
          if (!(err instanceof RunPaused)) throw err;
        }
      },
    });
  };

  // Thread id derives deterministically from (channel, conversationId) so
  // re-entrant messages reuse it and two concurrent first-messages converge on
  // one (one-active-run index serializes into a clean 202 + 409). A pending
  // message-input (HITL) is satisfied and resumed; otherwise a new turn starts.
  const handleChannelMessage = async (
    agentName: string,
    input: unknown,
    binding: { channel: string; conversationId: string; user?: string },
  ): Promise<{ runId: string; threadId: string; status: 200 | 202 | 409; body: Record<string, unknown> }> => {
    const threadId = idempotencyKey(binding.channel, binding.conversationId);
    if (!(await runtime.threadStore.getThread(threadId))) {
      const now = new Date().toISOString();
      await runtime.threadStore.createThread({
        id: threadId,
        status: "active",
        createdAt: now,
        updatedAt: now,
        metadata: { channel: binding.channel, externalConversationId: binding.conversationId, externalUser: binding.user },
      });
    }
    const text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");

    // Continue an in-flight conversation, or reject if busy / awaiting approval.
    const active = (await store.listRuns({ threadId, limit: 50 })).find(
      (r) => r.status === "running" || r.status === "paused" || r.status === "pending",
    );
    if (active) {
      if (active.status !== "paused") {
        return { runId: active.id, threadId, status: 409, body: { error: "Conversation is busy (a turn is in flight)", runId: active.id } };
      }
      const pending = (await store.getInputs(active.id)).filter((i) => i.status === "pending");
      // Approval gates need explicit approve/deny; free-text can't satisfy them.
      if (pending.some((i) => i.kind === "approval")) {
        return { runId: active.id, threadId, status: 409, body: { error: "Run is paused awaiting approval; resolve it via the inputs API", runId: active.id } };
      }
      const pendingMessage = pending.find((i) => i.kind === "message");
      if (!pendingMessage) {
        return {
          runId: active.id,
          threadId,
          status: 409,
          body: { error: "Run is paused but has no pending message input; resolve it via the inputs API", runId: active.id },
        };
      }
      await store.events.append(
        buildEventRecord(active.id, { type: "input.provided", inputRequestId: pendingMessage.inputRequestId, kind: "message", value: text }),
      );
      await store.events.append(
        buildEventRecord(active.id, { type: "message.user", content: [{ type: "text", text }] }),
      );
      await driveResume(active.id);
      return { runId: active.id, threadId, status: 200, body: { runId: active.id, channel: binding.channel, delivered: true } };
    }

    // No active run: new channel-bound turn (binding stamped for outbound delivery).
    const runId = randomUUID();
    try {
      await startAgentRun(agentName, text, {
        runId,
        threadId,
        channel: binding.channel,
        externalConversationId: binding.conversationId,
        trigger: `channel.${binding.channel}`,
      });
    } catch (err) {
      // DB-level guard: one-active-run index rejects a concurrent second run.started.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        return { runId, threadId, status: 409, body: { error: "Conversation is busy (a turn is in flight)" } };
      }
      throw err;
    }
    return { runId, threadId, status: 202, body: { runId, channel: binding.channel, agent: agentName, threadId } };
  };

  app.route("/", threadRoutes({ store, threadStore: runtime.threadStore, workflows: wf, defaultWorkflow: opts.defaultWorkflow, defaultAgent: opts.defaultAgent, startAgentRun, resume, awaitResume }));

  app.route("/", hitlRoutes({ store, resume, awaitResume }));

  if (opts.oauthProviders && opts.oauthProviders.size > 0) {
    for (const [name, config] of opts.oauthProviders) {
      if (!runtime.oauthRefreshers.has(name)) {
        runtime.oauthRefreshers.set(name, buildRefresher(config));
      }
    }
    // userId comes from auth (never a client param) so callers see only their own connections.
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

  // opts.channels is seeded onto runtime.channels so inbound routes and outbound
  // delivery resolve the same set. Public routes: auth is the channel's
  // declarative signature policy (fail-closed via checkWebhookAuth).
  if (opts.channels) for (const [id, ch] of opts.channels) runtime.channels.set(id, ch);
  if (runtime.channels.size > 0) {
    // Inline mode has no worker/producer, so the run is already terminal when
    // the route returns — deliver inline. Queue mode delivers out of band.
    const deliver = runtime.executionMode === "inline"
      ? (runId: string) => deliverForRun(runtime, runId)
      : undefined;
    app.route("/", channelRoutes({ channels: runtime.channels, workflows: wf, handleChannelMessage, deliver }));
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

  // Front door only: in queue mode a separate runWorker service drives
  // execution, keeping ingestion decoupled from compute.
  return {
    port,
    close: () => {
      if (typeof (server as { close?: () => void }).close === "function") {
        (server as { close: () => void }).close();
      }
    },
  };
}
