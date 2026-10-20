import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { StoredEvent, TraceSummary } from "../app/events/index.js";
import type { EventsReader } from "../app/gateway/index.js";

const { createGateway } = await import("../app/gateway/index.js");

const TOKEN = "admin-token-123";
const T0 = new Date("2026-10-18T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const XSS = "<script>alert(1)</script>";

let seq = 0;
function ev(type: string, seconds: number, payload: Record<string, unknown>, extra: Partial<StoredEvent> = {}): StoredEvent {
	seq++;
	return {
		id: String(seq),
		traceId: "trn-1",
		runId: "trn-1",
		repo: "acme/web",
		subject: "issue#12",
		type,
		payload,
		createdAt: at(seconds),
		...extra,
	};
}

const usage = { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0 };
const traceFixture = (): StoredEvent[] => [
	ev("delivery.received", 0, {
		event: "issues",
		action: "labeled",
		outcome: "started",
		task: "triage",
		deliveryId: "d-1",
	}),
	ev("run.started", 1, { stage: "triage", actor: "maintainer" }),
	ev("agent.started", 2, { agentId: "triager", model: "anthropic/claude-x", where: "task", tools: [] }),
	ev("agent.finished", 7, {
		agentId: "triager",
		model: "anthropic/claude-x",
		outcome: "ok",
		turns: 3,
		usage,
		costUsd: 0.0123,
		message: XSS,
	}),
	ev("run.finished", 10, { stage: "triage", state: "done", outcome: XSS, costUsd: 0.0123, durationMs: 9000 }),
];

const summaryFixture = (): TraceSummary[] => [
	{
		traceId: "trn-1",
		repo: "acme/web",
		subject: "issue#12",
		firstAt: at(0),
		lastAt: at(10),
		eventCount: 5,
		firstType: "delivery.received",
		lastType: "run.finished",
	},
	{
		traceId: "d-ignored",
		repo: "acme/web",
		subject: null,
		firstAt: at(-60),
		lastAt: at(-60),
		eventCount: 1,
		firstType: "delivery.received",
		lastType: "delivery.received",
	},
];

let events: { [K in keyof EventsReader]: Mock<EventsReader[K]> };

function gateway(adminToken: string | null = TOKEN) {
	return createGateway({
		startTask: async () => ({ id: "trn-x" }),
		emit: async () => {},
		webhookSecret: "secret",
		adminToken: adminToken ?? undefined,
		events,
	});
}

async function login(app: ReturnType<typeof gateway>, form: Record<string, string>, url = "http://gw/ui/login") {
	return app.request(url, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
	});
}

beforeEach(() => {
	seq = 0;
	events = {
		listTraces: vi.fn(async () => summaryFixture()),
		traceEvents: vi.fn(async () => traceFixture()),
		recentEvents: vi.fn(async (opts) =>
			opts.types?.length === 1 && opts.types[0] === "delivery.received"
				? [
						ev(
							"delivery.received",
							-60,
							{ event: "ping", outcome: "ignored", reason: XSS, deliveryId: "d-ignored" },
							{ traceId: "d-ignored", runId: undefined, subject: undefined },
						),
					]
				: traceFixture().filter((e) => opts.types?.includes(e.type) ?? true),
		),
	};
});

describe("ui auth", () => {
	it("rejects a wrong token without a cookie", async () => {
		const res = await login(gateway(), { token: "wrong" });
		expect(res.status).toBe(401);
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(await res.text()).toContain("Invalid token");
	});

	it("sets a Lax, HttpOnly session cookie and redirects to a validated next", async () => {
		const app = gateway();
		const res = await login(app, { token: TOKEN, next: "/ui/traces/trn-1" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/ui/traces/trn-1");
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(/^factory_session=\d+\.[\w-]+\.[\w-]+;/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Max-Age=43200");
		expect(cookie).not.toContain("Secure");

		const offsite = await login(app, { token: TOKEN, next: "//evil.example/ui" });
		expect(offsite.headers.get("location")).toBe("/ui");
	});

	it("rejects a malformed session cookie at the HTTP boundary", async () => {
		const res = await gateway().request("/ui", { headers: { cookie: "factory_session=not-a-session" } });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/ui/login?next=%2Fui");
	});
});

describe("api", () => {
	const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

	it("returns one trace's events and totals", async () => {
		const res = await gateway().request("/api/traces/trn-1", auth);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: unknown[]; totals: Record<string, unknown> };
		expect(events.traceEvents).toHaveBeenCalledWith("trn-1");
		expect(body.events).toHaveLength(5);
		expect(body.totals).toMatchObject({ costUsd: 0.0123, durationMs: 9000, agentCalls: 1 });
	});
});
