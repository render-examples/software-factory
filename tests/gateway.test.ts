import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { config, type TaskName } from "../app/config/index.js";
import { TriageInput } from "../app/schemas/tasks.js";
import { createGateway, type GatewayDeps } from "../app/gateway/index.js";
import { REPO } from "./fixtures/config.js";

const SECRET = "webhook-secret";

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
let app: ReturnType<typeof createGateway>;

beforeEach(() => {
	startTask = vi.fn(async (_task: TaskName, _input: object, _key: string) => ({ id: "trn-123" }));
	app = createGateway({ startTask, webhookSecret: SECRET });
});

describe("gateway", () => {
	it("serves /health and /ready", async () => {
		expect((await app.request("/health")).status).toBe(200);
		const ready = await app.request("/ready");
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ready" });
	});

	it("tells a browser at / that the headless gateway is running, without revealing its secret", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("software-factory gateway is running");
		expect(text).toContain("no web UI");
		expect(text).not.toContain(SECRET);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("rejects a bad signature before parsing the body", async () => {
		const parse = vi.spyOn(JSON, "parse");
		const res = await app.fetch(webhook("{not json", { signature: sign("{not json", "wrong") }));
		expect(res.status).toBe(401);
		expect(parse).not.toHaveBeenCalled();
		parse.mockRestore();
		expect(startTask).not.toHaveBeenCalled();
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
	});

	it("returns 502 and logs why when startTask fails, so GitHub records a failed delivery", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		startTask.mockRejectedValueOnce(new Error("render down"));
		const res = await app.fetch(webhook(JSON.stringify(triagePayload)));
		expect(res.status).toBe(502);
		expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({
			msg: "could not start task",
			deliveryId: "delivery-1",
			error: "render down",
		});
		warn.mockRestore();
	});
});
