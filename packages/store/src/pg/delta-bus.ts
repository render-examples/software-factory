import pg from "pg";
import type { Pool } from "pg";
import {
  DELTA_CHANNEL,
  DeltaQueue,
  deltaMatchesFilter,
  type DeltaBus,
  type StreamDelta,
} from "../delta-bus.js";

/**
 * Postgres-backed transient delta bus (D13). `publish` fires a payload-carrying
 * `pg_notify` on the `run_deltas` channel — no INSERT, no projection, no
 * retention. `subscribe` demultiplexes off a **single shared `LISTEN`
 * connection per process** (not one per SSE client), fanning out in-memory to
 * per-run/-thread subscribers, so streaming adds exactly one DB connection per
 * gateway instance regardless of how many clients are connected.
 *
 * Non-durable by design: a client that connects mid-turn misses prior deltas
 * and converges on the durable `message.assistant`.
 */
export class PgDeltaBus implements DeltaBus {
  private listenClient: pg.PoolClient | null = null;
  private listening: Promise<void> | null = null;
  private readonly subs = new Set<{
    filter: { runId?: string; threadId?: string };
    queue: DeltaQueue<StreamDelta>;
  }>();

  constructor(private readonly pool: Pool) {}

  async publish(delta: StreamDelta): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [DELTA_CHANNEL, JSON.stringify(delta)]);
  }

  subscribe(
    filter: { runId?: string; threadId?: string },
    signal: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const queue = new DeltaQueue<StreamDelta>();
    const entry = { filter, queue };
    this.subs.add(entry);
    // Best-effort: begin listening; deltas published before LISTEN lands are
    // transient and acceptably missed. Swallow a listen failure here — it is
    // reset inside `ensureListening` so the next subscriber retries.
    this.ensureListening().catch(() => {});
    const subs = this.subs;
    const stopListening = () => this.stopListening();
    async function* generator(): AsyncGenerator<StreamDelta> {
      try {
        yield* queue.drain(signal);
      } finally {
        subs.delete(entry);
        if (subs.size === 0) await stopListening();
      }
    }
    return generator();
  }

  private ensureListening(): Promise<void> {
    if (!this.listening) {
      // On failure, reset so a later subscriber retries instead of inheriting a
      // permanently-rejected promise (which would silently kill streaming for
      // this process). The rejection is re-thrown for the immediate caller.
      this.listening = this.connectAndListen().catch((err) => {
        this.listening = null;
        this.listenClient = null;
        throw err;
      });
    }
    return this.listening;
  }

  private async connectAndListen(): Promise<void> {
    const client = await this.pool.connect();
    this.listenClient = client;
    client.on("notification", (msg: pg.Notification) => {
      if (!msg.payload) return;
      let delta: StreamDelta;
      try {
        delta = JSON.parse(msg.payload) as StreamDelta;
      } catch {
        return;
      }
      for (const sub of this.subs) {
        if (deltaMatchesFilter(sub.filter, delta)) sub.queue.push(delta);
      }
    });
    const onGone = () => {
      if (this.listenClient !== client) return;
      this.listenClient = null;
      this.listening = null;
      try {
        client.release();
      } catch {
        // already released
      }
      if (this.subs.size > 0) {
        void this.ensureListening().catch(() => {});
      }
    };
    client.on("error", onGone);
    client.on("end", onGone);
    await client.query(`LISTEN ${DELTA_CHANNEL}`);
  }

  private async stopListening(): Promise<void> {
    // A new subscriber may have arrived between the caller's size check and here
    // (and already re-armed listening); if so, keep the shared connection.
    if (this.subs.size > 0) return;
    const client = this.listenClient;
    this.listenClient = null;
    this.listening = null;
    if (!client) return;
    try {
      await client.query(`UNLISTEN ${DELTA_CHANNEL}`);
    } catch {
      // ignore — releasing the client drops the LISTEN anyway
    }
    try {
      client.release();
    } catch {
      // already released
    }
  }
}
