export interface CancelStore {
  requestCancel(runId: string): Promise<void>;
  isCancelled(runId: string): Promise<boolean>;
  clearCancel(runId: string): Promise<void>;
}
