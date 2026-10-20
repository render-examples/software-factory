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
