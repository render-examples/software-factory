// Channels — the single inbound/outbound message surface (supersedes the old
// `webhooks/` + `connectors/` concepts). A channel is the edge adapter between
// an external platform and an agent/workflow: verifies + normalizes an inbound
// event into a turn, and (optionally) delivers the reply back out.
//
// Discovered from `channels/*.ts` (default export a `Channel`; file stem is
// the channel id) via `loadChannels`, mounted by the gateway at
// `POST /channels/:id`, and attached to `runtime.channels` for outbound lookup.
//
// Inbound verification reuses the declarative `WebhookVerify` surface. An
// inbound-only channel (no `deliver`) is a fire-and-forget trigger (the former webhook).

import type { Logger } from "@render-factory/store";
import type { OAuthTokens } from "@render-factory/engine";
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
   * GitHub issue number, email thread id) so re-entrant messages resume it.
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
  /** Outbound message: assistant text + result for a final reply, or the
   *  question/approval prompt text for an input prompt (see `input`). */
  message: { text: string; data?: unknown };
  /**
   * Present when the run PAUSED awaiting human input (HITL); the channel can
   * render an approval/question. The next inbound message satisfies it.
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
 * - `match` decides routing from the raw request; `null` to 400, or `{ ack }`
 *   to answer a provider handshake without starting a run. May be async since
 *   some platforms route on the request body.
 * - `parse` normalizes a *verified* request into a `ChannelInboundEvent`.
 * - `deliver` pushes a completed reply back. Omit for an inbound-only channel
 *   (fire-and-forget trigger — the old webhook).
 */
export interface Channel {
  /**
   * Optional identifier for logging/metadata. The authoritative id (used for
   * the `POST /channels/:id` mount and delivery lookup) is the discovered
   * filename (`channels/slack.ts` → "slack"), regardless of this field.
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
