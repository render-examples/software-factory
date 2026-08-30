/**
 * Shared workflow dispatch for gateway routes.
 *
 * Consolidates the slug lookup / dynamic SDK import / startTask / error
 * handling that every webhook route needs, and blob-caps oversized payload
 * fields on the way out so workflow task payloads stay small.
 *
 * The helper never writes an HTTP response — it returns a discriminated
 * result and each route maps it to its own status codes.
 */
import { maybePutBlob } from "#factory-sdk/blobs";

/**
 * Dispatched payloads may sit in a queue before the workflow reads them, so
 * their blobs outlive the default (1h) agent-output TTL.
 */
export const DISPATCH_BLOB_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export type DispatchResult =
  | { ok: true; taskName: string }
  | { ok: false; reason: "no-slug"; taskName: string }
  | { ok: false; reason: "error"; taskName: string; error: unknown };

function cap(taskName: string, step: string, value: string): Promise<string> {
  return maybePutBlob(`dispatch:${taskName}`, step, value, DISPATCH_BLOB_TTL_SECONDS);
}

/**
 * Replace oversized string fields with `$blob:` refs.
 *
 * Only known-large fields are capped (rather than the whole object) because
 * downstream workflow code reads these as plain strings. Returns a shallow
 * copy — the caller's object is never mutated.
 */
async function capPayload<T>(taskName: string, payload: T): Promise<T> {
  if (payload === null || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;

  // agentTask-style inputs ({ message, threadId, ... }) — resolved downstream
  // by agentTask's existing resolveRefs(input.message).
  if (typeof p.message === "string") {
    return { ...p, message: await cap(taskName, "message", p.message) } as T;
  }

  // NormalizedGitHubEvent — cap the free-text body fields only.
  if (p.kind === "issue") {
    const out: Record<string, unknown> = { ...p };
    const issue = p.issue as Record<string, unknown> | undefined;
    const comment = p.comment as Record<string, unknown> | undefined;
    if (issue && typeof issue.body === "string") {
      out.issue = { ...issue, body: await cap(taskName, "issue-body", issue.body) };
    }
    if (comment && typeof comment.body === "string") {
      out.comment = { ...comment, body: await cap(taskName, "comment-body", comment.body) };
    }
    return out as T;
  }

  if (p.kind === "pull") {
    const pull = p.pull as Record<string, unknown> | undefined;
    if (pull && typeof pull.body === "string") {
      return { ...p, pull: { ...pull, body: await cap(taskName, "pull-body", pull.body) } } as T;
    }
  }

  return payload;
}

/**
 * Start a workflow task under the configured workflow slug.
 *
 * @param taskName Bare task name (e.g. "assistant"); the slug is prepended.
 * @param payload  Single task argument, blob-capped before dispatch.
 */
export async function dispatchWorkflowTask<T>(
  taskName: string,
  payload: T,
): Promise<DispatchResult> {
  const slug = process.env.RENDER_WORKFLOW_SLUG;
  if (!slug) {
    console.warn(`RENDER_WORKFLOW_SLUG not set — cannot dispatch ${taskName}`);
    return { ok: false, reason: "no-slug", taskName };
  }

  // Blob storage is best-effort: if it is unavailable, dispatching the raw
  // payload beats failing the webhook outright.
  let outgoing = payload;
  try {
    outgoing = await capPayload(taskName, payload);
  } catch (err) {
    console.warn(`Failed to blob-cap payload for ${taskName}, sending raw:`, err);
  }

  try {
    const { Render } = await import("@renderinc/sdk");
    const client = new Render();
    await client.workflows.startTask(`${slug}/${taskName}`, [outgoing]);
    return { ok: true, taskName };
  } catch (error) {
    console.error(`Failed to dispatch ${taskName}:`, error);
    return { ok: false, reason: "error", taskName, error };
  }
}
