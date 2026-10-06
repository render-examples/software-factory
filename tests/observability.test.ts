import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	constantTimeEqual,
	parseCookies,
	sessionClearCookie,
	sessionCookieName,
	SESSION_MAX_AGE_SECONDS,
	sessionSetCookie,
	signSession,
	verifySession,
} from "../app/gateway/auth.js";
import { buildSpanTree } from "../app/gateway/ui/spans.js";
import type { RunEventRecord } from "../app/store/types.js";

// ── Constant-time comparison ────────────────────────────────────────

describe("constantTimeEqual", () => {
	it("returns true for identical strings", () => {
		expect(constantTimeEqual("secret123", "secret123")).toBe(true);
	});

	it("returns false for different strings of the same length", () => {
		expect(constantTimeEqual("secret123", "secret456")).toBe(false);
	});

	it("returns false for different lengths", () => {
		expect(constantTimeEqual("short", "longer-string")).toBe(false);
	});

	it("returns false for empty vs non-empty", () => {
		expect(constantTimeEqual("", "nonempty")).toBe(false);
	});

	it("returns true for two empty strings", () => {
		expect(constantTimeEqual("", "")).toBe(true);
	});
});

// ── Session cookie sign/verify ──────────────────────────────────────

describe("session cookie", () => {
	const adminToken = "a".repeat(32);

	it("sign then verify round-trips", () => {
		const value = signSession(adminToken);
		expect(verifySession(value, adminToken)).toBe(true);
	});

	it("rejects a tampered signature", () => {
		const value = signSession(adminToken);
		const tampered = `${value}ff`;
		expect(verifySession(tampered, adminToken)).toBe(false);
	});

	it("rejects a tampered nonce", () => {
		const value = signSession(adminToken);
		const [issuedAt, , sig] = value.split(".");
		expect(verifySession(`${issuedAt}.0000.${sig}`, adminToken)).toBe(false);
	});

	it("rejects a tampered issue time", () => {
		const value = signSession(adminToken);
		const [, nonce, sig] = value.split(".");
		expect(verifySession(`${Date.now() + 1}.${nonce}.${sig}`, adminToken)).toBe(
			false,
		);
	});

	it("expires after the session lifetime", () => {
		const issued = 1_000_000;
		const value = signSession(adminToken, issued);
		expect(verifySession(value, adminToken, issued + 60_000)).toBe(true);
		expect(
			verifySession(
				value,
				adminToken,
				issued + SESSION_MAX_AGE_SECONDS * 1000 + 1,
			),
		).toBe(false);
	});

	it("rejects with a different admin token", () => {
		const value = signSession(adminToken);
		expect(verifySession(value, "b".repeat(32))).toBe(false);
	});

	it("rejects missing dot separator", () => {
		expect(verifySession("nodot", adminToken)).toBe(false);
	});

	it("rejects empty nonce", () => {
		expect(verifySession("1..sig", adminToken)).toBe(false);
	});

	it("rejects empty signature", () => {
		expect(verifySession("1.nonce.", adminToken)).toBe(false);
	});
});

describe("parseCookies", () => {
	it("parses a multi-cookie header", () => {
		const result = parseCookies("a=1; b=hello; c=world");
		expect(result).toEqual({ a: "1", b: "hello", c: "world" });
	});

	it("returns empty for null", () => {
		expect(parseCookies(null)).toEqual({});
	});
});

describe("cookie helpers", () => {
	it("sessionSetCookie includes required flags", () => {
		const cookie = sessionSetCookie("val");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain(sessionCookieName());
	});

	it("sessionClearCookie sets Max-Age=0", () => {
		const cookie = sessionClearCookie();
		expect(cookie).toContain("Max-Age=0");
	});
});

// ── API auth (using the gateway) ────────────────────────────────────

const storeMocks = vi.hoisted(() => ({
	ping: vi.fn(),
	listRuns: vi.fn(),
	getRun: vi.fn(),
	listConversation: vi.fn(),
	listEventsByRun: vi.fn(),
	listArtifactsByRun: vi.fn(),
	listDeliveries: vi.fn(),
	getSpec: vi.fn(),
	listSpecVersions: vi.fn(),
	getArtifactByLinkToken: vi.fn(),
	getArtifactForServing: vi.fn(),
	acceptDelivery: vi.fn(),
	recordDelivery: vi.fn(),
	requestCancel: vi.fn(),
	findActiveRunForSubject: vi.fn(),
	getCurrentSpec: vi.fn(),
	appendEvent: vi.fn(),
}));

vi.mock("../app/store/index.js", () => ({
	ping: storeMocks.ping,
	listRuns: storeMocks.listRuns,
	getRun: storeMocks.getRun,
	listConversation: storeMocks.listConversation,
	listArtifactsByRun: storeMocks.listArtifactsByRun,
	listDeliveries: storeMocks.listDeliveries,
	getSpec: storeMocks.getSpec,
	listSpecVersions: storeMocks.listSpecVersions,
	getArtifactByLinkToken: storeMocks.getArtifactByLinkToken,
	getArtifactForServing: storeMocks.getArtifactForServing,
	acceptDelivery: storeMocks.acceptDelivery,
	recordDelivery: storeMocks.recordDelivery,
	requestCancel: storeMocks.requestCancel,
	findActiveRunForSubject: storeMocks.findActiveRunForSubject,
	getCurrentSpec: storeMocks.getCurrentSpec,
}));

vi.mock("../app/store/events.js", () => ({
	appendEvent: storeMocks.appendEvent,
	listEventsByRun: storeMocks.listEventsByRun,
}));

vi.mock("../app/store/queries.js", () => ({
	listRuns: storeMocks.listRuns,
	listConversation: storeMocks.listConversation,
	listArtifactsByRun: storeMocks.listArtifactsByRun,
	listDeliveries: storeMocks.listDeliveries,
	listSpecVersions: storeMocks.listSpecVersions,
	getArtifactForServing: storeMocks.getArtifactForServing,
}));

const { createGateway } = await import("../app/gateway/index.js");

const ADMIN_TOKEN = "x".repeat(32);

function apiGet(path: string, token?: string) {
	const headers: Record<string, string> = {};
	if (token !== undefined) {
		headers.authorization = `Bearer ${token}`;
	}
	return createGateway().request(path, { headers });
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.FACTORY_ADMIN_TOKEN = ADMIN_TOKEN;
	storeMocks.ping.mockResolvedValue(undefined);
	storeMocks.acceptDelivery.mockResolvedValue({
		outcome: "accepted",
		runCreated: true,
	});
	storeMocks.recordDelivery.mockResolvedValue(undefined);
	storeMocks.appendEvent.mockResolvedValue("1");
});

describe("API auth", () => {
	it("returns 401 when no Authorization header is present", async () => {
		const res = await apiGet("/api/runs");
		expect(res.status).toBe(401);
	});

	it("returns 401 with a wrong token", async () => {
		const res = await apiGet("/api/runs", "wrong-token");
		expect(res.status).toBe(401);
	});

	it("returns 200 with the correct token", async () => {
		storeMocks.listRuns.mockResolvedValue([]);
		const res = await apiGet("/api/runs", ADMIN_TOKEN);
		expect(res.status).toBe(200);
	});
});

describe("GET /api/runs", () => {
	it("returns runs with filters applied", async () => {
		const sampleRun = {
			id: "run-1",
			repo: "o/r",
			subjectKind: "issue",
			subjectNumber: 42,
			workflow: "triage",
			status: "completed",
			stage: null,
			outcome: "asked",
			result: null,
			summary: "questions posted",
			trigger: null,
			input: null,
			previousRunId: null,
			cancelRequestedAt: null,
			dispatchAttempts: 1,
			dispatchAfter: null,
			dispatchedAt: null,
			heartbeatAt: null,
			startedAt: null,
			completedAt: null,
			costUsd: 0.15,
			createdAt: "2026-10-05T00:00:00.000Z",
			updatedAt: "2026-10-05T00:00:00.000Z",
		};
		storeMocks.listRuns.mockResolvedValue([sampleRun]);

		const res = await apiGet(
			"/api/runs?workflow=triage&status=completed",
			ADMIN_TOKEN,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.runs).toHaveLength(1);
		expect(body.runs[0].id).toBe("run-1");
	});
});

describe("GET /api/runs/:id", () => {
	it("returns 404 for unknown run", async () => {
		storeMocks.getRun.mockResolvedValue(null);
		const res = await apiGet("/api/runs/unknown", ADMIN_TOKEN);
		expect(res.status).toBe(404);
	});

	it("returns the run and its conversation", async () => {
		const run = { id: "run-1", workflow: "triage" };
		storeMocks.getRun.mockResolvedValue(run);
		storeMocks.listConversation.mockResolvedValue([run]);

		const res = await apiGet("/api/runs/run-1", ADMIN_TOKEN);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.run.id).toBe("run-1");
		expect(body.conversation).toHaveLength(1);
	});
});

describe("GET /api/runs/:id/artifacts — no bytes or hashes leaked", () => {
	it("returns metadata without bytes or linkTokenHash", async () => {
		storeMocks.getRun.mockResolvedValue({ id: "run-1" });
		storeMocks.listArtifactsByRun.mockResolvedValue([
			{
				id: "art-1",
				runId: "run-1",
				kind: "screenshot",
				contentType: "image/png",
				size: 1024,
				sha256: "abc",
				linkTokenHash: null,
				createdAt: "2026-10-05T00:00:00.000Z",
				expiresAt: "2026-11-05T00:00:00.000Z",
			},
		]);

		const res = await apiGet("/api/runs/run-1/artifacts", ADMIN_TOKEN);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.artifacts[0].linkTokenHash).toBeNull();
		expect(body.artifacts[0]).not.toHaveProperty("bytes");
	});
});

describe("GET /api/deliveries", () => {
	it("returns deliveries", async () => {
		storeMocks.listDeliveries.mockResolvedValue([
			{
				deliveryId: "del-1",
				event: "issues",
				action: "labeled",
				outcome: "accepted",
				detail: null,
				receivedAt: "2026-10-05T00:00:00.000Z",
			},
		]);
		const res = await apiGet("/api/deliveries", ADMIN_TOKEN);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.deliveries).toHaveLength(1);
	});
});

describe("GET /api/specs/:id", () => {
	it("returns spec with versions", async () => {
		storeMocks.getSpec.mockResolvedValue({
			id: "spec-1",
			status: "draft",
			currentVersion: 2,
		});
		storeMocks.listSpecVersions.mockResolvedValue([
			{ specId: "spec-1", version: 1 },
			{ specId: "spec-1", version: 2 },
		]);
		const res = await apiGet("/api/specs/spec-1", ADMIN_TOKEN);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.spec.id).toBe("spec-1");
		expect(body.versions).toHaveLength(2);
	});

	it("returns 404 for unknown spec", async () => {
		storeMocks.getSpec.mockResolvedValue(null);
		const res = await apiGet("/api/specs/unknown", ADMIN_TOKEN);
		expect(res.status).toBe(404);
	});
});

// ── Artifact link routes ────────────────────────────────────────────

describe("GET /a/:token (public artifact link)", () => {
	it("serves an image inline", async () => {
		storeMocks.getArtifactByLinkToken.mockResolvedValue({
			record: {
				id: "art-1",
				contentType: "image/png",
			},
			bytes: Buffer.from("png-data"),
		});

		const res = await createGateway().request("/a/valid-token");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toBe(
			"default-src 'none'",
		);
		expect(res.headers.get("content-disposition")).toBeNull();
	});

	it("serves non-image as attachment", async () => {
		storeMocks.getArtifactByLinkToken.mockResolvedValue({
			record: {
				id: "art-2",
				contentType: "application/json",
			},
			bytes: Buffer.from("{}"),
		});

		const res = await createGateway().request("/a/some-token");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toBe("attachment");
	});

	it("returns 404 for expired or unknown token", async () => {
		storeMocks.getArtifactByLinkToken.mockResolvedValue(null);
		const res = await createGateway().request("/a/expired-token");
		expect(res.status).toBe(404);
	});
});

// ── Span tree builder ───────────────────────────────────────────────

function mkEvent(overrides: Partial<RunEventRecord>): RunEventRecord {
	return {
		id: "1",
		runId: "run-1",
		type: "stage",
		stage: null,
		spanId: null,
		parentSpanId: null,
		phase: null,
		payload: null,
		createdAt: "2026-10-05T00:00:00.000Z",
		...overrides,
	};
}

describe("buildSpanTree", () => {
	it("nests children under their parent", () => {
		const events: RunEventRecord[] = [
			mkEvent({
				id: "1",
				spanId: "root",
				phase: "start",
				type: "stage",
				createdAt: "2026-10-05T00:00:00.000Z",
			}),
			mkEvent({
				id: "2",
				spanId: "child",
				parentSpanId: "root",
				phase: "start",
				type: "agent.run",
				createdAt: "2026-10-05T00:00:01.000Z",
			}),
			mkEvent({
				id: "3",
				spanId: "child",
				parentSpanId: "root",
				phase: "end",
				type: "agent.run",
				createdAt: "2026-10-05T00:00:05.000Z",
			}),
			mkEvent({
				id: "4",
				spanId: "root",
				phase: "end",
				type: "stage",
				createdAt: "2026-10-05T00:00:10.000Z",
			}),
		];

		const tree = buildSpanTree(events);
		expect(tree).toHaveLength(1);
		expect(tree[0].spanId).toBe("root");
		expect(tree[0].durationMs).toBe(10_000);
		expect(tree[0].children).toHaveLength(1);
		expect(tree[0].children[0].spanId).toBe("child");
		expect(tree[0].children[0].durationMs).toBe(4_000);
	});

	it("handles unmatched starts (no end)", () => {
		const events: RunEventRecord[] = [
			mkEvent({
				id: "1",
				spanId: "open",
				phase: "start",
				type: "stage",
				createdAt: "2026-10-05T00:00:00.000Z",
			}),
		];

		const tree = buildSpanTree(events);
		expect(tree).toHaveLength(1);
		expect(tree[0].endedAt).toBeNull();
		expect(tree[0].durationMs).toBeNull();
	});

	it("shows points inline", () => {
		const events: RunEventRecord[] = [
			mkEvent({
				id: "1",
				spanId: "root",
				phase: "start",
				type: "stage",
				createdAt: "2026-10-05T00:00:00.000Z",
			}),
			mkEvent({
				id: "2",
				spanId: "pt1",
				parentSpanId: "root",
				phase: "point",
				type: "agent.cost",
				payload: { costUsd: 0.05 },
				createdAt: "2026-10-05T00:00:02.000Z",
			}),
			mkEvent({
				id: "3",
				spanId: "root",
				phase: "end",
				type: "stage",
				createdAt: "2026-10-05T00:00:05.000Z",
			}),
		];

		const tree = buildSpanTree(events);
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		expect(tree[0].children[0].phase).toBe("point");
		expect(tree[0].children[0].type).toBe("agent.cost");
	});

	it("returns empty for no events", () => {
		expect(buildSpanTree([])).toEqual([]);
	});
});

// ── HTML escaping ───────────────────────────────────────────────────

describe("HTML escaping of model-supplied strings", () => {
	it("Hono JSX escapes <script> tags in rendered HTML", async () => {
		storeMocks.listRuns.mockResolvedValue([
			{
				id: "run-xss",
				repo: "o/r",
				subjectKind: "issue",
				subjectNumber: 1,
				workflow: '<script>alert("xss")</script>',
				status: "completed",
				stage: '<img onerror="alert(1)" src=x>',
				outcome: null,
				result: null,
				summary: null,
				trigger: null,
				input: null,
				previousRunId: null,
				cancelRequestedAt: null,
				dispatchAttempts: 0,
				dispatchAfter: null,
				dispatchedAt: null,
				heartbeatAt: null,
				startedAt: null,
				completedAt: null,
				costUsd: 0,
				createdAt: "2026-10-05T00:00:00.000Z",
				updatedAt: "2026-10-05T00:00:00.000Z",
			},
		]);

		const sessionValue = signSession(ADMIN_TOKEN);
		const res = await createGateway().request("/ui", {
			headers: {
				cookie: `${sessionCookieName()}=${sessionValue}`,
			},
		});
		expect(res.status).toBe(200);
		const html = await res.text();

		expect(html).not.toContain("<script>");
		expect(html).not.toContain('onerror="');
		expect(html).toContain("&lt;script&gt;");
	});
});
