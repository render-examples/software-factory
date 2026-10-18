import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { StoredEvent, TraceSummary } from "../app/events/index.js";
import type { EventsReader } from "../app/gateway/index.js";

const pg = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("pg", () => {
	class Pool {
		query = pg.query;
		end = async () => {};
		on() {
			return this;
		}
	}
	return { default: { Pool } };
});

const { createGateway } = await import("../app/gateway/index.js");
const { recentEvents, closeEvents } = await import("../app/events/index.js");
const { buildTrace } = await import("../app/gateway/ui/model.js");

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
	ev("run.started", 1, { phase: "triage", actor: "maintainer" }),
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
	ev("run.finished", 10, { phase: "triage", state: "done", outcome: XSS, costUsd: 0.0123, durationMs: 9000 }),
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

async function sessionCookie(app: ReturnType<typeof gateway>): Promise<string> {
	const res = await login(app, { token: TOKEN });
	const setCookie = res.headers.get("set-cookie") ?? "";
	return setCookie.split(";")[0] as string;
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
	it("redirects to login with the original path as next", async () => {
		const app = gateway();
		const res = await app.request("/ui/traces/trn-1?x=1");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(`/ui/login?next=${encodeURIComponent("/ui/traces/trn-1?x=1")}`);
		expect(events.traceEvents).not.toHaveBeenCalled();
	});

	it("renders the login form with a sanitized next", async () => {
		const app = gateway();
		const ok = await app.request("/ui/login?next=%2Fui%2Ftraces%2Ftrn-1");
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain('value="/ui/traces/trn-1"');
		const evil = await app.request("/ui/login?next=https%3A%2F%2Fevil.example");
		const html = await evil.text();
		expect(html).toContain('name="next" value="/ui"');
		expect(html).not.toContain("evil.example");
	});

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

	it("marks the cookie Secure over https, including behind a TLS-terminating proxy", async () => {
		const app = gateway();
		const direct = await login(app, { token: TOKEN }, "https://gw/ui/login");
		expect(direct.headers.get("set-cookie")).toContain("Secure");
		const proxied = await app.request("http://gw/ui/login", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
			body: `token=${TOKEN}`,
		});
		expect(proxied.headers.get("set-cookie")).toContain("Secure");
	});

	it("lets a session cookie in and logs out by clearing it", async () => {
		const app = gateway();
		const cookie = await sessionCookie(app);
		const page = await app.request("/ui", { headers: { cookie } });
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("no-store");

		const out = await app.request("/ui/logout", { method: "POST", headers: { cookie } });
		expect(out.status).toBe(303);
		expect(out.headers.get("location")).toBe("/ui/login");
		expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
	});

	it("rejects a session signed with a different admin token", async () => {
		const cookie = await sessionCookie(gateway("old-token"));
		const res = await gateway().request("/ui", { headers: { cookie } });
		expect(res.status).toBe(302);
	});

	it("answers 503 everywhere under /ui and /api without an admin token, and keeps the webhook side up", async () => {
		const app = gateway(null);
		for (const path of ["/ui", "/ui/login", "/ui/traces/trn-1", "/ui/deliveries"]) {
			const res = await app.request(path);
			expect(res.status).toBe(503);
			expect(await res.text()).toContain("FACTORY_ADMIN_TOKEN is not set");
		}
		const api = await app.request("/api/traces", { headers: { authorization: "Bearer " } });
		expect(api.status).toBe(503);
		expect(await api.json()).toEqual({ error: expect.stringContaining("FACTORY_ADMIN_TOKEN") });
		expect((await login(app, { token: "" })).status).toBe(503);
		expect((await gateway("   ").request("/ui")).status).toBe(503);
		expect((await app.request("/health")).status).toBe(200);
		expect(events.listTraces).not.toHaveBeenCalled();
	});
});

describe("api auth", () => {
	it("requires a bearer token or a session cookie", async () => {
		const app = gateway();
		const none = await app.request("/api/traces");
		expect(none.status).toBe(401);
		expect(none.headers.get("www-authenticate")).toContain("Bearer");
		expect((await app.request("/api/traces", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
		expect((await app.request("/api/traces", { headers: { authorization: TOKEN } })).status).toBe(401);

		const bearer = await app.request("/api/traces", { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(bearer.status).toBe(200);

		const cookie = await sessionCookie(app);
		expect((await app.request("/api/traces", { headers: { cookie } })).status).toBe(200);
	});
});

describe("api", () => {
	const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

	it("lists traces with run summaries", async () => {
		const res = await gateway().request("/api/traces?repo=acme/web&limit=2", auth);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { traces: Record<string, unknown>[]; nextBefore: string | null };
		expect(events.listTraces).toHaveBeenCalledWith({ repo: "acme/web", limit: 2, before: undefined });
		expect(events.recentEvents).toHaveBeenCalledWith({
			types: ["delivery.received", "run.started", "run.finished"],
			traceIds: ["trn-1", "d-ignored"],
			limit: 2000,
		});
		expect(body.traces[0]).toMatchObject({
			traceId: "trn-1",
			phase: "triage",
			state: "done",
			costUsd: 0.0123,
			durationMs: 9000,
			lastAt: at(10).toISOString(),
		});
		expect(body.nextBefore).toBe(at(-60).toISOString());
	});

	it("passes the before cursor as a Date and treats empty params as absent", async () => {
		const before = "2026-10-18T11:00:00.000Z";
		const res = await gateway().request(`/api/traces?repo=&before=${before}`, auth);
		expect(res.status).toBe(200);
		expect(events.listTraces).toHaveBeenCalledWith({ repo: undefined, limit: 50, before: new Date(before) });
		expect(((await res.json()) as { nextBefore: unknown }).nextBefore).toBeNull();
	});

	it("returns one trace's events and totals", async () => {
		const res = await gateway().request("/api/traces/trn-1", auth);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: unknown[]; totals: Record<string, unknown> };
		expect(events.traceEvents).toHaveBeenCalledWith("trn-1");
		expect(body.events).toHaveLength(5);
		expect(body.totals).toMatchObject({ costUsd: 0.0123, durationMs: 9000, agentCalls: 1 });
	});

	it("404s an unknown trace", async () => {
		events.traceEvents.mockResolvedValueOnce([]);
		expect((await gateway().request("/api/traces/nope", auth)).status).toBe(404);
	});

	it.each([
		"/api/traces?limit=abc",
		"/api/traces?limit=0",
		"/api/traces?limit=1.5",
		"/api/traces?limit=100000",
		"/api/traces?before=yesterday",
		"/api/traces?before=2026-13-45T00:00:00Z",
		"/api/traces?repo=not-a-repo",
		"/api/traces?repo=a/b/c",
		"/api/traces/bad%20id",
		`/api/traces/${"x".repeat(300)}`,
	])("answers 400 for %s", async (path) => {
		const res = await gateway().request(path, auth);
		expect(res.status).toBe(400);
		expect(events.listTraces).not.toHaveBeenCalled();
		expect(events.traceEvents).not.toHaveBeenCalled();
	});

	it("answers 503, not 500, when the events database fails", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		events.listTraces.mockRejectedValueOnce(new Error("DATABASE_URL is not set"));
		const res = await gateway().request("/api/traces", auth);
		expect(res.status).toBe(503);
		expect(JSON.stringify(await res.json())).not.toContain("DATABASE_URL");
		stderr.mockRestore();
	});
});

describe("ui pages", () => {
	async function page(path: string) {
		const app = gateway();
		const cookie = await sessionCookie(app);
		return app.request(path, { headers: { cookie } });
	}

	it("lists traces with repo, linked subject, phase, state, cost, and duration", async () => {
		const res = await page("/ui");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('href="/ui/traces/trn-1"');
		expect(html).toContain('href="https://github.com/acme/web/issues/12"');
		expect(html).toContain("acme/web");
		expect(html).toContain("triage");
		expect(html).toContain("badge-done");
		expect(html).toContain("$0.0123");
		expect(html).toContain("9.0s");
		expect(html).toContain("badge-ignored");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("links to the next page with a before cursor and keeps the repo filter", async () => {
		events.listTraces.mockResolvedValueOnce(summaryFixture().slice(0, 1));
		const html = await (await page("/ui?repo=acme/web&limit=1")).text();
		expect(events.listTraces).toHaveBeenCalledWith({ repo: "acme/web", limit: 1, before: undefined });
		expect(html).toContain(`before=${encodeURIComponent(at(10).toISOString())}`);
		expect(html).toContain("repo=acme%2Fweb");
		expect(html).toContain('value="acme/web"');
	});

	it("renders a trace timeline with agent calls, durations, totals, and escaped payloads", async () => {
		const res = await page("/ui/traces/trn-1");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("run started");
		expect(html).toContain("run finished");
		expect(html).toContain("triager");
		expect(html).toContain("anthropic/claude-x");
		expect(html).toContain("turns 3");
		expect(html).toContain("1,200 in / 300 out");
		expect(html).toContain("5.0s");
		expect(html).toContain("9.0s");
		expect(html).toContain("$0.0123");
		expect(html).toContain("issues.labeled");
		expect(html).toContain("@maintainer");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
	});

	it("404s an unknown trace and 400s a malformed id", async () => {
		events.traceEvents.mockResolvedValueOnce([]);
		expect((await page("/ui/traces/nope")).status).toBe(404);
		expect((await page("/ui/traces/%3Cscript%3E")).status).toBe(400);
	});

	it("lists deliveries with outcome and escaped reason", async () => {
		const res = await page("/ui/deliveries?repo=acme/web");
		expect(res.status).toBe(200);
		expect(events.recentEvents).toHaveBeenCalledWith({
			types: ["delivery.received"],
			repo: "acme/web",
			limit: 100,
			before: undefined,
		});
		const html = await res.text();
		expect(html).toContain("ping");
		expect(html).toContain("badge-ignored");
		expect(html).toContain('href="/ui/traces/d-ignored"');
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it.each(["/ui?limit=abc", "/ui?before=nope", "/ui?repo=%3Cscript%3E", "/ui/deliveries?limit=-1", "/ui/deliveries?before=x"])(
		"answers 400 for %s without echoing raw input",
		async (path) => {
			const res = await page(path);
			expect(res.status).toBe(400);
			expect(await res.text()).not.toContain("<script>");
		},
	);

	it("answers 503 when the events database fails", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		events.traceEvents.mockRejectedValueOnce(new Error("boom"));
		expect((await page("/ui/traces/trn-1")).status).toBe(503);
		stderr.mockRestore();
	});
});

describe("buildTrace", () => {
	it("pairs concurrent calls of the same agent in order and keeps unfinished ones running", () => {
		const view = buildTrace("trn-1", [
			ev("agent.started", 0, { agentId: "reviewer" }),
			ev("agent.started", 1, { agentId: "reviewer" }),
			ev("agent.finished", 4, { agentId: "reviewer", outcome: "ok", costUsd: 0.5, usage }),
			ev("agent.started", 5, { agentId: "fixer" }),
			ev("cost", 6, {}),
		]);
		const agents = view.items.filter((i) => i.kind === "agent");
		expect(agents).toHaveLength(3);
		expect(agents[0]).toMatchObject({ outcome: "ok", durationMs: 4000 });
		expect(agents[1]?.kind === "agent" && agents[1].outcome).toBeUndefined();
		expect(agents[1]?.kind === "agent" && agents[1].durationMs).toBeUndefined();
		expect(view.items.at(-1)).toMatchObject({ kind: "other", type: "cost" });
		expect(view.totals).toMatchObject({ costUsd: 0.5, agentCalls: 3, durationMs: 6000, durationFromRun: false });
	});
});

describe("recentEvents", () => {
	beforeEach(() => {
		vi.stubEnv("DATABASE_URL", "postgres://fake/db");
		pg.query.mockReset();
	});

	afterEach(async () => {
		await closeEvents();
		vi.unstubAllEnvs();
	});

	it("filters by type, trace, repo, and time, newest first", async () => {
		pg.query.mockResolvedValueOnce({
			rows: [
				{
					id: "9",
					trace_id: "d-1",
					run_id: null,
					repo: "acme/web",
					subject: null,
					type: "delivery.received",
					payload: { outcome: "ignored" },
					created_at: T0,
				},
			],
		});
		const before = new Date("2026-10-18T13:00:00Z");
		const rows = await recentEvents({ types: ["delivery.received"], repo: "acme/web", limit: 10, before });
		const [sql, params] = pg.query.mock.calls[0] as [string, unknown[]];
		expect(sql).toMatch(/type = any\(\$1\)/);
		expect(sql).toMatch(/order by id desc/);
		expect(params).toEqual([["delivery.received"], null, "acme/web", before, 10]);
		expect(rows).toEqual([
			{
				id: "9",
				traceId: "d-1",
				runId: undefined,
				repo: "acme/web",
				subject: undefined,
				type: "delivery.received",
				payload: { outcome: "ignored" },
				createdAt: T0,
			},
		]);
	});

	it("clamps the limit", async () => {
		pg.query.mockResolvedValueOnce({ rows: [] });
		await recentEvents({ limit: 1_000_000 });
		expect((pg.query.mock.calls[0] as [string, unknown[]])[1]).toEqual([null, null, null, null, 2000]);
	});
});
