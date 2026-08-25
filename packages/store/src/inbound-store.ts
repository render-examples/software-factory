export interface InboundMessage {
  id: string;
  tenantId: string;
  deliveryId: string;
  channel: string;
  conversationId: string;
  threadId?: string;
  userId?: string;
  input: unknown;
  status: "pending" | "processing" | "processed" | "failed";
  createdAt: string;
  processedAt?: string;
}

export interface ConversationJob {
  id: string;
  messageId: string;
  channel: string;
  conversationId: string;
  status: string;
  leaseToken: string;
  attempts: number;
}

export interface AcceptMessageInput {
  deliveryId: string;
  channel: string;
  conversationId: string;
  threadId?: string;
  userId?: string;
  input: unknown;
}

export interface InboundStore {
  /** Atomically persist message + enqueue job. Returns false if delivery_id is duplicate. */
  acceptMessage(input: AcceptMessageInput): Promise<boolean>;
  claimJob(workerId: string): Promise<ConversationJob | null>;
  heartbeatJob(jobId: string, leaseToken: string): Promise<boolean>;
  completeJob(jobId: string, leaseToken: string): Promise<void>;
  failJob(jobId: string, leaseToken: string, error: string, retry?: boolean): Promise<void>;
  reapJobs(staleBefore: Date): Promise<number>;
  getMessage(messageId: string): Promise<InboundMessage | null>;
  markProcessed(messageId: string): Promise<void>;
  /** Postgres advisory lock scoped to a conversation — serializes turns on the same thread. */
  withConversationLock<T>(channel: string, conversationId: string, fn: () => Promise<T>): Promise<T>;
}
