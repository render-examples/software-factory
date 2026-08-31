import { z } from "zod";
import type { Tool, ToolResult, ToolSource } from "#factory/sdk";

const MAX_RESPONSE_BYTES = 100_000;
const resourceId = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/)
	.describe("Render resource ID.");

function apiKey(): string {
	const key = process.env.RENDER_API_KEY;
	if (!key) throw new Error("RENDER_API_KEY is not set");
	return key;
}

async function responseText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("Render API response exceeded 100 KB");
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks, total).toString("utf8");
}

async function renderFetch(
	path: string,
	params: Record<string, string> = {},
): Promise<ToolResult> {
	const url = new URL(`https://api.render.com/v1${path}`);
	const ownerId = process.env.RENDER_WORKSPACE_ID;
	if (ownerId) url.searchParams.set("ownerId", ownerId);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey()}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(15_000),
	});
	const content = await responseText(response);
	return {
		content: response.ok
			? content
			: `Render API ${response.status}: ${content.slice(0, 500)}`,
		isError: !response.ok,
	};
}

const listServicesTool: Tool = {
	name: "render_list_services",
	description: "List services in the configured Render workspace.",
	inputSchema: {},
	async invoke() {
		return renderFetch("/services", { limit: "50" });
	},
};

const getServiceSchema = { service_id: resourceId };
const getServiceTool: Tool<typeof getServiceSchema> = {
	name: "render_get_service",
	description: "Get read-only configuration and status for one Render service.",
	inputSchema: getServiceSchema,
	async invoke(input) {
		return renderFetch(`/services/${input.service_id}`);
	},
};

const listDeploysSchema = {
	service_id: resourceId,
	limit: z.number().int().min(1).max(25).optional(),
};
const listDeploysTool: Tool<typeof listDeploysSchema> = {
	name: "render_list_deploys",
	description: "List recent deploys for one Render service.",
	inputSchema: listDeploysSchema,
	async invoke(input) {
		return renderFetch(`/services/${input.service_id}/deploys`, {
			limit: String(input.limit ?? 10),
		});
	},
};

const listLogsSchema = {
	resource_id: resourceId,
	limit: z.number().int().min(1).max(100).optional(),
	level: z.enum(["info", "warn", "error"]).optional(),
};
const listLogsTool: Tool<typeof listLogsSchema> = {
	name: "render_list_logs",
	description: "Fetch recent logs for one Render resource.",
	inputSchema: listLogsSchema,
	async invoke(input) {
		return renderFetch("/logs", {
			resource: input.resource_id,
			limit: String(input.limit ?? 50),
			direction: "backward",
			...(input.level ? { level: input.level } : {}),
		});
	},
};

const metricsSchema = {
	resource_id: resourceId,
	metrics: z
		.array(
			z.enum([
				"cpu_usage",
				"memory_usage",
				"http_request_count",
				"http_latency",
				"instance_count",
			]),
		)
		.min(1)
		.max(5),
	period_minutes: z.number().int().min(1).max(1_440).optional(),
};
const metricsTool: Tool<typeof metricsSchema> = {
	name: "render_get_metrics",
	description: "Read recent performance metrics for one Render resource.",
	inputSchema: metricsSchema,
	async invoke(input) {
		const end = new Date();
		const start = new Date(
			end.getTime() - (input.period_minutes ?? 60) * 60_000,
		);
		return renderFetch("/metrics", {
			resource: input.resource_id,
			startTime: start.toISOString(),
			endTime: end.toISOString(),
			metricType: input.metrics.join(","),
		});
	},
};

export class SlackAssistantRenderToolSource implements ToolSource {
	readonly id = "slack-assistant-render";

	resolve() {
		return [
			listServicesTool,
			getServiceTool,
			listDeploysTool,
			listLogsTool,
			metricsTool,
		];
	}
}
