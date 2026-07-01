import { timingSafeEqual, createHash } from "node:crypto";
import type { Context, Next } from "hono";

export interface ApiKeyAuthOptions {
  /** Env var holding the expected key (default `RENDER_AGENTS_API_KEY`). */
  envKey?: string;
  /**
   * Requests whose path matches bypass API-key auth entirely. These endpoints
   * carry their own authentication: the OAuth callback is authenticated by its
   * HMAC-signed `state`, and inbound webhooks/connectors authenticate via
   * adapter-level signature verification (they are called by third parties that
   * cannot present the operator bearer token). See CR-01.
   */
  isPublicPath?: (path: string) => boolean;
  /**
   * Requests whose path matches may present the key via a `?key=` query param.
   * Restricted to SSE endpoints, since `EventSource` cannot set an
   * `Authorization` header. Every other route requires the Bearer header so the
   * key never lands in logs/history/`Referer`. See CR-05.
   */
  allowQueryKey?: (path: string) => boolean;
}

/**
 * API-key bearer auth middleware. Fail-closed: missing key env or
 * missing/invalid bearer → 401/500. Uses constant-time comparison over
 * fixed-width digests to prevent timing/length leaks.
 */
export function apiKeyAuth(options: ApiKeyAuthOptions = {}) {
  const envKey = options.envKey ?? "RENDER_AGENTS_API_KEY";
  const isPublicPath = options.isPublicPath ?? (() => false);
  const allowQueryKey = options.allowQueryKey ?? (() => false);

  return async (c: Context, next: Next) => {
    const path = c.req.path;
    if (isPublicPath(path)) {
      return next();
    }

    const expected = process.env[envKey];
    if (!expected) {
      return c.json({ error: "Server misconfigured: API key not set" }, 500);
    }

    const header = c.req.header("authorization");
    let provided: string | undefined;
    if (header && header.startsWith("Bearer ")) {
      provided = header.slice(7);
    } else if (allowQueryKey(path)) {
      provided = c.req.query("key");
    }

    if (!provided) {
      return c.json({ error: "Missing or malformed Authorization header" }, 401);
    }
    if (!constantTimeEqual(expected, provided)) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    await next();
  };
}

/** Default public-path matcher: OAuth callback + inbound webhooks/connectors. */
export function defaultPublicPath(path: string): boolean {
  return (
    /^\/oauth\/[^/]+\/callback$/.test(path) ||
    path.startsWith("/webhooks/") ||
    path.startsWith("/connectors/")
  );
}

/**
 * Default `?key=` allowlist: the browser-navigation endpoints that cannot set an
 * `Authorization` header — SSE streams (EventSource) and the OAuth authorize
 * redirect (a full-page navigation). Every other route requires the Bearer
 * header so the key can't leak via logs/history (CR-05).
 */
export function allowsQueryKey(path: string): boolean {
  return (
    path === "/events/stream" ||
    path.endsWith("/stream") ||
    /^\/oauth\/[^/]+\/authorize$/.test(path)
  );
}

/**
 * Constant-time key comparison. Hashes both sides to a fixed 32-byte digest so
 * neither the comparison result nor its timing reveals the expected key length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
