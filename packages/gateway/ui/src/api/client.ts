import { getKey } from "./auth";
import type {
  Approval, RunDetail, RunEventRecord, RunRecord, ScheduleRecord,
  SpanRecord, Thread, ThreadMessage, ToolCallEntry, RunStatus,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: "Bearer " + getKey(),
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch { /* non-JSON body */ }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface ListRunsParams {
  status?: RunStatus;
  workflow?: string;
  before?: string;
  limit?: number;
}

export const client = {
  listRuns(params: ListRunsParams = {}): Promise<{ runs: RunRecord[] }> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.workflow) q.set("workflow", params.workflow);
    if (params.before) q.set("before", params.before);
    q.set("limit", String(params.limit ?? 100));
    return api(`/runs?${q.toString()}`);
  },
  getRun(id: string): Promise<RunDetail> {
    return api(`/runs/${encodeURIComponent(id)}`);
  },
  getSpans(id: string): Promise<{ spans: SpanRecord[] }> {
    return api(`/runs/${encodeURIComponent(id)}/spans`);
  },
  getToolCalls(id: string): Promise<{ toolCalls: ToolCallEntry[] }> {
    return api(`/runs/${encodeURIComponent(id)}/tool-calls`);
  },
  getRunEvents(id: string): Promise<{ events: RunEventRecord[] }> {
    return api(`/runs/${encodeURIComponent(id)}/events`);
  },
  cancelRun(id: string): Promise<{ status: string; runId: string }> {
    return api(`/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  },

  listApprovals(status?: "pending" | "approved" | "denied" | "all"): Promise<{ approvals: Approval[] }> {
    const q = status ? `?status=${status}` : "";
    return api(`/approvals${q}`);
  },
  resolveApproval(
    id: string,
    body: { approved: boolean; resolvedBy?: string; reason?: string },
  ): Promise<{ resolved: boolean; approvalId: string; runId: string }> {
    return api(`/approvals/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  listThreads(userId?: string): Promise<{ threads: Thread[] }> {
    const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    return api(`/threads${q}`);
  },
  getThread(id: string): Promise<{ thread: Thread; messages: ThreadMessage[] }> {
    return api(`/threads/${encodeURIComponent(id)}`);
  },
  createThread(body: { title?: string; userId?: string } = {}): Promise<Thread> {
    return api(`/threads`, { method: "POST", body: JSON.stringify(body) });
  },
  sendMessage(threadId: string, content: string, userId?: string): Promise<unknown> {
    return api(`/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, userId }),
    });
  },

  listSchedules(): Promise<{ schedules: ScheduleRecord[] }> {
    return api(`/schedules`);
  },
  updateSchedule(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord> {
    return api(`/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  dispatchWorkflow(name: string, input: unknown, trigger = "ui"): Promise<RunRecord> {
    return api(`/workflows/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ input, trigger }),
    });
  },
};
