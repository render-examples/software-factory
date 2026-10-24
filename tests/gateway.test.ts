import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { config, type TaskName } from "../app/config/index.js";
import { TriageInput } from "../app/schemas/tasks.js";
import type { FactoryEvent } from "../app/events/index.js";
import { createGateway, type GatewayDeps } from "../app/gateway/index.js";

const SECRET = "webhook-secret";
const REPO = Object.keys(config.repos)[0] as string;

const triagePayload = {
	action: "labeled",
	label: { name: config.labels.triage },
	issue: { number: 12, labels: [{ name: config.labels.triage }] },
	repository: { full_name: REPO },
	installation: { id: 7 },
	sender: { login: "maintainer", type: "User" },
};

const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function webhook(body: string, { event = "issues", delivery = "delivery-1" as string | null, signature = sign(body) } = {}): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-github-event": event,
		"x-hub-signature-256": signature,
	};
	if (delivery) headers["x-github-delivery"] = delivery;
	return new Request("http://gateway/webhooks/github", { method: "POST", headers, body });
}

let startTask: Mock<GatewayDeps["startTask"]>;
let emit: Mock<(event: FactoryEvent) => Promise<void>>;
let app: ReturnType<typeof createGateway>;

beforeEach(() => {
	startTask = vi.fn(async (_task: TaskName, _input: object, _key: string) => ({ id: "trn-123" }));
	emit = vi.fn(async (_event: FactoryEvent) => {});
	app = createGateway({ startTask, emit, webhookSecret: SECRET });
});

const deliveryEvent = () => {
	expect(emit).toHaveBeenCalledTimes(1);
	const event = emit.mock.calls[0]?.[0] as FactoryEvent;
	expect(event.type).toBe("delivery.received");
	return event;
};

describe("gateway", () => {
	it("serves /health and /ready without the database", async () => {
		expect((await app.request("/health")).status).toBe(200);
		const ready = await app.request("/ready");
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ready" });
	});

	it("rejects a bad signature before parsing the body, without an event", async () => {
		const parse = vi.spyOn(JSON, "parse");
		const res = await app.fetch(webhook("{not json", { signature: sign("{not json", "wrong") }));
		expect(res.status).toBe(401);
		expect(parse).not.toHaveBeenCalled();
		parse.mockRestore();
		expect(startTask).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});

	it("rejects webhook bodies over 256 KB before starting work", async () => {
		const body = JSON.stringify({ padding: "x".repeat(256 * 1024) });
		const res = await app.fetch(webhook(body));
		expect(res.status).toBe(413);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("starts the routed task with the delivery id as idempotency key", async () => {
		const res = await app.fetch(webhook(JSON.stringify(triagePayload)));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ runId: "trn-123", task: "triage" });
		expect(startTask).toHaveBeenCalledTimes(1);
		const [task, input, key] = startTask.mock.calls[0] as [string, unknown, string];
		expect(task).toBe("triage");
		expect(key).toBe("delivery-1");
		expect(TriageInput.safeParse(input).success).toBe(true);

		const event = deliveryEvent();
		expect(event).toMatchObject({ traceId: "trn-123", runId: "trn-123", repo: REPO, subject: "issue#12" });
		expect(event.payload).toMatchObject({
			event: "issues",
			action: "labeled",
			outcome: "started",
			deliveryId: "delivery-1",
		});
	});

	it("returns 502 when startTask fails so GitHub records a failed delivery", async () => {
		startTask.mockRejectedValueOnce(new Error("render down"));
		const res = await app.fetch(webhook(JSON.stringify(triagePayload)));
		expect(res.status).toBe(502);
		const event = deliveryEvent();
		expect(event.traceId).toBe("delivery-1");
		expect(event.payload).toMatchObject({ outcome: "start failed", reason: "render down" });
	});
});

describe("run viewer", () => {
	const PASSWORD = "viewer-password-0123456789";
	const auth = (password = PASSWORD) => ({ authorization: `Basic ${Buffer.from(`factory:${password}`).toString("base64")}` });
	const run = (id: number) => ({
		id,
		traceId: `trn-${id}`,
		runId: `trn-${id}`,
		repo: REPO,
		subject: "issue#12",
		task: "triage",
		actor: "maintainer",
		startedAt: "2026-10-24T20:18:54.000Z",
		finishedAt: null,
		state: null,
		outcome: null,
		costUsd: null,
		agentRuns: 0,
	});
	const viewerApp = (viewer: Partial<NonNullable<GatewayDeps["viewer"]>> = {}) =>
		createGateway({
			startTask,
			emit,
			webhookSecret: SECRET,
			viewer: { password: PASSWORD, listRuns: vi.fn(async () => []), listTraceEvents: vi.fn(async () => []), ...viewer },
		});

	it("is off unless configured, and requires the password for the page and the API", async () => {
		expect((await app.request("/runs")).status).toBe(404);
		const viewer = viewerApp();
		for (const path of ["/runs", "/runs/app.js", "/api/runs", "/api/runs/trn-1/events"]) {
			expect((await viewer.request(path)).status).toBe(401);
			expect((await viewer.request(path, { headers: auth("wrong-password-0123456789") })).status).toBe(401);
		}
		const page = await viewer.request("/runs", { headers: auth() });
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('<script src="/runs/app.js"');
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
	});

	it("pages runs with a cursor, validates input, and reports when telemetry is off", async () => {
		const listRuns = vi.fn(async () => [run(9), run(8)]);
		const viewer = viewerApp({ listRuns });
		const res = await viewer.request("/api/runs?limit=2&before=10", { headers: auth() });
		expect(res.status).toBe(200);
		expect(listRuns).toHaveBeenCalledWith({ before: 10, limit: 2 });
		expect(await res.json()).toMatchObject({ runs: [{ id: 9 }, { id: 8 }], next: 8 });
		expect((await viewer.request("/api/runs?limit=0", { headers: auth() })).status).toBe(400);
		expect((await viewer.request("/api/runs/not%20a%20trace/events", { headers: auth() })).status).toBe(400);

		const off = viewerApp({ listRuns: vi.fn(async () => null), listTraceEvents: vi.fn(async () => null) });
		expect((await off.request("/api/runs", { headers: auth() })).status).toBe(503);
		expect((await off.request("/api/runs/trn-1/events", { headers: auth() })).status).toBe(503);
	});
});
