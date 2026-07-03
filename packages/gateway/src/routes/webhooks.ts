import { Hono } from "hono";
import type { WorkflowDefinition, WebhookAdapter } from "@render-agents/sdk";
import type { ConnectorSpec, ConnectorContext } from "../connector.js";
import { checkWebhookAuth } from "../verify.js";

// Canonical adapter type lives in `@render-agents/sdk`; re-exported so existing
// importers of `./routes/webhooks.js` keep working.
export type { WebhookAdapter };

/** Rebuild a body-readable Request from buffered bytes (the raw body is read once
 *  for signature verification, which locks the original stream). */
function rebuildRequest(url: string, headers: Headers, body: string): Request {
  return new Request(url, { method: "POST", headers, body });
}

/**
 * Webhook + connector routes. Webhooks are user-authored (discovered from
 * webhooks/), connectors are package-contributed (from tool connectors export).
 * Both produce a WebhookMatch → dispatch the target workflow.
 *
 * These routes are public (a third party can't present the operator API key), so
 * the inbound signature IS the authentication. The framework enforces the
 * declarative `verify` policy here — before routing or dispatch — and is
 * fail-closed: a route with no `verify` is rejected in production (see
 * `checkWebhookAuth`). Verification runs over the exact raw body bytes.
 */
export function webhookRoutes(deps: {
  webhooks: Map<string, WebhookAdapter>;
  connectors: Map<string, ConnectorSpec>;
  workflows: Map<string, WorkflowDefinition>;
}) {
  const app = new Hono();
  const { webhooks, connectors, workflows } = deps;

  // POST /webhooks/:name — user-authored webhook dispatch
  app.post("/webhooks/:name", async (c) => {
    const name = c.req.param("name");
    const adapter = webhooks.get(name);
    if (!adapter) {
      return c.json({ error: `Webhook "${name}" not found` }, 404);
    }

    // Read the raw body once (verification needs the exact bytes; this locks the
    // original request stream, so downstream reads use rebuilt Requests).
    const rawBody = await c.req.raw.text();
    const headers = c.req.raw.headers;
    const url = c.req.raw.url;

    const auth = checkWebhookAuth(adapter.verify, `webhook "${name}"`, { rawBody, headers });
    if (!auth.ok) {
      return c.json({ error: auth.reason }, auth.status);
    }

    const match = adapter.match(rebuildRequest(url, headers, rawBody));
    if (!match) {
      return c.json({ error: "Webhook did not match" }, 400);
    }

    const workflow = workflows.get(match.workflow);
    if (!workflow) {
      return c.json({ error: `Target workflow "${match.workflow}" not found` }, 404);
    }

    const input = await adapter.parse(rebuildRequest(url, headers, rawBody));
    const run = await workflow.dispatch(input, match.trigger);
    return c.json({ runId: run.id, workflow: match.workflow, trigger: match.trigger }, 202);
  });

  // POST /connectors/:key — package-contributed connector dispatch
  app.post("/connectors/:key", async (c) => {
    const key = c.req.param("key");
    const connector = connectors.get(key);
    if (!connector) {
      return c.json({ error: `Connector "${key}" not found` }, 404);
    }

    const rawBody = await c.req.raw.text();
    const headers = c.req.raw.headers;
    const url = c.req.raw.url;

    const auth = checkWebhookAuth(connector.verify, `connector "${key}"`, { rawBody, headers });
    if (!auth.ok) {
      return c.json({ error: auth.reason }, auth.status);
    }

    const ctx: ConnectorContext = {
      env: (envName) => process.env[envName],
      logger: { debug: () => {}, info: () => {}, warn: console.warn, error: console.error },
    };

    const match = await connector.handle(rebuildRequest(url, headers, rawBody), ctx);
    if (!match) {
      return c.json({ error: "Connector did not match" }, 400);
    }

    const workflow = workflows.get(match.workflow);
    if (!workflow) {
      return c.json({ error: `Target workflow "${match.workflow}" not found` }, 404);
    }

    const run = await workflow.dispatch(rebuildRequest(url, headers, rawBody), match.trigger);
    return c.json({ runId: run.id, workflow: match.workflow, trigger: match.trigger }, 202);
  });

  return app;
}
