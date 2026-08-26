import type { AgentRuntime } from "./runtime.js";

/**
 * Notify all surfaces attached to a thread about a new item.
 * Reads the thread's surfaces, then calls each channel's `deliver` function.
 */
export async function notifyThreadSurfaces(
  runtime: AgentRuntime,
  threadId: string,
  item: { kind: string; role?: string; content?: string; data?: unknown },
): Promise<void> {
  const surfaces = await runtime.surfaceStore.getSurfaces(threadId);
  if (surfaces.length === 0) return;

  const text = item.content ?? (typeof item.data === 'string' ? item.data : JSON.stringify(item.data ?? ''));
  const env = (name: string): string | undefined => process.env[name];
  const logger = { debug: () => {}, info: console.info, warn: console.warn, error: console.error };

  for (const surface of surfaces) {
    const channel = runtime.channels.get(surface.channel);
    if (!channel?.deliver) continue;
    try {
      await channel.deliver({
        conversationId: surface.address,
        message: { text, data: item.data },
        env,
        logger,
      });
    } catch (err) {
      logger.error(`notify surface ${surface.channel}:${surface.address} failed`, err);
    }
  }
}
