import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

/**
 * API-key bearer auth middleware. Fail-closed: missing key env or
 * missing/invalid bearer → 401. Uses constant-time comparison to
 * prevent timing leaks.
 */
export function apiKeyAuth(envKey = "RENDER_AGENTS_API_KEY") {
  return async (c: Context, next: Next) => {
    const expected = process.env[envKey];
    if (!expected) {
      return c.json({ error: "Server misconfigured: API key not set" }, 500);
    }

    const header = c.req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json({ error: "Missing or malformed Authorization header" }, 401);
    }

    const provided = header.slice(7);
    if (!constantTimeEqual(expected, provided)) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    await next();
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqual(bufA, bufB);
}
