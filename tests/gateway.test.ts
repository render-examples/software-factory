import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	acceptDelivery: vi.fn(),
	finishRun: vi.fn(),
	recordDelivery: vi.fn(),
	requestCancel: vi.fn(),
	findActiveRunForSubject: vi.fn(),
	getCurrentSpec: vi.fn(),
	ping: vi.fn(),
	appendEvent: vi.fn(),
}));

vi.mock("../app/store/index.js", () => ({
	acceptDelivery: mocks.acceptDelivery,
	finishRun: mocks.finishRun,
	recordDelivery: mocks.recordDelivery,
	requestCancel: mocks.requestCancel,
	findActiveRunForSubject: mocks.findActiveRunForSubject,
	getCurrentSpec: mocks.getCurrentSpec,
	ping: mocks.ping,
}));

vi.mock("../app/store/events.js", () => ({
	appendEvent: mocks.appendEvent,
}));

const { createGateway } = await import("../app/gateway/index.js");

const SECRET = "webhook-secret";

function issuePayload(overrides: Record<string, unknown> = {}) {
	return {
		action: "labeled",
		issue: {
			number: 42,
			labels: [{ name: "factory:full-run" }],
		},
		label: { name: "factory:full-run" },
		repository: {
			full_name: "jacobprall/render-factory-sample",
		},
		sender: { login: "Maintainer", id: 1, type: "User" },
		...overrides,
	};
}

function commentPayload(overrides: Record<string, unknown> = {}) {
	return {
		action: "created",
		issue: {
			number: 42,
			labels: [{ name: "factory:triage" }],
		},
		comment: {
			id: 100,
			body: "Here is more detail about the issue",
			author_association: "OWNER",
			user: { login: "Maintainer", id: 1, type: "User" },
		},
		repository: {
			full_name: "jacobprall/render-factory-sample",
		},
		sender: { login: "Maintainer", id: 1, type: "User" },
		...overrides,
	};
}

function prPayload(overrides: Record<string, unknown> = {}) {
	return {
		action: "labeled",
		pull_request: {
			number: 10,
			head: { sha: "abc123" },
		},
		label: { name: "factory:pr-review" },
		repository: {
			full_name: "jacobprall/render-factory-sample",
		},
		sender: { login: "Maintainer", id: 1, type: "User" },
		...overrides,
	};
}

function post(
	body: unknown,
	opts: {
		signature?: string;
		event?: string;
		delivery?: string | null;
	} = {},
) {
	const raw = typeof body === "string" ? body : JSON.stringify(body);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-github-event": opts.event ?? "issues",
		"x-hub-signature-256":
			opts.signature ??
			`sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
	};
	if (opts.delivery !== null)
		headers["x-github-delivery"] = opts.delivery ?? "delivery-0001";

	return createGateway().request("/webhooks/github", {
		method: "POST",
		headers,
		body: raw,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.acceptDelivery.mockResolvedValue({
		outcome: "accepted",
		runCreated: true,
	});
	mocks.finishRun.mockResolvedValue({
		finished: true,
		followUpCreated: false,
	});
	mocks.recordDelivery.mockResolvedValue(undefined);
	mocks.requestCancel.mockResolvedValue(true);
	mocks.findActiveRunForSubject.mockResolvedValue(null);
	mocks.getCurrentSpec.mockResolvedValue(null);
	mocks.ping.mockResolvedValue(undefined);
	mocks.appendEvent.mockResolvedValue("1");

	process.env.GITHUB_WEBHOOK_SECRET = SECRET;
});

describe("health", () => {
	it("reports liveness without touching Postgres", async () => {
		const response = await createGateway().request("/health");
		expect(response.status).toBe(200);
		expect(mocks.ping).not.toHaveBeenCalled();
	});

	it("reports 503 when Postgres is unreachable", async () => {
		mocks.ping.mockRejectedValue(new Error("down"));
		const response = await createGateway().request("/ready");
		expect(response.status).toBe(503);
	});
});

describe("authentication", () => {
	it("rejects a wrong signature before parsing the body", async () => {
		const response = await post(issuePayload(), {
			signature: "sha256=deadbeef",
		});
		expect(response.status).toBe(401);
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});

	it("rejects a request with no signature", async () => {
		const response = await post(issuePayload(), { signature: "" });
		expect(response.status).toBe(401);
	});

	it("rejects a body over the size cap", async () => {
		const response = await post(
			JSON.stringify({ padding: "x".repeat(300 * 1024) }),
		);
		expect(response.status).toBe(413);
	});
});

describe("event filtering", () => {
	it("ignores events other than issues, issue_comment, pull_request", async () => {
		const response = await post(issuePayload(), { event: "push" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});

	it("rejects malformed JSON that carries a valid signature", async () => {
		const response = await post("{not json");
		expect(response.status).toBe(400);
	});

	it.each([
		["a non-labeled action", issuePayload({ action: "opened" })],
		["a different label", issuePayload({ label: { name: "bug" } })],
		[
			"another repository",
			issuePayload({ repository: { full_name: "acme/other" } }),
		],
		[
			"a pull request in issue event",
			issuePayload({ issue: { number: 42, labels: [], pull_request: {} } }),
		],
		[
			"a bot sender",
			issuePayload({
				sender: { login: "bot", id: 1, type: "Bot" },
			}),
		],
	])("skips %s", async (_label, body) => {
		const response = await post(body);
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});

	it("requires a well-formed delivery ID", async () => {
		expect((await post(issuePayload(), { delivery: null })).status).toBe(400);
		expect((await post(issuePayload(), { delivery: "short" })).status).toBe(
			400,
		);
	});
});

describe("issue labeled triggers", () => {
	it("factory:triage creates a triage run", async () => {
		const body = issuePayload({
			label: { name: "factory:triage" },
			issue: { number: 42, labels: [{ name: "factory:triage" }] },
		});
		const response = await post(body);
		expect(response.status).toBe(202);
		expect(mocks.acceptDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					workflow: "triage",
					subjectKind: "issue",
					subjectNumber: 42,
				}),
			}),
		);
		const runInput = mocks.acceptDelivery.mock.calls[0][0].run.input;
		expect(runInput.autoAdvance).toBe(false);
	});

	it("factory:full-run creates a triage run with autoAdvance", async () => {
		const response = await post(issuePayload());
		expect(response.status).toBe(202);
		expect(mocks.acceptDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					workflow: "triage",
				}),
			}),
		);
		const runInput = mocks.acceptDelivery.mock.calls[0][0].run.input;
		expect(runInput.autoAdvance).toBe(true);
	});

	it("factory:spec-approved creates a spec-to-pr run", async () => {
		mocks.getCurrentSpec.mockResolvedValue({
			id: "spec-1",
			currentVersion: 2,
		});
		const body = issuePayload({
			label: { name: "factory:spec-approved" },
			issue: { number: 42, labels: [{ name: "factory:spec-approved" }] },
		});
		const response = await post(body);
		expect(response.status).toBe(202);
		expect(mocks.acceptDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					workflow: "spec-to-pr",
				}),
			}),
		);
		const runInput = mocks.acceptDelivery.mock.calls[0][0].run.input;
		expect(runInput.specId).toBe("spec-1");
		expect(runInput.specVersion).toBe(2);
		expect(runInput.autoAdvance).toBe(false);
	});

	it("factory:spec-approved with factory:full-run sets autoAdvance", async () => {
		mocks.getCurrentSpec.mockResolvedValue(null);
		const body = issuePayload({
			label: { name: "factory:spec-approved" },
			issue: {
				number: 42,
				labels: [
					{ name: "factory:spec-approved" },
					{ name: "factory:full-run" },
				],
			},
		});
		const response = await post(body);
		expect(response.status).toBe(202);
		const runInput = mocks.acceptDelivery.mock.calls[0][0].run.input;
		expect(runInput.autoAdvance).toBe(true);
		expect(runInput.specId).toBeNull();
	});

	it("ignores an unrecognized label", async () => {
		const body = issuePayload({
			label: { name: "help-wanted" },
		});
		const response = await post(body);
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});
});

describe("issue comment triggers", () => {
	it("reply on an issue with triage label creates a triage run", async () => {
		const response = await post(commentPayload(), {
			event: "issue_comment",
		});
		expect(response.status).toBe(202);
		expect(mocks.acceptDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					workflow: "triage",
					subjectKind: "issue",
					subjectNumber: 42,
				}),
			}),
		);
	});

	it("reply on an issue with full-run label sets autoAdvance", async () => {
		const body = commentPayload({
			issue: {
				number: 42,
				labels: [{ name: "factory:full-run" }],
			},
		});
		const response = await post(body, { event: "issue_comment" });
		expect(response.status).toBe(202);
		const runInput = mocks.acceptDelivery.mock.calls[0][0].run.input;
		expect(runInput.autoAdvance).toBe(true);
	});

	it("ignores replies on issues without triage/full-run labels", async () => {
		const body = commentPayload({
			issue: {
				number: 42,
				labels: [{ name: "bug" }],
			},
		});
		const response = await post(body, { event: "issue_comment" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});

	it("drops comments containing a factory marker", async () => {
		const body = commentPayload({
			comment: {
				id: 101,
				body: "Some text <!-- render-factory:spec:abc --> more text",
				author_association: "OWNER",
				user: { login: "Maintainer", id: 1, type: "User" },
			},
		});
		const response = await post(body, { event: "issue_comment" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});

	it("drops comments from non-collaborators", async () => {
		const body = commentPayload({
			comment: {
				id: 102,
				body: "I want to help",
				author_association: "NONE",
				user: { login: "Stranger", id: 99, type: "User" },
			},
		});
		const response = await post(body, { event: "issue_comment" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});

	it("ignores bot comments", async () => {
		const body = commentPayload({
			sender: { login: "some-bot", id: 2, type: "Bot" },
		});
		const response = await post(body, { event: "issue_comment" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
	});

	it("handles /factory cancel command", async () => {
		mocks.findActiveRunForSubject.mockResolvedValue({
			id: "run-123",
			status: "running",
		});
		const body = commentPayload({
			comment: {
				id: 103,
				body: "/factory cancel",
				author_association: "OWNER",
				user: { login: "Maintainer", id: 1, type: "User" },
			},
		});
		const response = await post(body, { event: "issue_comment" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			cancel: true,
			runId: "run-123",
		});
		expect(mocks.requestCancel).toHaveBeenCalledWith("run-123");
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});

	it("cancel command when no active run does not error", async () => {
		mocks.findActiveRunForSubject.mockResolvedValue(null);
		const body = commentPayload({
			comment: {
				id: 104,
				body: "/factory cancel",
				author_association: "OWNER",
				user: { login: "Maintainer", id: 1, type: "User" },
			},
		});
		const response = await post(body, { event: "issue_comment" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			cancel: true,
			runId: null,
		});
		expect(mocks.requestCancel).not.toHaveBeenCalled();
	});
});

describe("pull request labeled triggers", () => {
	it("factory:pr-review creates a pr-review run", async () => {
		const response = await post(prPayload(), { event: "pull_request" });
		expect(response.status).toBe(202);
		expect(mocks.acceptDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				run: expect.objectContaining({
					workflow: "pr-review",
					subjectKind: "pull_request",
					subjectNumber: 10,
				}),
			}),
		);
		const runInput = mocks.acceptDelivery.mock.calls[0][0].run.input;
		expect(runInput.prNumber).toBe(10);
		expect(runInput.headSha).toBe("abc123");
	});

	it("ignores non-pr-review labels on pull requests", async () => {
		const body = prPayload({
			label: { name: "needs-review" },
		});
		const response = await post(body, { event: "pull_request" });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});
});

describe("delivery deduplication", () => {
	it("returns 202 for a redelivered webhook", async () => {
		mocks.acceptDelivery.mockResolvedValue({
			outcome: "duplicate",
		});
		const response = await post(issuePayload());
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ skipped: true });
	});

	it("returns 202 when a run is already active", async () => {
		mocks.acceptDelivery.mockResolvedValue({
			outcome: "duplicate_active_run",
			runCreated: false,
		});
		const response = await post(issuePayload());
		expect(response.status).toBe(202);
	});
});

describe("wrong repo", () => {
	it("ignores events from non-target repositories", async () => {
		const body = issuePayload({
			repository: { full_name: "someone-else/other-repo" },
		});
		const response = await post(body);
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(mocks.acceptDelivery).not.toHaveBeenCalled();
	});
});
