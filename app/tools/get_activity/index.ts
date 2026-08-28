import { defineTool } from "@render-factory/sdk";
import type {
  AgentRuntime,
  RunEvent,
  RunEventRecord,
  RunRecord,
  Thread,
  ThreadItem,
} from "@render-factory/sdk";

type ActivityRuntime = Pick<AgentRuntime, "store" | "threadStore" | "itemStore">;

interface ActivityInput {
  scope?: "run" | "thread";
  id?: string;
  limit?: number;
  since?: string;
  before_seq?: number;
  after_seq?: number;
}

interface ActivityEntry {
  seq: number;
  timestamp: string;
  type: string;
  agent?: string;
  data?: unknown;
}

interface ActivityPage {
  mode: "latest" | "after";
  requested_limit: number;
  returned: number;
  has_more: boolean;
  oldest_seq?: number;
  latest_seq?: number;
  next_before_seq?: number;
  next_after_seq?: number;
  output_truncated?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_FIELD_CHARS = 1_500;
const MAX_RESULT_CHARS = 32_000;
const MAX_CHILD_RUNS = 10;
const MAX_RECENT_RUNS = 5;

const ACTIVITY_EVENT_TYPES: RunEvent["type"][] = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.paused",
  "run.cancelled",
  "message.user",
  "message.assistant",
  "tool.called",
  "tool.result",
  "step.started",
  "step.completed",
  "input.requested",
  "input.provided",
  "input.auto",
  "subagent.spawned",
  "context.compacted",
];

let runtime: ActivityRuntime | undefined;

/** Late-bind runtime read stores after createRuntime() completes. */
export function bindActivityRuntime(value: ActivityRuntime): void {
  runtime = value;
}

/**
 * Convention-based late-bind called by `lateBindToolSources` after the full
 * project is assembled. Replaces manual `bindActivityRuntime` calls.
 */
export function bind(ctx: { runtime: ActivityRuntime }): void {
  runtime = ctx.runtime;
}

export default defineTool({
  name: "get_activity",
  description:
    "Read recent activity for a Render Factory run or thread. Use this when the " +
    "user provides a run ID or thread ID, asks for status, or wants the latest " +
    "workflow/conversation content. Returns the newest 20 entries by default, " +
    "with bounded pagination. This tool is read-only.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["run", "thread"],
        description: "Whether `id` identifies a run or a thread.",
      },
      id: {
        type: "string",
        minLength: 1,
        description: "The run ID or thread ID to inspect.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_LIMIT,
        description: `Maximum entries to return. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
      },
      since: {
        type: "string",
        description: "Optional ISO-8601 timestamp; only return activity at or after it.",
      },
      before_seq: {
        type: "integer",
        minimum: 0,
        description: "Return the latest entries strictly before this sequence (older-page cursor).",
      },
      after_seq: {
        type: "integer",
        minimum: 0,
        description: "Return entries strictly after this sequence (incremental-update cursor).",
      },
    },
    required: ["scope", "id"],
    additionalProperties: false,
  },
  async invoke(rawInput, ctx) {
    if (!runtime) {
      return {
        content: "get_activity: runtime stores are not bound (server misconfiguration)",
        isError: true,
      };
    }
    if (!ctx.runId) {
      return { content: "get_activity: calling run context is unavailable", isError: true };
    }

    const input = (rawInput ?? {}) as ActivityInput;
    const id = input.id?.trim();
    if (!id || (input.scope !== "run" && input.scope !== "thread")) {
      return { content: "get_activity: `scope` and `id` are required", isError: true };
    }
    if (input.before_seq !== undefined && input.after_seq !== undefined) {
      return {
        content: "get_activity: use only one of `before_seq` or `after_seq`",
        isError: true,
      };
    }

    let since: string | undefined;
    if (input.since !== undefined) {
      const parsed = Date.parse(input.since);
      if (Number.isNaN(parsed)) {
        return { content: "get_activity: `since` must be an ISO-8601 timestamp", isError: true };
      }
      since = new Date(parsed).toISOString();
    }

    const limit = clampLimit(input.limit);
    const caller = await runtime.store.getRun(ctx.runId);
    if (!caller) {
      return { content: "get_activity: calling run context was not found", isError: true };
    }

    if (input.scope === "run") {
      const target = await runtime.store.getRun(id);
      if (!target || !(await canAccessRun(runtime, caller, target))) return inaccessible();
      return {
        content: await renderRunActivity(runtime, target, {
          limit,
          since,
          beforeSeq: input.before_seq,
          afterSeq: input.after_seq,
        }),
      };
    }

    const thread = await runtime.threadStore.getThread(id);
    if (!thread || !(await canAccessThread(runtime, caller, thread))) return inaccessible();
    return {
      content: await renderThreadActivity(runtime, thread, {
        limit,
        since,
        beforeSeq: input.before_seq,
        afterSeq: input.after_seq,
      }),
    };
  },
});

function inaccessible(): { content: string; isError: true } {
  // Missing and unauthorized targets intentionally share one response so IDs
  // cannot be enumerated through an assistant tool.
  return { content: "get_activity: target not found or inaccessible", isError: true };
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

async function canAccessRun(
  rt: ActivityRuntime,
  caller: RunRecord,
  target: RunRecord,
): Promise<boolean> {
  if (caller.id === target.id) return true;
  if (caller.threadId && caller.threadId === target.threadId) return true;

  const [callerThread, targetThread] = await Promise.all([
    caller.threadId ? rt.threadStore.getThread(caller.threadId) : undefined,
    target.threadId ? rt.threadStore.getThread(target.threadId) : undefined,
  ]);
  const callerOwner = caller.userId ?? callerThread?.userId;
  const targetOwner = target.userId ?? targetThread?.userId;
  return callerOwner !== undefined && callerOwner === targetOwner;
}

async function canAccessThread(
  rt: ActivityRuntime,
  caller: RunRecord,
  target: Thread,
): Promise<boolean> {
  if (caller.threadId === target.id) return true;
  const callerThread = caller.threadId
    ? await rt.threadStore.getThread(caller.threadId)
    : undefined;
  const callerOwner = caller.userId ?? callerThread?.userId;
  return callerOwner !== undefined && callerOwner === target.userId;
}

async function renderRunActivity(
  rt: ActivityRuntime,
  run: RunRecord,
  window: { limit: number; since?: string; beforeSeq?: number; afterSeq?: number },
): Promise<string> {
  const forward = window.afterSeq !== undefined;
  const [queriedEvents, queriedChildren] = await Promise.all([
    rt.store.events.query(run.id, {
      afterSeq: window.afterSeq,
      beforeSeq: window.beforeSeq,
      since: window.since,
      types: ACTIVITY_EVENT_TYPES,
      limit: window.limit + 1,
      order: forward ? "asc" : "desc",
    }),
    rt.store.listChildRuns(run.id, { limit: MAX_CHILD_RUNS + 1, order: "desc" }),
  ]);

  const { values: eventRows, hasMore } = selectWindow(queriedEvents, window.limit, forward);
  const entries = eventRows.map(eventEntry);
  const childHasMore = queriedChildren.length > MAX_CHILD_RUNS;
  const children = queriedChildren
    .slice(0, MAX_CHILD_RUNS)
    .reverse()
    .map(compactRun);

  const page = makePage(entries, window.limit, forward, hasMore);
  const response: Record<string, unknown> = {
    scope: "run",
    observed_at: new Date().toISOString(),
    run: {
      ...compactRun(run),
      trigger: run.trigger,
      input: clipUnknown(run.input),
      result: clipUnknown(run.result),
      error: clipText(run.error),
      total_cost_usd: run.totalCostUsd,
    },
    activity_detail_available:
      entries.length > 0 || window.since !== undefined || window.beforeSeq !== undefined || forward
        ? undefined
        : false,
    entries,
    child_runs: children,
    child_runs_has_more: childHasMore,
    page,
  };
  return boundedJson(response, entries, page, forward);
}

async function renderThreadActivity(
  rt: ActivityRuntime,
  thread: Thread,
  window: { limit: number; since?: string; beforeSeq?: number; afterSeq?: number },
): Promise<string> {
  const forward = window.afterSeq !== undefined;
  const [queriedItems, recentRuns] = await Promise.all([
    rt.itemStore.getItems(thread.id, {
      afterSeq: window.afterSeq,
      beforeSeq: window.beforeSeq,
      since: window.since,
      limit: window.limit + 1,
      order: forward ? "asc" : "desc",
    }),
    rt.store.listRuns({ threadId: thread.id, roots: true, limit: MAX_RECENT_RUNS + 1 }),
  ]);

  const { values: itemRows, hasMore } = selectWindow(queriedItems, window.limit, forward);
  const entries = itemRows.map(itemEntry);
  const page = makePage(entries, window.limit, forward, hasMore);
  const response: Record<string, unknown> = {
    scope: "thread",
    observed_at: new Date().toISOString(),
    thread: {
      id: thread.id,
      status: thread.status,
      title: thread.title,
      metadata: clipUnknown(thread.metadata),
      created_at: thread.createdAt,
      updated_at: thread.updatedAt,
    },
    entries,
    recent_runs: recentRuns.slice(0, MAX_RECENT_RUNS).map(compactRun),
    recent_runs_has_more: recentRuns.length > MAX_RECENT_RUNS,
    page,
  };
  return boundedJson(response, entries, page, forward);
}

function selectWindow<T>(
  rows: T[],
  limit: number,
  forward: boolean,
): { values: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const values = rows.slice(0, limit);
  if (!forward) values.reverse();
  return { values, hasMore };
}

function makePage(
  entries: ActivityEntry[],
  limit: number,
  forward: boolean,
  hasMore: boolean,
): ActivityPage {
  const oldest = entries[0]?.seq;
  const latest = entries.at(-1)?.seq;
  return {
    mode: forward ? "after" : "latest",
    requested_limit: limit,
    returned: entries.length,
    has_more: hasMore,
    oldest_seq: oldest,
    latest_seq: latest,
    next_before_seq: !forward && hasMore ? oldest : undefined,
    next_after_seq: forward && hasMore ? latest : undefined,
  };
}

function eventEntry(event: RunEventRecord): ActivityEntry {
  const base = {
    seq: event.seq,
    timestamp: event.ts,
    type: event.type,
    agent: event.agentName,
  };
  const payload = event.payload;

  switch (payload.type) {
    case "run.started":
      return {
        ...base,
        data: {
          trigger: payload.trigger,
          input: clipUnknown(payload.input),
          model: payload.model,
          span_kind: payload.spanKind,
        },
      };
    case "run.completed":
      return { ...base, data: { result: clipUnknown(payload.result) } };
    case "run.failed":
      return { ...base, data: { error: clipText(payload.error) } };
    case "run.paused":
      return {
        ...base,
        data: { reason: payload.reason, pending_input_ids: payload.pendingInputIds },
      };
    case "run.cancelled":
      return base;
    case "message.user":
    case "message.assistant":
      return { ...base, data: { text: contentText(payload.content) } };
    case "tool.called":
      return {
        ...base,
        data: { tool_call_id: payload.toolCallId, name: payload.name, input: clipUnknown(payload.input) },
      };
    case "tool.result":
      return {
        ...base,
        data: {
          tool_call_id: payload.toolCallId,
          name: payload.name,
          content: clipText(payload.result.content),
          is_error: payload.result.isError ?? false,
        },
      };
    case "step.started":
      return { ...base, data: { name: payload.name } };
    case "step.completed":
      return { ...base, data: { name: payload.name, result: clipUnknown(payload.result) } };
    case "input.requested":
      return {
        ...base,
        data: {
          input_request_id: payload.inputRequestId,
          kind: payload.kind,
          tool_name: payload.toolName,
          prompt: clipText(payload.prompt),
        },
      };
    case "input.provided":
      return {
        ...base,
        data: {
          input_request_id: payload.inputRequestId,
          kind: payload.kind,
          approved: payload.approved,
          value: clipUnknown(payload.value),
          reason: clipText(payload.reason),
        },
      };
    case "input.auto":
      return { ...base, data: { kind: payload.kind, tool_name: payload.toolName } };
    case "subagent.spawned":
      return {
        ...base,
        data: {
          agent_name: payload.agentName,
          child_run_id: payload.childRunId,
          tool_call_id: payload.toolCallId,
        },
      };
    case "context.compacted":
      return {
        ...base,
        data: {
          agent_name: payload.agentName,
          strategy: payload.strategy,
          before_tokens: payload.beforeTokens,
          after_tokens: payload.afterTokens,
        },
      };
    default:
      return base;
  }
}

function itemEntry(item: ThreadItem): ActivityEntry {
  return {
    seq: item.seq,
    timestamp: item.createdAt,
    type: item.kind,
    agent: item.role,
    data: {
      run_id: item.runId,
      content: clipText(item.content),
      data: clipUnknown(item.data),
    },
  };
}

function compactRun(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    kind: run.kind,
    thread_id: run.threadId,
    parent_span_id: run.parentSpanId,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  };
}

function contentText(content: Array<{ type: string; text?: string }>): string | undefined {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return text ? clipText(text) : undefined;
}

function clipText(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_FIELD_CHARS)}… [truncated]`;
}

function clipUnknown(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return clipText(value);
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= MAX_FIELD_CHARS) return value;
    return `${encoded.slice(0, MAX_FIELD_CHARS)}… [truncated JSON]`;
  } catch {
    return clipText(String(value));
  }
}

function boundedJson(
  response: Record<string, unknown>,
  entries: ActivityEntry[],
  page: ActivityPage,
  forward: boolean,
): string {
  let encoded = JSON.stringify(response, null, 2);
  while (encoded.length > MAX_RESULT_CHARS && entries.length > 1) {
    if (forward) entries.pop();
    else entries.shift();
    page.returned = entries.length;
    page.has_more = true;
    page.output_truncated = true;
    page.oldest_seq = entries[0]?.seq;
    page.latest_seq = entries.at(-1)?.seq;
    page.next_before_seq = !forward ? page.oldest_seq : undefined;
    page.next_after_seq = forward ? page.latest_seq : undefined;
    encoded = JSON.stringify(response, null, 2);
  }
  return encoded;
}
