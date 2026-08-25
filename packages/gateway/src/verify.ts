/**
 * Runtime enforcement of inbound webhook/connector signature verification.
 *
 * The authored, declarative policy (`WebhookVerify`) lives in
 * `@render-factory/sdk`; this module executes it: it recomputes the expected
 * signature over the *raw* request body and compares it (constant-time) against
 * the provider's signature header, applying a replay window where the scheme
 * carries a timestamp. The webhook/connector routes call {@link checkWebhookAuth}
 * before routing or dispatching, so an unverified request never reaches a
 * workflow.
 */

import { createHmac } from "node:crypto";
import type {
  WebhookVerify,
  HmacVerify,
  SlackVerify,
  StripeVerify,
  StandardWebhooksVerify,
  HmacAlgorithm,
  SignatureEncoding,
} from "@render-factory/sdk";
import { constantTimeEqual } from "./auth.js";

/** Env var that forces webhook verification to be required (fail-closed). */
export const REQUIRE_WEBHOOK_VERIFY_ENV = "RENDER_FACTORY_REQUIRE_WEBHOOK_VERIFY";

export interface VerifyContext {
  /** The exact raw request body bytes as text (never a re-serialized parse). */
  rawBody: string;
  headers: Headers;
  /** Unix milliseconds; injectable for tests. Defaults to `Date.now()`. */
  now?: number;
  /** Secret accessor; injectable for tests. Defaults to `process.env`. */
  env?: (name: string) => string | undefined;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

function readEnv(ctx: VerifyContext, name: string): string | undefined {
  return (ctx.env ?? ((n) => process.env[n]))(name);
}

function hmac(
  algorithm: HmacAlgorithm,
  key: string | Buffer,
  data: string,
  encoding: SignatureEncoding,
): string {
  return createHmac(algorithm, key).update(data, "utf8").digest(encoding);
}

function skewSeconds(ctx: VerifyContext, unixSeconds: number): number {
  return Math.abs((ctx.now ?? Date.now()) / 1000 - unixSeconds);
}

/**
 * Verify a single request against a `WebhookVerify` policy. Returns `{ ok }` or a
 * machine-usable `reason`. `"none"` always passes (explicit opt-out).
 */
export function verifyWebhookRequest(verify: WebhookVerify, ctx: VerifyContext): VerifyResult {
  if (verify === "none" || (typeof verify === "object" && verify.scheme === "none")) {
    return { ok: true };
  }
  switch (verify.scheme) {
    case "hmac":
      return verifyHmac(verify, ctx);
    case "github":
      return verifyHmac(
        {
          scheme: "hmac",
          header: "x-hub-signature-256",
          secretEnv: verify.secretEnv,
          algorithm: "sha256",
          encoding: "hex",
          prefix: "sha256=",
        },
        ctx,
      );
    case "slack":
      return verifySlack(verify, ctx);
    case "stripe":
      return verifyStripe(verify, ctx);
    case "standard-webhooks":
      return verifyStandardWebhooks(verify, ctx);
    default:
      return { ok: false, reason: "unknown verification scheme" };
  }
}

function verifyHmac(v: HmacVerify, ctx: VerifyContext): VerifyResult {
  const secret = readEnv(ctx, v.secretEnv);
  if (!secret) return { ok: false, reason: `secret env "${v.secretEnv}" is not set` };
  const provided = ctx.headers.get(v.header);
  if (!provided) return { ok: false, reason: `missing signature header "${v.header}"` };
  const expected = (v.prefix ?? "") + hmac(v.algorithm ?? "sha256", secret, ctx.rawBody, v.encoding ?? "hex");
  return constantTimeEqual(expected, provided)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

function verifySlack(v: SlackVerify, ctx: VerifyContext): VerifyResult {
  const secret = readEnv(ctx, v.signingSecretEnv);
  if (!secret) return { ok: false, reason: `secret env "${v.signingSecretEnv}" is not set` };
  const sig = ctx.headers.get("x-slack-signature");
  const ts = ctx.headers.get("x-slack-request-timestamp");
  if (!sig) return { ok: false, reason: "missing x-slack-signature" };
  if (!ts) return { ok: false, reason: "missing x-slack-request-timestamp" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "invalid x-slack-request-timestamp" };
  if (skewSeconds(ctx, tsNum) > v.toleranceSec) {
    return { ok: false, reason: "timestamp outside tolerance (possible replay)" };
  }
  const expected = "v0=" + hmac("sha256", secret, `v0:${ts}:${ctx.rawBody}`, "hex");
  return constantTimeEqual(expected, sig) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

function verifyStripe(v: StripeVerify, ctx: VerifyContext): VerifyResult {
  const secret = readEnv(ctx, v.secretEnv);
  if (!secret) return { ok: false, reason: `secret env "${v.secretEnv}" is not set` };
  const header = ctx.headers.get("stripe-signature");
  if (!header) return { ok: false, reason: "missing stripe-signature" };

  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (k === "t") t = val;
    else if (k === "v1") v1.push(val);
  }
  if (!t) return { ok: false, reason: "missing t in stripe-signature" };
  if (v1.length === 0) return { ok: false, reason: "missing v1 in stripe-signature" };
  const tsNum = Number(t);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "invalid t in stripe-signature" };
  if (skewSeconds(ctx, tsNum) > v.toleranceSec) {
    return { ok: false, reason: "timestamp outside tolerance (possible replay)" };
  }
  const expected = hmac("sha256", secret, `${t}.${ctx.rawBody}`, "hex");
  for (const candidate of v1) {
    if (constantTimeEqual(expected, candidate)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

function verifyStandardWebhooks(v: StandardWebhooksVerify, ctx: VerifyContext): VerifyResult {
  const secretRaw = readEnv(ctx, v.secretEnv);
  if (!secretRaw) return { ok: false, reason: `secret env "${v.secretEnv}" is not set` };
  const id = ctx.headers.get("webhook-id");
  const ts = ctx.headers.get("webhook-timestamp");
  const sigHeader = ctx.headers.get("webhook-signature");
  if (!id) return { ok: false, reason: "missing webhook-id" };
  if (!ts) return { ok: false, reason: "missing webhook-timestamp" };
  if (!sigHeader) return { ok: false, reason: "missing webhook-signature" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: "invalid webhook-timestamp" };
  if (skewSeconds(ctx, tsNum) > v.toleranceSec) {
    return { ok: false, reason: "timestamp outside tolerance (possible replay)" };
  }
  // Standard Webhooks secrets are conventionally `whsec_<base64>`; the signing
  // key is the decoded bytes. A bare secret is used as raw utf8.
  const key = secretRaw.startsWith("whsec_")
    ? Buffer.from(secretRaw.slice("whsec_".length), "base64")
    : Buffer.from(secretRaw, "utf8");
  const expected = hmac("sha256", key, `${id}.${ts}.${ctx.rawBody}`, "base64");
  // Header is a space-separated list of `v1,<base64sig>` entries.
  for (const entry of sigHeader.split(" ")) {
    const comma = entry.indexOf(",");
    const sig = comma === -1 ? entry : entry.slice(comma + 1);
    if (constantTimeEqual(expected, sig)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

/**
 * Whether a missing `verify` should be rejected. Mirrors the strict-approval
 * idiom: an explicit env value forces on/off; otherwise it defaults on in
 * production and off in dev/test.
 */
export function webhookVerifyRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[REQUIRE_WEBHOOK_VERIFY_ENV];
  const disabled = raw === "0" || (raw ?? "").toLowerCase() === "false";
  const enabled = raw !== undefined && raw !== "" && !disabled;
  return enabled || (env.NODE_ENV === "production" && !disabled);
}

export type WebhookAuthCheck = { ok: true } | { ok: false; status: 401; reason: string };

/**
 * Enforce the verification policy for one inbound request. Configured `verify` is
 * always executed; a missing `verify` is fail-closed per {@link webhookVerifyRequired}
 * (rejected in production, warned in dev). `label` names the route for errors/logs.
 */
export function checkWebhookAuth(
  verify: WebhookVerify | undefined,
  label: string,
  ctx: VerifyContext,
): WebhookAuthCheck {
  if (verify === undefined) {
    if (webhookVerifyRequired()) {
      return {
        ok: false,
        status: 401,
        reason:
          `${label} has no \`verify\` configured (required in production). ` +
          `Add a verify (e.g. githubVerify()) or set verify: "none" to opt out.`,
      };
    }
    console.warn(
      `[render-factory] ${label} has no \`verify\` configured; inbound requests are ` +
        `UNAUTHENTICATED. Add a verify (e.g. githubVerify()) or set verify: "none".`,
    );
    return { ok: true };
  }
  const res = verifyWebhookRequest(verify, ctx);
  return res.ok ? { ok: true } : { ok: false, status: 401, reason: res.reason };
}
