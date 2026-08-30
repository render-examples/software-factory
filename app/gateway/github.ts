/**
 * GitHub webhook handler. Verifies signatures, normalizes events, dispatches workflows.
 */
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeGitHubEvent } from "../lib/github-events.js";

function verifyGitHubSignature(rawBody: string, headers: Headers): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  const signature = headers.get("x-hub-signature-256");
  if (!signature) return false;
  const computed = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function githubHandler(): Hono {
  const app = new Hono();

  app.post("/github", async (c) => {
    const rawBody = await c.req.text();

    if (!verifyGitHubSignature(rawBody, c.req.raw.headers)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const event = c.req.raw.headers.get("x-github-event") ?? "";
    if (!["issues", "issue_comment", "pull_request", "pull_request_review"].includes(event)) {
      return c.json({ ok: true, ignored: true });
    }

    const normalized = normalizeGitHubEvent(event, JSON.parse(rawBody));
    if (normalized.kind === "skip") {
      return c.json({ ok: true, skipped: true });
    }

    let taskName: string;
    if (event === "pull_request") {
      taskName = "pr-review";
    } else if (event === "pull_request_review") {
      taskName = "pr-fix";
    } else {
      taskName = "spec-to-pr";
    }

    const slug = process.env.RENDER_WORKFLOW_SLUG;
    if (slug) {
      try {
        const { Render } = await import("@renderinc/sdk");
        const client = new Render();
        await client.workflows.startTask(`${slug}/${taskName}`, [normalized]);
        return c.json({ dispatched: taskName }, 202);
      } catch (err) {
        console.error(`Failed to dispatch ${taskName}:`, err);
        return c.json({ error: "dispatch failed" }, 502);
      }
    }

    return c.json({ error: "RENDER_WORKFLOW_SLUG not set" }, 503);
  });

  return app;
}
