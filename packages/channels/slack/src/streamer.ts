import type { SlackClient, SlackMessageRef } from "./client.js";
import { clampForSlack, toMrkdwn } from "./mrkdwn.js";

export interface ThreadStreamerOptions {
  client: SlackClient;
  channel: string;
  threadTs: string;
  /** Stable Slack idempotency key for retrying one logical turn. */
  clientMsgId?: string;
  /** Minimum gap between chat.update calls (ms). Default 1200. */
  intervalMs?: number;
  /** How many recent tool invocations to show under the reply. Default 4. */
  toolTrailLength?: number;
}

/**
 * One Slack message per agent turn, updated in place as the turn progresses.
 *
 * Token deltas accumulate and flush on a timer so the cost of a turn is a
 * handful of API calls regardless of how much the model writes.
 */
export class ThreadStreamer {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly intervalMs: number;
  private readonly toolTrailLength: number;
  private readonly clientMsgId: string | undefined;

  private ref: SlackMessageRef | null = null;
  private text = "";
  private status: string | null = null;
  private readonly tools: string[] = [];

  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastFlushAt = 0;
  private finished = false;

  constructor(options: ThreadStreamerOptions) {
    this.client = options.client;
    this.channel = options.channel;
    this.threadTs = options.threadTs;
    this.intervalMs = options.intervalMs ?? 1200;
    this.toolTrailLength = options.toolTrailLength ?? 4;
    this.clientMsgId = options.clientMsgId;
  }

  /** Posts the placeholder that later updates replace. */
  async start(placeholder = "_thinking…_"): Promise<SlackMessageRef> {
    if (this.ref) return this.ref;
    this.status = placeholder;
    this.ref = await this.client.postMessage({
      channel: this.channel,
      threadTs: this.threadTs,
      text: placeholder,
      clientMsgId: this.clientMsgId,
    });
    this.lastFlushAt = Date.now();
    return this.ref;
  }

  get messageRef(): SlackMessageRef | null {
    return this.ref;
  }

  appendText(delta: string): void {
    if (delta.length === 0) return;
    this.text += delta;
    this.status = null;
    this.schedule();
  }

  setStatus(status: string | null): void {
    this.status = status;
    this.schedule();
  }

  noteTool(name: string, detail?: string): void {
    const label = detail ? `${name} ${truncateInline(detail, 48)}` : name;
    this.tools.push(label);
    this.schedule();
  }

  /** Final update. After this the streamer ignores further input. */
  async finish(finalText?: string): Promise<string> {
    if (this.finished) return this.render(true);
    this.finished = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight.catch(() => {});

    if (finalText !== undefined) this.text = finalText;
    this.status = null;

    const body = this.render(true);
    if (this.ref) {
      try {
        await this.client.updateMessage({ channel: this.ref.channel, ts: this.ref.ts, text: body });
      } catch {
        // Best-effort final update
      }
    }
    return body;
  }

  /**
   * Reports a failure into the thread. Posts a new message if nothing was
   * posted yet or the streamer already finalized.
   */
  async fail(message: string): Promise<void> {
    if (!this.ref || this.finished) {
      this.finished = true;
      await this.client
        .postMessage({
          channel: this.channel,
          threadTs: this.threadTs,
          text: clampForSlack(`:warning: ${message}`),
        })
        .catch(() => {});
      return;
    }

    const existing = this.text.trim();
    await this.finish(existing.length > 0 ? `${existing}\n\n:warning: ${message}` : `:warning: ${message}`);
  }

  private render(final: boolean): string {
    const parts: string[] = [];

    const body = this.text.trim();
    if (body.length > 0) parts.push(toMrkdwn(body) + (final ? "" : " ▌"));
    else if (this.status) parts.push(this.status);

    if (this.tools.length > 0) {
      const recent = this.tools.slice(-this.toolTrailLength);
      const elided = this.tools.length > recent.length ? `+${this.tools.length - recent.length} more · ` : "";
      parts.push(`_${elided}${recent.join(" · ")}_`);
    }

    const rendered = parts.join("\n\n");
    return clampForSlack(rendered.length > 0 ? rendered : "_working…_");
  }

  private schedule(): void {
    if (this.finished || !this.ref) return;
    this.dirty = true;
    if (this.timer || this.inFlight) return;

    const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastFlushAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private flush(): Promise<void> {
    if (this.finished || !this.ref || this.inFlight) return Promise.resolve();
    this.dirty = false;
    const ref = this.ref;
    const body = this.render(false);

    const work = this.client
      .updateMessage({ channel: ref.channel, ts: ref.ts, text: body })
      .catch(() => {
        // Dropped intermediate frame is cosmetic; finish() writes authoritative text
      })
      .finally(() => {
        this.lastFlushAt = Date.now();
        this.inFlight = null;
        if (this.dirty) this.schedule();
      });

    this.inFlight = work;
    return work;
  }
}

function truncateInline(value: string, max: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1)}…`;
}
