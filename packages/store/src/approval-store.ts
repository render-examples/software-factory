export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  toolInput: unknown;
  agentName: string;
  status: "pending" | "approved" | "denied";
  requestedAt: string;
  resolvedAt?: string;
  providedBy?: string;
  reason?: string;
}

export interface ApprovalStore {
  createRequest(req: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | undefined>;
  listPending(runId: string): Promise<ApprovalRequest[]>;
  resolve(id: string, decision: { approved: boolean; providedBy?: string; reason?: string }): Promise<void>;
}
