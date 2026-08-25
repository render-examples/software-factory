// Outbound channel delivery: push a channel-bound run's reply — or, when it
// pauses awaiting human input (HITL), the input prompt — back to the surface it
// came from. This is the consumer side of the `deliver` job (and the inline path
// the gateway uses in `inline` mode). Idempotent per delivered thing: a
// `channel.delivered` marker (keyed by `inputRequestId`, or none for the final
// reply) short-circuits redelivery, so at-least-once dispatch is effectively-once.

import { buildEventRecord } from "@render-factory/store";
import type { ContentBlock } from "@render-factory/store";
import type { OAuthTokens } from "@render-factory/engine";
import type { AgentRuntime } from "./runtime.js";

/** Flatten text content blocks to a plain string (the outbound reply text). */
function flattenText(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Per-user outbound credential resolver (channel runs are usually app-level). */
function connectionResolver(
  runtime: AgentRuntime,
  userId?: string,
): ((provider: string) => Promise<OAuthTokens | undefined>) | undefined {
  if (!userId) return undefined;
  return async (provider: string) => {
    const conn = await runtime.oauthStore.getConnection(userId, provider);
    return conn ? { accessToken: conn.accessToken, refreshToken: conn.refreshToken, expiresAt: conn.expiresAt } : undefined;
  };
}

/**
 * Deliver a channel-bound run's outbound message to its originating surface:
 * the assistant reply when it `completed`, or the pending input prompt when it
 * `paused` awaiting human input (HITL). A no-op when the run isn't channel-bound,
 * its channel has no `deliver`, there's nothing to deliver, or the same thing was
 * already delivered. Throws only if the channel's `deliver` throws — the worker
 * requeues the `deliver` job with backoff; inline callers log and move on.
 */
export async function deliverForRun(runtime: AgentRuntime, runId: string): Promise<void> {
  const store = runtime.store;
  const run = await store.getRun(runId);
  if (!run || !run.channel || !run.externalConversationId) return; // not channel-bound
  const channel = runtime.channels.get(run.channel);
  if (!channel?.deliver) return; // inbound-only channel (or channel unloaded)

  const events = await store.events.read(runId);
  const alreadyDelivered = (inputRequestId?: string): boolean =>
    events.some((e) => e.payload.type === "channel.delivered" && e.payload.inputRequestId === inputRequestId);

  const conversationId = run.externalConversationId;
  const env = (name: string): string | undefined => process.env[name];
  const logger = { debug: () => {}, info: console.info, warn: console.warn, error: console.error };
  const connection = connectionResolver(runtime, run.userId);

  if (run.status === "completed") {
    if (alreadyDelivered(undefined)) return; // the reply was already delivered
    const messages = await store.getMessages(runId, run.workflow);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const text = lastAssistant
      ? flattenText(lastAssistant.content)
      : (typeof run.result === "string" ? run.result : "");
    await channel.deliver({ conversationId, message: { text, data: run.result }, env, logger, connection });
    await store.events.append(
      buildEventRecord(runId, { type: "channel.delivered", channel: run.channel, externalConversationId: conversationId }, { agentName: run.workflow, spanId: runId }),
    );
    return;
  }

  if (run.status === "paused") {
    // HITL: deliver the pending input request so a human on the surface can respond.
    const input = (await store.getInputs(runId)).find((i) => i.status === "pending");
    if (!input) return;
    if (alreadyDelivered(input.inputRequestId)) return; // this prompt already delivered
    const text = input.kind === "approval"
      ? `Approval requested${input.toolName ? ` for "${input.toolName}"` : ""}.`
      : (input.prompt ?? "The agent is waiting for your input.");
    await channel.deliver({
      conversationId,
      message: { text, data: input.input },
      input: { inputRequestId: input.inputRequestId, kind: input.kind, prompt: input.prompt, toolName: input.toolName },
      env,
      logger,
      connection,
    });
    await store.events.append(
      buildEventRecord(runId, { type: "channel.delivered", channel: run.channel, externalConversationId: conversationId, inputRequestId: input.inputRequestId }, { agentName: run.workflow, spanId: runId }),
    );
  }
}
