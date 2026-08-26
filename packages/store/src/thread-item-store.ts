export interface ThreadItem {
  id: string;
  threadId: string;
  runId?: string;
  seq: number;
  kind: 'message' | 'result' | 'status' | 'error';
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  data?: unknown;
  createdAt: string;
}

export interface AppendItemInput {
  threadId: string;
  runId?: string;
  kind: ThreadItem['kind'];
  role?: ThreadItem['role'];
  content?: string;
  data?: unknown;
}

export interface ThreadItemQueryOptions {
  /** Return items strictly after this thread sequence. */
  afterSeq?: number;
  /** Return items strictly before this thread sequence. */
  beforeSeq?: number;
  /** Return items created at or after this ISO-8601 timestamp. */
  since?: string;
  /** Maximum number of items to return. */
  limit?: number;
  /** Result ordering. Defaults to ascending sequence order. */
  order?: 'asc' | 'desc';
}

export interface ThreadItemStore {
  appendItem(input: AppendItemInput): Promise<ThreadItem>;
  getItems(threadId: string, opts?: ThreadItemQueryOptions): Promise<ThreadItem[]>;
}
