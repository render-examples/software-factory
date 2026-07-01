/**
 * Cookie-session layer for the operator UI.
 *
 * `apiKeyAuth` resolves a `Bearer <key>` to a {@link Principal}. A browser UI
 * needs the same identity without pasting the bearer on every request (and
 * without ever holding the raw key in JS, where XSS could steal it). So we layer
 * a signed, httpOnly cookie on top:
 *
 *   1. Browser POSTs the key to `/ui/login`.
 *   2. We validate it against `RENDER_AGENTS_API_KEY` (constant time).
 *   3. On success we set a signed cookie carrying the resolved `userId|role`.
 *   4. {@link wrapWithSession} makes the auth resolver accept the cookie OR the
 *      bearer header — so `curl` ops keep working and browsers stay logged in.
 *      EventSource carries the cookie automatically (same-origin), so SSE no
 *      longer needs the key in the URL.
 *
 * The signing secret comes from `RENDER_AGENTS_COOKIE_SECRET`, falling back to
 * `RENDER_AGENTS_ENCRYPTION_KEY`. If neither is set we generate a per-process
 * secret and warn — fine for dev, but cookies don't survive a restart.
 */

import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { type AuthResolver, type Principal, constantTimeEqual } from "./auth.js";

const COOKIE_NAME = "render_agents_session";
const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface CookieConfig {
  name: string;
  secret: string;
  maxAge: number;
  secure: boolean;
}

let warnedEphemeral = false;

export function buildCookieConfig(overrides: Partial<CookieConfig> = {}): CookieConfig {
  const secret =
    overrides.secret ??
    process.env.RENDER_AGENTS_COOKIE_SECRET ??
    process.env.RENDER_AGENTS_ENCRYPTION_KEY ??
    ephemeralSecret();
  return {
    name: overrides.name ?? COOKIE_NAME,
    secret,
    maxAge: overrides.maxAge ?? DEFAULT_MAX_AGE_SECONDS,
    secure: overrides.secure ?? process.env.NODE_ENV === "production",
  };
}

/** Read + verify the signed session cookie, returning the Principal or null. */
export async function readSessionCookie(req: Request, cfg: CookieConfig): Promise<Principal | null> {
  // Hono's cookie helpers only read `c.req.raw.headers` under the hood; a minimal
  // shim lets us reuse their verified-cookie parsing without a full Context.
  const shim = { req: { raw: req } } as unknown as Context;
  let value: string | false | undefined;
  try {
    value = await getSignedCookie(shim, cfg.secret, cfg.name);
  } catch {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const [userId, role] = value.split("|");
  if (!userId) return null;
  return { userId, role: role === "user" ? "user" : "operator" };
}

/** Wrap an upstream resolver so it also accepts the signed session cookie. */
export function wrapWithSession(upstream: AuthResolver, cfg: CookieConfig): AuthResolver {
  return async (req: Request) => (await readSessionCookie(req, cfg)) ?? upstream(req);
}

export async function issueSession(c: Context, cfg: CookieConfig, principal: Principal): Promise<void> {
  await setSignedCookie(c, cfg.name, `${principal.userId}|${principal.role}`, cfg.secret, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: cfg.secure,
    maxAge: cfg.maxAge,
  });
}

export function clearSession(c: Context, cfg: CookieConfig): void {
  deleteCookie(c, cfg.name, { path: "/" });
}

/**
 * Register the public `/ui/login` + `/ui/logout` routes. Must be mounted BEFORE
 * the auth middleware — login authenticates itself by validating the key.
 */
export function registerLoginRoutes(
  app: Hono,
  cfg: CookieConfig,
  opts: { envKey: string; operatorUserId: string },
): void {
  app.post("/ui/login", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
    const key = typeof body?.key === "string" ? body.key : "";
    const expected = process.env[opts.envKey];
    if (!expected) return c.json({ error: "Server misconfigured: API key not set" }, 503);
    if (!key || !constantTimeEqual(expected, key)) {
      return c.json({ error: "invalid key" }, 401);
    }
    const principal: Principal = { userId: opts.operatorUserId, role: "operator" };
    await issueSession(c, cfg, principal);
    return c.json({ ok: true, userId: principal.userId, role: principal.role });
  });

  app.post("/ui/logout", (c) => {
    clearSession(c, cfg);
    return c.json({ ok: true });
  });
}

function ephemeralSecret(): string {
  if (!warnedEphemeral) {
    warnedEphemeral = true;
    console.warn(
      "[render-agents] no RENDER_AGENTS_COOKIE_SECRET / RENDER_AGENTS_ENCRYPTION_KEY set; " +
        "UI session cookies use a per-process secret and won't survive a restart.",
    );
  }
  return randomBytes(32).toString("hex");
}
