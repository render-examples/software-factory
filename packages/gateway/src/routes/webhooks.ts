import { Hono } from "hono";
import type { WorkflowDefinition } from "@render-agents/sdk";
import type { ConnectorSpec, ConnectorContext } from "../connector.js";

export interface WebhookAdapter {
  readonly name: string;
  match(req: Request): { workflow: string; trigger: string } | null;
  parse(req: Request): Promise<unknown>;
}

/**
 * Webhook + connector routes. Webhooks are user-authored (discovered from
 * webhooks/), connectors are package-contributed (from tool connectors export).
 * Both produce a WebhookMatch → dispatch the target workflow.
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

    const match = adapter.match(c.req.raw);
    if (!match) {
      return c.json({ error: "Webhook did not match" }, 400);
    }

    const workflow = workflows.get(match.workflow);
    if (!workflow) {
      return c.json({ error: `Target workflow "${match.workflow}" not found` }, 404);
    }

    const input = await adapter.parse(c.req.raw);
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

    const ctx: ConnectorContext = {
      env: (name) => process.env[name],
      logger: { debug: () => {}, info: () => {}, warn: console.warn, error: console.error },
    };

    const match = await connector.handle(c.req.raw, ctx);
    if (!match) {
      return c.json({ error: "Connector did not match" }, 400);
    }

    const workflow = workflows.get(match.workflow);
    if (!workflow) {
      return c.json({ error: `Target workflow "${match.workflow}" not found` }, 404);
    }

    const run = await workflow.dispatch(c.req.raw, match.trigger);
    return c.json({ runId: run.id, workflow: match.workflow, trigger: match.trigger }, 202);
  });

  return app;
}
