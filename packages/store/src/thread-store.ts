export interface Thread {
  id: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  status: "active" | "idle" | "completed" | "failed" | "cancelled";
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  runId: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ThreadStore {
  createThread(thread: Thread): Promise<void>;
  getThread(id: string): Promise<Thread | undefined>;
  updateThread(id: string, patch: Partial<Thread>): Promise<void>;
  listThreads(opts?: { userId?: string }): Promise<Thread[]>;
  getThreadMessages(threadId: string): Promise<ThreadMessage[]>;
}
