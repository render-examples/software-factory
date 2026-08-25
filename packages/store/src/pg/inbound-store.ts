import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { InboundStore, InboundMessage, ConversationJob, AcceptMessageInput } from "../inbound-store.js";

export class PgInboundStore implements InboundStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
  ) {}

  async acceptMessage(input: AcceptMessageInput): Promise<boolean> {
    const id = randomUUID();
    const jobId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO inbound_messages (id, tenant_id, delivery_id, channel, conversation_id, thread_id, user_id, input)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, delivery_id) DO NOTHING
         RETURNING id`,
        [id, this.tenantId, input.deliveryId, input.channel, input.conversationId, input.threadId ?? null, input.userId ?? null, JSON.stringify(input.input)],
      );
      if (res.rowCount === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO conversation_jobs (id, tenant_id, message_id, channel, conversation_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [jobId, this.tenantId, id, input.channel, input.conversationId],
      );
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async claimJob(workerId: string): Promise<ConversationJob | null> {
    const leaseToken = randomUUID();
    const res = await this.pool.query<ConversationJobRow>(
      `UPDATE conversation_jobs SET
         status = 'running', locked_by = $1, locked_at = now(),
         lease_token = $3, attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM conversation_jobs
         WHERE tenant_id = $2 AND status = 'queued'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, message_id, channel, conversation_id, status, lease_token, attempts`,
      [workerId, this.tenantId, leaseToken],
    );
    if (res.rows.length === 0) return null;
    return mapJobRow(res.rows[0]);
  }

  async heartbeatJob(jobId: string, leaseToken: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE conversation_jobs SET locked_at = now(), updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND lease_token = $3 AND status = 'running'`,
      [jobId, this.tenantId, leaseToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async completeJob(jobId: string, leaseToken: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE conversation_jobs SET status = 'completed', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND lease_token = $3`,
      [jobId, this.tenantId, leaseToken],
    );
    if ((res.rowCount ?? 0) === 0) throw new Error(`Lost lease for job ${jobId}`);
  }

  async failJob(jobId: string, leaseToken: string, error: string, retry?: boolean): Promise<void> {
    const nextStatus = retry ? "queued" : "failed";
    await this.pool.query(
      `UPDATE conversation_jobs SET
         status = $4, error = $5, locked_by = NULL, locked_at = NULL,
         lease_token = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND lease_token = $3`,
      [jobId, this.tenantId, leaseToken, nextStatus, error],
    );
  }

  async reapJobs(staleBefore: Date): Promise<number> {
    const res = await this.pool.query(
      `UPDATE conversation_jobs SET
         status = 'queued', locked_by = NULL, locked_at = NULL, lease_token = NULL, updated_at = now()
       WHERE tenant_id = $1 AND status = 'running' AND locked_at < $2`,
      [this.tenantId, staleBefore.toISOString()],
    );
    return res.rowCount ?? 0;
  }

  async getMessage(messageId: string): Promise<InboundMessage | null> {
    const res = await this.pool.query<InboundMessageRow>(
      `SELECT id, tenant_id, delivery_id, channel, conversation_id, thread_id, user_id, input, status, created_at, processed_at
       FROM inbound_messages WHERE id = $1 AND tenant_id = $2`,
      [messageId, this.tenantId],
    );
    if (res.rows.length === 0) return null;
    return mapMessageRow(res.rows[0]);
  }

  async markProcessed(messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE inbound_messages SET status = 'processed', processed_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [messageId, this.tenantId],
    );
  }

  async withConversationLock<T>(channel: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = conversationLockKey(channel, conversationId);
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
      }
    } finally {
      client.release();
    }
  }
}

function conversationLockKey(channel: string, conversationId: string): number {
  const hash = createHash("md5").update(`${channel}:${conversationId}`).digest();
  // Use first 4 bytes as a signed 32-bit int for pg_advisory_lock
  return hash.readInt32BE(0);
}

interface ConversationJobRow {
  id: string;
  message_id: string;
  channel: string;
  conversation_id: string;
  status: string;
  lease_token: string;
  attempts: number;
}

function mapJobRow(row: ConversationJobRow): ConversationJob {
  return {
    id: row.id,
    messageId: row.message_id,
    channel: row.channel,
    conversationId: row.conversation_id,
    status: row.status,
    leaseToken: row.lease_token,
    attempts: row.attempts,
  };
}

interface InboundMessageRow {
  id: string;
  tenant_id: string;
  delivery_id: string;
  channel: string;
  conversation_id: string;
  thread_id: string | null;
  user_id: string | null;
  input: unknown;
  status: string;
  created_at: Date;
  processed_at: Date | null;
}

function mapMessageRow(row: InboundMessageRow): InboundMessage {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    deliveryId: row.delivery_id,
    channel: row.channel,
    conversationId: row.conversation_id,
    threadId: row.thread_id ?? undefined,
    userId: row.user_id ?? undefined,
    input: row.input,
    status: row.status as InboundMessage["status"],
    createdAt: row.created_at.toISOString(),
    processedAt: row.processed_at?.toISOString(),
  };
}
