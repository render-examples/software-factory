import type { SlackClient } from "./client.js";
import { ThreadStreamer } from "./streamer.js";

/**
 * Streaming delivery surface for a Slack channel. Manages one ThreadStreamer
 * per active run, fed by token deltas from the DeltaBus.
 *
 * Usage (in the worker or gateway):
 *   const delivery = new SlackStreamingDelivery({ client });
 *   // On run start:
 *   await delivery.begin(runId, { channel, threadTs });
 *   // On each delta:
 *   delivery.onDelta(runId, delta.text);
 *   // On tool call:
 *   delivery.onTool(runId, toolName, summary);
 *   // On run complete:
 *   await delivery.finish(runId, finalText);
 *   // On run failure:
 *   await delivery.fail(runId, errorMessage);
 */

export interface StreamingDeliveryOptions {
  client: SlackClient;
  /** Minimum gap between Slack updates (ms). Default 1200. */
  intervalMs?: number;
}

export interface BeginOptions {
  channel: string;
  threadTs: string;
  clientMsgId?: string;
}

export class SlackStreamingDelivery {
  private readonly client: SlackClient;
  private readonly intervalMs: number;
  private readonly streamers = new Map<string, ThreadStreamer>();

  constructor(opts: StreamingDeliveryOptions) {
    this.client = opts.client;
    this.intervalMs = opts.intervalMs ?? 1200;
  }

  /** Start streaming for a run — posts the placeholder message. */
  async begin(runId: string, opts: BeginOptions): Promise<void> {
    if (this.streamers.has(runId)) return;
    const streamer = new ThreadStreamer({
      client: this.client,
      channel: opts.channel,
      threadTs: opts.threadTs,
      clientMsgId: opts.clientMsgId,
      intervalMs: this.intervalMs,
    });
    this.streamers.set(runId, streamer);
    await streamer.start();
  }

  /** Feed a text delta from the agent loop. */
  onDelta(runId: string, text: string): void {
    this.streamers.get(runId)?.appendText(text);
  }

  /** Note a tool invocation. */
  onTool(runId: string, name: string, detail?: string): void {
    this.streamers.get(runId)?.noteTool(name, detail);
  }

  /** Finalize the run's message with the authoritative reply text. */
  async finish(runId: string, finalText?: string): Promise<void> {
    const streamer = this.streamers.get(runId);
    if (!streamer) return;
    await streamer.finish(finalText);
    this.streamers.delete(runId);
  }

  /** Report a failure for this run. */
  async fail(runId: string, message: string): Promise<void> {
    const streamer = this.streamers.get(runId);
    if (!streamer) return;
    await streamer.fail(message);
    this.streamers.delete(runId);
  }

  /** Whether a run is currently being streamed. */
  has(runId: string): boolean {
    return this.streamers.has(runId);
  }
}
