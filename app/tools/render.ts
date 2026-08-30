/** Render API tools — lets agents inspect and operate Render services. */
import { z } from "zod";
import type { Tool, ToolSource, ToolResult, ToolContext } from "#factory-sdk";

const MAX_BODY = 50_000;

function apiKey(): string {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error("RENDER_API_KEY is not set");
  return key;
}

function ownerId(): string | undefined {
  return process.env.RENDER_WORKSPACE_ID;
}

async function renderFetch(
  path: string,
  opts?: { method?: string; body?: unknown; params?: Record<string, string> },
): Promise<Response> {
  const url = new URL(`https://api.render.com/v1${path}`);
  const owner = ownerId();
  if (owner && !url.searchParams.has("ownerId")) {
    url.searchParams.set("ownerId", owner);
  }
  if (opts?.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      url.searchParams.set(k, v);
    }
  }
  return fetch(url, {
    method: opts?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: "application/json",
      ...(opts?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

function truncate(s: string, limit = MAX_BODY): string {
  return s.length > limit ? s.slice(0, limit) + "\n… [truncated]" : s;
}

async function jsonResult(res: Response): Promise<ToolResult> {
  const text = await res.text();
  if (!res.ok) {
    return { content: `Render API ${res.status}: ${text.slice(0, 500)}`, isError: true };
  }
  return { content: truncate(text) };
}

// --- list_services ---

const listServicesSchema = {};

const listServicesTool: Tool<typeof listServicesSchema> = {
  name: "render_list_services",
  description: "List all services in the Render workspace. Returns name, ID, type, status, and URL for each service.",
  inputSchema: listServicesSchema,
  async invoke(): Promise<ToolResult> {
    const res = await renderFetch("/services", { params: { limit: "50" } });
    if (!res.ok) return jsonResult(res);
    const data = (await res.json()) as Array<{ service: Record<string, unknown> }>;
    const summary = data.map((item) => {
      const s = item.service;
      return `${s.name} (${s.id}) — ${s.type} / ${s.suspended === "suspended" ? "suspended" : "active"} — ${(s.serviceDetails as Record<string, unknown>)?.url ?? "no url"}`;
    });
    return { content: summary.join("\n") || "(no services)" };
  },
};

// --- get_service ---

const getServiceSchema = {
  service_id: z.string().describe("Render service ID (e.g. srv-abc123)."),
};

const getServiceTool: Tool<typeof getServiceSchema> = {
  name: "render_get_service",
  description: "Get details about a specific Render service including its config, deploy status, and URL.",
  inputSchema: getServiceSchema,
  async invoke(input): Promise<ToolResult> {
    const res = await renderFetch(`/services/${input.service_id}`);
    return jsonResult(res);
  },
};

// --- list_deploys ---

const listDeploysSchema = {
  service_id: z.string().describe("Render service ID."),
  limit: z.number().optional().describe("Max deploys to return (default 10, max 25)."),
};

const listDeploysTool: Tool<typeof listDeploysSchema> = {
  name: "render_list_deploys",
  description: "List recent deploys for a Render service. Shows status, commit, and timestamps.",
  inputSchema: listDeploysSchema,
  async invoke(input): Promise<ToolResult> {
    const limit = String(Math.min(input.limit ?? 10, 25));
    const res = await renderFetch(`/services/${input.service_id}/deploys`, { params: { limit } });
    if (!res.ok) return jsonResult(res);
    const data = (await res.json()) as Array<{ deploy: Record<string, unknown> }>;
    const summary = data.map((item) => {
      const d = item.deploy;
      const commit = (d.commit as Record<string, unknown>)?.message ?? "";
      return `${d.id} — ${d.status} — ${(commit as string).slice(0, 80)} (${d.createdAt})`;
    });
    return { content: summary.join("\n") || "(no deploys)" };
  },
};

// --- trigger_deploy ---

const triggerDeploySchema = {
  service_id: z.string().describe("Render service ID to deploy."),
  clear_cache: z.boolean().optional().describe("Clear build cache before deploying. Default false."),
};

const triggerDeployTool: Tool<typeof triggerDeploySchema> = {
  name: "render_trigger_deploy",
  description: "Trigger a new deploy for a Render service. Use when auto-deploy is off or a manual redeploy is needed.",
  inputSchema: triggerDeploySchema,
  async invoke(input): Promise<ToolResult> {
    const body: Record<string, unknown> = {};
    if (input.clear_cache) body.clearCache = "clear";
    const res = await renderFetch(`/services/${input.service_id}/deploys`, {
      method: "POST",
      body,
    });
    return jsonResult(res);
  },
};

// --- list_logs ---

const listLogsSchema = {
  service_id: z.string().describe("Render service ID."),
  limit: z.number().optional().describe("Max log lines (default 50, max 100)."),
  type: z.enum(["app", "request", "build"]).optional().describe("Log type filter."),
  level: z.enum(["info", "warn", "error"]).optional().describe("Severity filter."),
};

const listLogsTool: Tool<typeof listLogsSchema> = {
  name: "render_list_logs",
  description: "Fetch recent logs for a Render service. Supports filtering by type (app/request/build) and level.",
  inputSchema: listLogsSchema,
  async invoke(input): Promise<ToolResult> {
    const params: Record<string, string> = {
      resource: input.service_id,
      limit: String(Math.min(input.limit ?? 50, 100)),
      direction: "backward",
    };
    if (input.type) params.type = input.type;
    if (input.level) params.level = input.level;
    const res = await renderFetch("/logs", { params });
    if (!res.ok) return jsonResult(res);
    const data = (await res.json()) as { logs: Array<{ timestamp: string; message: string; level?: string }> };
    const lines = (data.logs ?? []).map(
      (l) => `[${l.timestamp}]${l.level ? ` ${l.level}` : ""} ${l.message}`,
    );
    return { content: truncate(lines.join("\n") || "(no logs)") };
  },
};

// --- get_metrics ---

const getMetricsSchema = {
  service_id: z.string().describe("Render service/resource ID."),
  metrics: z
    .array(z.enum(["cpu_usage", "memory_usage", "http_request_count", "http_latency", "instance_count"]))
    .describe("Which metrics to fetch."),
  period_minutes: z.number().optional().describe("Lookback period in minutes (default 60)."),
};

const getMetricsTool: Tool<typeof getMetricsSchema> = {
  name: "render_get_metrics",
  description: "Get performance metrics (CPU, memory, HTTP requests, latency) for a Render service.",
  inputSchema: getMetricsSchema,
  async invoke(input): Promise<ToolResult> {
    const end = new Date();
    const start = new Date(end.getTime() - (input.period_minutes ?? 60) * 60_000);
    const params: Record<string, string> = {
      resource: input.service_id,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      metricType: input.metrics.join(","),
    };
    const res = await renderFetch("/metrics", { params });
    return jsonResult(res);
  },
};

// --- env vars ---

const listEnvVarsSchema = {
  service_id: z.string().describe("Render service ID."),
};

const listEnvVarsTool: Tool<typeof listEnvVarsSchema> = {
  name: "render_list_env_vars",
  description: "List environment variables for a Render service. Values of secrets may be redacted.",
  inputSchema: listEnvVarsSchema,
  async invoke(input): Promise<ToolResult> {
    const res = await renderFetch(`/services/${input.service_id}/env-vars`);
    return jsonResult(res);
  },
};

export class RenderToolSource implements ToolSource {
  readonly id = "render";

  resolve() {
    return [
      listServicesTool,
      getServiceTool,
      listDeploysTool,
      triggerDeployTool,
      listLogsTool,
      getMetricsTool,
      listEnvVarsTool,
    ];
  }
}
