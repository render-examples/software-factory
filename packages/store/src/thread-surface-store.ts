export interface ThreadSurface {
  id: string;
  threadId: string;
  channel: string;   // 'slack', 'github', 'webhook'
  address: string;   // e.g. 'C0BTJTDHFCG:1787714273.567249'
  createdAt: string;
}

export interface ThreadSurfaceStore {
  upsertSurface(threadId: string, channel: string, address: string): Promise<ThreadSurface>;
  getSurfaces(threadId: string): Promise<ThreadSurface[]>;
  removeSurface(id: string): Promise<void>;
}
