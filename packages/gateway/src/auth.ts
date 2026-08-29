import { timingSafeEqual, createHash } from "node:crypto";
import type { Context, Next } from "hono";

// --- Types ---

/** Make the resolved principal available (and typed) on every Hono context. */
declare module "hono" {
  interface ContextVariableMap {
    principal?: Principal;
  }
}

/**
 * The authenticated caller. `userId` is the tenant boundary used to scope every
 * read/write; it is ALWAYS derived from the request (never a client-supplied
 * param). `role` distinguishes the shared-key operator (an operator console that
 * sees everything) from an end user (scoped to their own data) — so plugging in
 * a real per-user resolver later yields true multi-tenancy without touching the
 * routes.
 */
export interface Principal {
  userId: string;
  role: "operator" | "user";
}

/** Resolve a request to a Principal, or null to reject. Pluggable: the default
 *  reads a shared bearer key; override for JWT / session / per-tenant keys. */
export type AuthResolver = (req: Request) => Promise<Principal | null>;

/** userId assigned to the shared-key operator when none is configured. */
export const DEFAULT_OPERATOR_ID = "operator";

export interface ApiKeyAuthOptions {
  /** Env var holding the expected key (default `RENDER_FACTORY_API_KEY`). */
  envKey?: string;
  /** userId assigned on a successful shared-key auth (default `RENDER_FACTORY_OPERATOR_ID` env → `"operator"`). */
  operatorUserId?: string;
  /**
   * Custom resolver (e.g. cookie session or JWT). When set it takes precedence;
   * the shared-key `?key=` fallback still applies on allowlisted SSE paths.
   */
  resolver?: AuthResolver;
  /**
   * Paths that bypass auth entirely — they carry their own authentication
   * (OAuth callback → signed `state`; channels → the channel's signature policy).
   */
  isPublicPath?: (path: string) => boolean;
  /** Paths that may present the key via `?key=` (SSE + OAuth authorize). */
  allowQueryKey?: (path: string) => boolean;
  /**
   * Verify a per-user stream token from `?token=` on `allowQueryKey` paths — the
   * per-user SSE credential (EventSource can't send an Authorization header). Takes
   * precedence over the shared-key `?key=` operator fallback. See `stream-token.ts`.
   */
  streamTokenResolver?: (token: string) => Principal | null;
}

// --- Auth Middleware ---

/**
 * API-key bearer auth middleware. Resolves the caller to a {@link Principal} and
 * stashes it on the context (`c.get("principal")`). Fail-closed: an unresolved
 * caller on a protected path → 401. Uses constant-time comparison over
 * fixed-width digests to prevent timing/length leaks.
 */
export function apiKeyAuth(options: ApiKeyAuthOptions = {}) {
  const envKey = options.envKey ?? "RENDER_FACTORY_API_KEY";
  const operatorUserId =
    options.operatorUserId ?? process.env.RENDER_FACTORY_OPERATOR_ID ?? DEFAULT_OPERATOR_ID;
  const isPublicPath = options.isPublicPath ?? (() => false);
  const allowQueryKey = options.allowQueryKey ?? (() => false);
  const resolver = options.resolver ?? bearerKeyResolver(envKey, operatorUserId);

  return async (c: Context, next: Next) => {
    const path = c.req.path;
    if (isPublicPath(path)) return next();

    let principal = await resolver(c.req.raw);
    // EventSource/full-page nav can't set an Authorization header, so accept a
    // query credential on allowlisted paths only (CR-05): per-user stream token
    // preferred, falling back to the shared operator key.
    if (!principal && allowQueryKey(path)) {
      const token = c.req.query("token");
      if (token && options.streamTokenResolver) {
        principal = options.streamTokenResolver(token);
      }
      if (!principal) {
        principal = queryKeyPrincipal(c.req.query("key"), envKey, operatorUserId);
      }
    }
    if (!principal) return c.json({ error: "unauthorized" }, 401);

    c.set("principal", principal);
    await next();
  };
}

// --- Resolvers ---

/** Default resolver: `Authorization: Bearer <key>` validated against the shared
 *  key. Returns an operator principal on success, null otherwise (fail closed
 *  when the key env is unset). */
export function bearerKeyResolver(envKey: string, operatorUserId: string): AuthResolver {
  return async (req: Request) => {
    const expected = process.env[envKey];
    if (!expected) return null;
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const presented = header.slice("Bearer ".length).trim();
    return constantTimeEqual(expected, presented)
      ? { userId: operatorUserId, role: "operator" }
      : null;
  };
}

/**
 * Compose resolvers into one; the first to return a non-null {@link Principal}
 * wins. Lets a deployment run per-user JWT auth with a shared-key operator
 * break-glass side by side: `composeResolvers(jwtAuthResolver(...), bearerKeyResolver(...))`.
 */
export function composeResolvers(...resolvers: AuthResolver[]): AuthResolver {
  return async (req: Request) => {
    for (const resolve of resolvers) {
      const principal = await resolve(req);
      if (principal) return principal;
    }
    return null;
  };
}

function queryKeyPrincipal(
  key: string | undefined,
  envKey: string,
  operatorUserId: string,
): Principal | null {
  const expected = process.env[envKey];
  if (!key || !expected) return null;
  return constantTimeEqual(expected, key) ? { userId: operatorUserId, role: "operator" } : null;
}

// --- Access Control ---

/** Read the resolved principal, defaulting to a local operator when auth is
 *  disabled (dev) or the route ran without the middleware (tests). */
export function getPrincipal(c: Context): Principal {
  return c.get("principal") ?? { userId: DEFAULT_OPERATOR_ID, role: "operator" };
}

/**
 * Middleware restricting a route group to operators — the control plane
 * (`/admin/*`: retention, run reaper, queue depth, schedule tick) must never be
 * reachable by an end user (`role: "user"`), even with a valid per-user token.
 * 403 for non-operators. Mount AFTER the auth middleware so the principal is set.
 */
export function requireOperator() {
  return async (c: Context, next: Next) => {
    if (getPrincipal(c).role !== "operator") {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}

/**
 * Ownership check for tenant-scoped reads. Operators (shared key) see everything
 * — this is an operator console. End users are confined to records they own.
 */
export function canAccess(ownerUserId: string | undefined | null, principal: Principal): boolean {
  if (principal.role === "operator") return true;
  return ownerUserId != null && ownerUserId === principal.userId;
}

// --- Path Matchers ---

/** Default public-path matcher: OAuth callback + inbound channels (signature-authed). */
export function defaultPublicPath(path: string): boolean {
  return (
    /^\/oauth\/[^/]+\/callback$/.test(path) ||
    path.startsWith("/channels/")
  );
}

/**
 * Default `?key=` allowlist: the browser-navigation endpoints that cannot set an
 * `Authorization` header — SSE streams (EventSource) and the OAuth authorize
 * redirect (a full-page navigation).
 */
export function allowsQueryKey(path: string): boolean {
  return (
    path === "/events/stream" ||
    path.endsWith("/stream") ||
    /^\/oauth\/[^/]+\/authorize$/.test(path)
  );
}

// --- Crypto ---

/**
 * Constant-time key comparison. Hashes both sides to a fixed 32-byte digest so
 * neither the comparison result nor its timing reveals the expected key length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
