import type {
  Approval, RunDetail, RunEventRecord, RunRecord, ScheduleRecord,
  SpanRecord, Thread, ThreadMessage, ToolCallEntry, RunStatus,
  WorkflowInfo, ConnectionInfo, JobsSnapshot, RetentionResult, ReapResult, RunCounts, InputCounts, ThreadView,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  // Auth rides the same-origin session cookie set at /ui/login — no bearer token
  // is held in JS (CR-D1 / CR-19).
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
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
  threadId?: string;
  before?: string;
  limit?: number;
  /** Include child runs (workflow fan-out / subagents). Defaults to roots-only. */
  includeChildren?: boolean;
}

export const client = {
  listRuns(params: ListRunsParams = {}): Promise<{ runs: RunRecord[] }> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.workflow) q.set("workflow", params.workflow);
    if (params.threadId) q.set("threadId", params.threadId);
    if (params.before) q.set("before", params.before);
    if (params.includeChildren) q.set("roots", "false");
    q.set("limit", String(params.limit ?? 100));
    return api(`/runs?${q.toString()}`);
  },
  listRunChildren(id: string): Promise<{ runs: RunRecord[] }> {
    return api(`/runs/${encodeURIComponent(id)}/children`);
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

  listInputs(
    status?: "pending" | "approved" | "denied" | "provided" | "all",
    threadId?: string,
    kind?: "approval" | "message",
    runId?: string,
  ): Promise<{ approvals: Approval[] }> {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (threadId) q.set("threadId", threadId);
    if (kind) q.set("kind", kind);
    if (runId) q.set("runId", runId);
    const qs = q.toString();
    return api<{ inputs: Approval[] }>(`/inputs${qs ? `?${qs}` : ""}`).then((r) => ({ approvals: r.inputs }));
  },
  runCounts(params: { workflow?: string; threadId?: string } = {}): Promise<RunCounts> {
    const q = new URLSearchParams();
    if (params.workflow) q.set("workflow", params.workflow);
    if (params.threadId) q.set("threadId", params.threadId);
    const qs = q.toString();
    return api(`/runs/counts${qs ? `?${qs}` : ""}`);
  },
  inputCounts(params: {
    status?: "pending" | "approved" | "denied" | "provided" | "all";
    threadId?: string;
    kind?: "approval" | "message";
    runId?: string;
  } = {}): Promise<InputCounts> {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.threadId) q.set("threadId", params.threadId);
    if (params.kind) q.set("kind", params.kind);
    if (params.runId) q.set("runId", params.runId);
    const qs = q.toString();
    return api(`/inputs/counts${qs ? `?${qs}` : ""}`);
  },
  provideInput(
    id: string,
    body: { approved?: boolean; value?: unknown; content?: string; reason?: string },
  ): Promise<{ provided: boolean; inputId: string; runId: string }> {
    return api(`/inputs/${encodeURIComponent(id)}/provide`, {
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
  getThreadView(id: string): Promise<ThreadView> {
    return api(`/threads/${encodeURIComponent(id)}/view`);
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
  getSchedule(id: string): Promise<ScheduleRecord> {
    return api(`/schedules/${encodeURIComponent(id)}`);
  },
  createSchedule(body: {
    workflow: string; cronExpression: string; input?: unknown; enabled?: boolean;
  }): Promise<ScheduleRecord> {
    return api(`/schedules`, { method: "POST", body: JSON.stringify(body) });
  },
  updateSchedule(
    id: string,
    patch: Partial<Pick<ScheduleRecord, "workflow" | "cronExpression" | "input" | "enabled">>,
  ): Promise<ScheduleRecord> {
    return api(`/schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  deleteSchedule(id: string): Promise<{ deleted: string }> {
    return api(`/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  listWorkflows(): Promise<{ workflows: WorkflowInfo[]; defaultWorkflow?: string }> {
    return api(`/workflows`);
  },
  dispatchWorkflow(name: string, input: unknown, trigger = "ui"): Promise<RunRecord> {
    return api(`/workflows/${encodeURIComponent(name)}`, {
      method: "POST",
      body: JSON.stringify({ input, trigger }),
    });
  },

  listConnections(): Promise<{ providers: ConnectionInfo[] }> {
    // userId is derived from the session server-side (CR-D1) — never sent by the client.
    return api(`/connections`);
  },
  /** Full-page URL that starts the OAuth flow. Identity rides the same-origin
   *  session cookie on the navigation; no key/userId in the URL (CR-D1 / CR-19). */
  oauthAuthorizeUrl(provider: string): string {
    return `/oauth/${encodeURIComponent(provider)}/authorize`;
  },
  disconnectOAuth(provider: string): Promise<{ status: string }> {
    return api(`/oauth/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    });
  },

  adminJobs(): Promise<JobsSnapshot> {
    return api(`/admin/jobs`);
  },
  reapRuns(): Promise<ReapResult> {
    return api(`/admin/runs/reap`, { method: "POST" });
  },
  runRetention(): Promise<RetentionResult> {
    return api(`/admin/retention`, { method: "POST" });
  },
};
