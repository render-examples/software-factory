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

export interface ThreadItemStore {
  appendItem(input: AppendItemInput): Promise<ThreadItem>;
  getItems(threadId: string, opts?: { limit?: number; afterSeq?: number }): Promise<ThreadItem[]>;
}
