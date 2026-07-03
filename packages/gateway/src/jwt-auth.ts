/**
 * Built-in JWT/OIDC auth resolver — the "real multi-tenancy" default.
 *
 * Verifies a `Authorization: Bearer <jwt>` against an identity provider's JWKS
 * (issuer signing keys, fetched + cached by jose), checking issuer / audience /
 * expiry / signature, then maps a configurable claim to the tenant `userId`.
 * Returns a `role: "user"` {@link Principal} by default so the caller is confined
 * to their own resources; an optional `roleFrom` can elevate to `operator`.
 *
 * It is an {@link AuthResolver} like any other, so it plugs into the gateway via
 * `createGatewayApp({ auth })` with zero route changes. To keep a shared-key
 * operator break-glass alongside per-user JWTs, compose it:
 *
 *   auth: composeResolvers(
 *     jwtAuthResolver({ issuer, audience, jwksUri }),
 *     bearerKeyResolver("RENDER_AGENTS_API_KEY", "operator"),
 *   )
 *
 * Fail-closed: any verification error (bad signature, wrong iss/aud, expired,
 * missing claim) resolves to `null` (→ 401), never a partial identity.
 */

import { jwtVerify, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AuthResolver, Principal } from "./auth.js";

export interface JwtAuthOptions {
  /** Expected token issuer (`iss`). Strongly recommended; omit to skip the check. */
  issuer?: string;
  /** Expected audience (`aud`). Strongly recommended; omit to skip the check. */
  audience?: string;
  /**
   * JWKS endpoint URL (e.g. `https://issuer/.well-known/jwks.json`). jose fetches
   * and caches the signing keys and refetches on key rotation. Required unless
   * `keySet` is provided.
   */
  jwksUri?: string;
  /**
   * Pre-built key resolver — takes precedence over `jwksUri`. Use
   * `createLocalJWKSet(jwks)` for an offline/in-process key set (tests, or a
   * statically-pinned key). Advanced; most deployments pass `jwksUri`.
   */
  keySet?: JWTVerifyGetKey;
  /** Claim mapped to the tenant `userId`. Default `"sub"`. */
  userIdClaim?: string;
  /**
   * Optional role mapping from the verified claims. Default: everyone is a
   * `"user"` (confined to their own data). Return `"operator"` to elevate (e.g.
   * an `admin` claim/role) — operators bypass ownership checks.
   */
  roleFrom?: (claims: JWTPayload) => "operator" | "user";
  /** Clock skew tolerance in seconds for exp/nbf. Default 5. */
  clockToleranceSec?: number;
}

/**
 * Build an {@link AuthResolver} that authenticates a bearer JWT against a JWKS.
 * Throws at construction if neither `jwksUri` nor `keySet` is given.
 */
export function jwtAuthResolver(opts: JwtAuthOptions): AuthResolver {
  const userIdClaim = opts.userIdClaim ?? "sub";
  const clockTolerance = opts.clockToleranceSec ?? 5;

  let getKey: JWTVerifyGetKey;
  if (opts.keySet) {
    getKey = opts.keySet;
  } else if (opts.jwksUri) {
    getKey = createRemoteJWKSet(new URL(opts.jwksUri));
  } else {
    throw new Error("jwtAuthResolver: provide `jwksUri` (a JWKS endpoint) or `keySet`");
  }

  return async (req: Request): Promise<Principal | null> => {
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return null;

    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: opts.issuer,
        audience: opts.audience,
        clockTolerance,
      });
      const raw = payload[userIdClaim];
      if (typeof raw !== "string" || raw.length === 0) return null; // no usable tenant id
      const role = opts.roleFrom ? opts.roleFrom(payload) : "user";
      return { userId: raw, role };
    } catch {
      return null; // fail closed on any verification failure
    }
  };
}
