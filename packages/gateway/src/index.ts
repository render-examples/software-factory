export { channelRoutes } from "./routes/channels.js";
export type { Channel, ChannelInboundEvent, ChannelDeliverContext, ChannelTarget } from "@render-factory/sdk";
export { createGatewayApp, startGateway } from "./app.js";
export type { GatewayOptions } from "./app.js";
export { apiKeyAuth, bearerKeyResolver, composeResolvers, canAccess, getPrincipal } from "./auth.js";
export type { Principal, AuthResolver, ApiKeyAuthOptions } from "./auth.js";
export { jwtAuthResolver } from "./jwt-auth.js";
export type { JwtAuthOptions } from "./jwt-auth.js";
export { issueStreamToken, verifyStreamToken, DEFAULT_STREAM_TOKEN_TTL_MS } from "./stream-token.js";
export { runRoutes } from "./routes/runs.js";
export { streamRoutes } from "./routes/stream.js";
export { threadRoutes } from "./routes/threads.js";
export { hitlRoutes } from "./routes/hitl.js";
export { oauthRoutes, buildRefresher, encryptToken, decryptToken } from "./routes/oauth.js";
export type { OAuthProviderConfig, OAuthRouteDeps } from "./routes/oauth.js";
export {
  verifyWebhookRequest,
  webhookVerifyRequired,
  checkWebhookAuth,
  REQUIRE_WEBHOOK_VERIFY_ENV,
} from "./verify.js";
export type { VerifyContext, VerifyResult, WebhookAuthCheck } from "./verify.js";
// Convenience re-exports so connector/webhook authors can import config helpers
// from the gateway package they already depend on.
export type {
  WebhookVerify,
  HmacVerify,
  GitHubVerify,
  SlackVerify,
  StripeVerify,
  StandardWebhooksVerify,
  NoVerify,
} from "@render-factory/sdk";
export {
  hmacVerify,
  githubVerify,
  slackVerify,
  stripeVerify,
  standardWebhooksVerify,
} from "@render-factory/sdk";
export { uiRoutes } from "./routes/ui.js";
export { buildSpanTree, flattenTree, perAgentCost, spanCostUsd, formatCost, formatDuration } from "./ui/trace.js";
export type { SpanLike, SpanNode } from "./ui/trace.js";
export { InboundWorker } from "./inbound-worker.js";
export type { InboundWorkerOptions } from "./inbound-worker.js";
