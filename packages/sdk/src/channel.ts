// Channels — the single inbound/outbound message surface (supersedes the old
// `webhooks/` + `connectors/` concepts). A channel is the edge adapter between
// an external platform and an agent/workflow: it verifies + normalizes an
// inbound event into a turn, and (optionally) delivers the reply back out.
//
// Discovered by convention from `channels/*.ts` (default export a `Channel`;
// the file stem is the channel id) via `loadChannels`, mounted by the gateway
// at `POST /channels/:id`, and attached to the runtime (`runtime.channels`) so
// the outbound-delivery path can resolve `deliver` by channel id.
//
// Inbound verification reuses the declarative `WebhookVerify` surface (the one
// piece that survives the webhooks→channels merge). An inbound-only channel
// (no `deliver`) is exactly a fire-and-forget trigger — the former webhook.

import type { Logger } from "@render-agents/store";
import type { OAuthTokens } from "@render-agents/engine";
import type { WebhookVerify } from "./webhook-verify.js";

/** What drives the turn an inbound event starts. */
export type ChannelTarget =
  | { agent: string }
  | { workflow: string; trigger?: string };

/**
 * The routing decision `match` returns:
 * - `{ event }` — a recognized event; proceed to `parse`/dispatch.
 * - `{ ack }` — answer inline (a provider handshake like Slack `url_verification`,
 *   or a valid-but-ignored delivery we acknowledge so the provider stops retrying)
 *   without starting a run.
 * - `null` — not for this channel → the gateway responds `400`.
 */
export type ChannelMatch = { ack: Response } | { event: string } | null;

/** The normalized result of `parse` — a verified inbound event turned into a turn. */
export interface ChannelInboundEvent {
  /**
   * Stable id of the conversation on the external surface (Slack `channel:ts`,
   * GitHub issue number, email thread id). Used to bind the run to a
   * conversation so re-entrant messages resume it and replies are addressable.
   */
  conversationId: string;
  /** Normalized user message / workflow input. */
  input: unknown;
  /** External author login/id, for attribution + loop-guard. */
  user?: string;
  /** Overrides the channel's default `target` for this event. */
  target?: ChannelTarget;
}

/** Context handed to `deliver` when pushing a reply — or an input prompt — to the surface. */
export interface ChannelDeliverContext {
  /** The external conversation to reply into (from the run's channel binding). */
  conversationId: string;
  /**
   * The assembled outbound message. For a final reply it's the assistant text +
   * structured result; for an input prompt (see `input`) it's the question /
   * approval prompt text.
   */
  message: { text: string; data?: unknown };
  /**
   * Present when the run PAUSED awaiting human input (HITL) rather than completing
   * — so the channel can render an approval (e.g. buttons) or a question. The
   * human's next inbound message on this conversation satisfies it. Absent for a
   * final reply.
   */
  input?: { inputRequestId: string; kind: "approval" | "message"; prompt?: string; toolName?: string };
  /** Read a (never-inlined) secret by env-var name. */
  env(name: string): string | undefined;
  readonly logger: Logger;
  /** Resolve an OAuth connection for the acting user, when the surface needs one. */
  connection?(provider: string): Promise<OAuthTokens | undefined>;
}

/**
 * A channel: one module owning a surface's inbound + (optional) outbound.
 *
 * - `match` cheaply decides routing from the raw request; return `null` to 400
 *   (not for this channel), or `{ ack }` to answer a provider handshake (e.g.
 *   Slack `url_verification`) without starting a run. It MAY be async: platforms
 *   that route on the request *body* (e.g. Slack's `type`/event discriminators)
 *   need to read it, so `match` can return a `Promise`.
 * - `parse` normalizes a *verified* request into a `ChannelInboundEvent`.
 * - `deliver` pushes a completed reply back to the surface. OMIT it for an
 *   inbound-only channel (a fire-and-forget workflow trigger — the old webhook).
 */
export interface Channel {
  /**
   * Optional identifier for logging/metadata. The authoritative id — used for
   * the `POST /channels/:id` mount and outbound-delivery lookup — is the
   * discovered filename (`channels/slack.ts` → "slack"), regardless of this field.
   */
  readonly id?: string;
  /** Default routing target for inbound events on this surface. */
  readonly target: ChannelTarget;
  /**
   * Inbound-signature verification policy, enforced by the gateway before the
   * request is parsed or dispatched. Omit and it is fail-closed (rejected in
   * production); set `"none"` to explicitly opt out. See {@link WebhookVerify}.
   */
  readonly verify?: WebhookVerify;
  match(req: Request): ChannelMatch | Promise<ChannelMatch>;
  parse(req: Request): Promise<ChannelInboundEvent>;
  deliver?(ctx: ChannelDeliverContext): Promise<void>;
}
