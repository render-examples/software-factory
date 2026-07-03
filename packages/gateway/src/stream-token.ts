/**
 * Short-lived, signed per-user stream tokens for SSE.
 *
 * EventSource can't set an `Authorization` header, so browser/agent clients can't
 * present a JWT (or any bearer) on an SSE connection. The shared-key `?key=`
 * fallback only yields an operator, which is unsafe in a per-user deployment. This
 * closes that gap: an authenticated caller mints a short-lived token bound to
 * their {@link Principal} (via `POST /auth/stream-token`), then opens
 * `EventSource(/runs/:id/stream?token=...)`. The scoped stream handlers still
 * enforce `canAccess`, so the token only widens *how* identity is presented, never
 * *what* it can read.
 *
 * Token = `base64url(userId|role|expiresAt)` + "." + HMAC-SHA256(payload, secret),
 * signed with the gateway's cookie/session secret. Stateless (no store), so it is
 * deliberately short-lived (~60s) — long enough to open a stream, too short to be
 * a useful leaked credential.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal } from "./auth.js";

/** Default token lifetime — enough to open an EventSource, short enough to be low-risk. */
export const DEFAULT_STREAM_TOKEN_TTL_MS = 60_000;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mint a signed stream token for a principal. Returns the token + its TTL. */
export function issueStreamToken(
  principal: Principal,
  secret: string,
  ttlMs: number = DEFAULT_STREAM_TOKEN_TTL_MS,
): { token: string; expiresInMs: number } {
  const expiresAt = Date.now() + ttlMs;
  const payload = Buffer.from(`${principal.userId}|${principal.role}|${expiresAt}`, "utf8").toString("base64url");
  return { token: `${payload}.${sign(payload, secret)}`, expiresInMs: ttlMs };
}

/**
 * Verify a stream token, returning the {@link Principal} or `null` (bad
 * signature, malformed, or expired). Constant-time signature comparison.
 */
export function verifyStreamToken(
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): Principal | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  // Constant-time compare against the expected signature (length-guarded).
  const expected = sign(payload, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [userId, role, expiresAtStr] = decoded.split("|");
  if (!userId || !expiresAtStr) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || now > expiresAt) return null;
  return { userId, role: role === "operator" ? "operator" : "user" };
}
