import { timingSafeEqual, createHash } from "node:crypto";
import type { Context, Next } from "hono";

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
  /** Env var holding the expected key (default `RENDER_AGENTS_API_KEY`). */
  envKey?: string;
  /** userId assigned on a successful shared-key auth (default `RENDER_AGENTS_OPERATOR_ID` env → `"operator"`). */
  operatorUserId?: string;
  /**
   * Custom resolver (e.g. cookie session or JWT). When set it takes precedence;
   * the shared-key `?key=` fallback still applies on allowlisted SSE paths.
   */
  resolver?: AuthResolver;
  /**
   * Paths that bypass auth entirely — they carry their own authentication
   * (OAuth callback → signed `state`; webhooks/connectors → adapter signatures).
   */
  isPublicPath?: (path: string) => boolean;
  /** Paths that may present the key via `?key=` (SSE + OAuth authorize). */
  allowQueryKey?: (path: string) => boolean;
}

/**
 * API-key bearer auth middleware. Resolves the caller to a {@link Principal} and
 * stashes it on the context (`c.get("principal")`). Fail-closed: an unresolved
 * caller on a protected path → 401. Uses constant-time comparison over
 * fixed-width digests to prevent timing/length leaks.
 */
export function apiKeyAuth(options: ApiKeyAuthOptions = {}) {
  const envKey = options.envKey ?? "RENDER_AGENTS_API_KEY";
  const operatorUserId =
    options.operatorUserId ?? process.env.RENDER_AGENTS_OPERATOR_ID ?? DEFAULT_OPERATOR_ID;
  const isPublicPath = options.isPublicPath ?? (() => false);
  const allowQueryKey = options.allowQueryKey ?? (() => false);
  const resolver = options.resolver ?? bearerKeyResolver(envKey, operatorUserId);

  return async (c: Context, next: Next) => {
    const path = c.req.path;
    if (isPublicPath(path)) return next();

    let principal = await resolver(c.req.raw);
    // SSE / authorize fallback: EventSource and full-page navigations can't set
    // an Authorization header, so accept the shared key via `?key=` on the
    // allowlisted paths only (CR-05). Cookie sessions ride EventSource for free.
    if (!principal && allowQueryKey(path)) {
      principal = queryKeyPrincipal(c.req.query("key"), envKey, operatorUserId);
    }
    if (!principal) return c.json({ error: "unauthorized" }, 401);

    c.set("principal", principal);
    await next();
  };
}

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

function queryKeyPrincipal(
  key: string | undefined,
  envKey: string,
  operatorUserId: string,
): Principal | null {
  const expected = process.env[envKey];
  if (!key || !expected) return null;
  return constantTimeEqual(expected, key) ? { userId: operatorUserId, role: "operator" } : null;
}

/** Read the resolved principal, defaulting to a local operator when auth is
 *  disabled (dev) or the route ran without the middleware (tests). */
export function getPrincipal(c: Context): Principal {
  return c.get("principal") ?? { userId: DEFAULT_OPERATOR_ID, role: "operator" };
}

/**
 * Ownership check for tenant-scoped reads. Operators (shared key) see everything
 * — this is an operator console. End users are confined to records they own.
 */
export function canAccess(ownerUserId: string | undefined | null, principal: Principal): boolean {
  if (principal.role === "operator") return true;
  return ownerUserId != null && ownerUserId === principal.userId;
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
 * redirect (a full-page navigation).
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
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
