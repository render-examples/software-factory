/**
 * Declarative inbound-signature verification for channels.
 *
 * Inbound channel routes are public, so the *signature is the authentication*.
 * A channel sets `verify` and the gateway enforces it — computing the expected
 * signature over the raw body and rejecting mismatches with 401 before the
 * request is routed. The runtime that executes these schemes lives in
 * `@render-agents/gateway` (`verify.ts`); this file is pure config (no crypto).
 *
 * Secrets are referenced by env-var *name* and read at request time — they are
 * never inlined into a `verify` config object.
 *
 * @example
 *   import { githubVerify } from "@render-agents/sdk";
 *   import type { Channel } from "@render-agents/sdk";
 *   const channel: Channel = {
 *     target: { workflow: "code-review" },
 *     verify: githubVerify(), // reads GITHUB_WEBHOOK_SECRET
 *     match(req) { ... },
 *     parse(req) { ... },
 *   };
 *   export default channel;
 */

/** Digest encoding of a signature header value. */
export type SignatureEncoding = "hex" | "base64";

/** HMAC hash algorithm. */
export type HmacAlgorithm = "sha1" | "sha256" | "sha512";

/**
 * Generic HMAC verification: `HMAC(algorithm, secret, rawBody)`, compared
 * (constant-time) against the value of `header`, after stripping `prefix`.
 * Covers most providers that sign the raw body directly.
 */
export interface HmacVerify {
  scheme: "hmac";
  /** Header carrying the signature (e.g. `"x-hub-signature-256"`). */
  header: string;
  /** Env var holding the shared secret. Read at request time; never inlined. */
  secretEnv: string;
  /** Hash algorithm. Default `"sha256"`. */
  algorithm?: HmacAlgorithm;
  /** Digest encoding of the header value. Default `"hex"`. */
  encoding?: SignatureEncoding;
  /** Literal prefix to strip from the header value (e.g. `"sha256="`). */
  prefix?: string;
}

/** GitHub webhooks: `sha256=` HMAC over the raw body in `x-hub-signature-256`. */
export interface GitHubVerify {
  scheme: "github";
  secretEnv: string;
}

/**
 * Slack Events API: `v0=` HMAC-SHA256 over `v0:{timestamp}:{rawBody}` in
 * `x-slack-signature`, with a replay window on `x-slack-request-timestamp`.
 */
export interface SlackVerify {
  scheme: "slack";
  signingSecretEnv: string;
  /** Reject requests whose timestamp is older than this many seconds. */
  toleranceSec: number;
}

/**
 * Stripe: `Stripe-Signature: t=…,v1=…` HMAC-SHA256 over `{t}.{rawBody}`, with a
 * replay window on `t`.
 */
export interface StripeVerify {
  scheme: "stripe";
  secretEnv: string;
  toleranceSec: number;
}

/**
 * Standard Webhooks (Svix-compatible): base64 HMAC-SHA256 over
 * `{webhook-id}.{webhook-timestamp}.{rawBody}` in `webhook-signature`
 * (space-separated `v1,<sig>` list), with a replay window on `webhook-timestamp`.
 * A `whsec_`-prefixed secret is base64-decoded to the signing key.
 */
export interface StandardWebhooksVerify {
  scheme: "standard-webhooks";
  secretEnv: string;
  toleranceSec: number;
}

/** Explicit opt-out: the framework performs no verification for this route. */
export interface NoVerify {
  scheme: "none";
}

/**
 * A webhook/connector verification policy. `"none"` (or `{ scheme: "none" }`)
 * explicitly opts out (e.g. the adapter authenticates internally, or the
 * endpoint is intentionally open). Omitting `verify` entirely is fail-closed:
 * rejected in production (see `RENDER_AGENTS_REQUIRE_WEBHOOK_VERIFY`).
 */
export type WebhookVerify =
  | "none"
  | NoVerify
  | HmacVerify
  | GitHubVerify
  | SlackVerify
  | StripeVerify
  | StandardWebhooksVerify;

const DEFAULT_TOLERANCE_SEC = 300;

/** Generic HMAC-over-raw-body verification. */
export function hmacVerify(opts: {
  header: string;
  secretEnv: string;
  algorithm?: HmacAlgorithm;
  encoding?: SignatureEncoding;
  prefix?: string;
}): HmacVerify {
  return { scheme: "hmac", ...opts };
}

/** GitHub webhook verification. Default secret env: `GITHUB_WEBHOOK_SECRET`. */
export function githubVerify(opts: { secretEnv?: string } = {}): GitHubVerify {
  return { scheme: "github", secretEnv: opts.secretEnv ?? "GITHUB_WEBHOOK_SECRET" };
}

/** Slack Events verification. Default secret env: `SLACK_SIGNING_SECRET`. */
export function slackVerify(opts: { signingSecretEnv?: string; toleranceSec?: number } = {}): SlackVerify {
  return {
    scheme: "slack",
    signingSecretEnv: opts.signingSecretEnv ?? "SLACK_SIGNING_SECRET",
    toleranceSec: opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC,
  };
}

/** Stripe webhook verification. Default secret env: `STRIPE_WEBHOOK_SECRET`. */
export function stripeVerify(opts: { secretEnv?: string; toleranceSec?: number } = {}): StripeVerify {
  return {
    scheme: "stripe",
    secretEnv: opts.secretEnv ?? "STRIPE_WEBHOOK_SECRET",
    toleranceSec: opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC,
  };
}

/** Standard Webhooks (Svix) verification. Default secret env: `WEBHOOK_SECRET`. */
export function standardWebhooksVerify(opts: { secretEnv?: string; toleranceSec?: number } = {}): StandardWebhooksVerify {
  return {
    scheme: "standard-webhooks",
    secretEnv: opts.secretEnv ?? "WEBHOOK_SECRET",
    toleranceSec: opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC,
  };
}
