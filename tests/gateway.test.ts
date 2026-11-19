import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { config, type TaskName } from "../app/config/index.js";
import { append, type Db, readStream } from "../app/db/index.js";
import { runFinished } from "../app/events/index.js";
import { createGateway, EventHub, type GatewayDeps } from "../app/gateway/index.js";
import { runEvent } from "../app/runs/index.js";
import { githubThread } from "../app/threads/index.js";
import { REPO } from "./fixtures/config.js";
import { pgliteDb, resetDb } from "./helpers/db.js";
import { startRun } from "./helpers/runs.js";

const SECRET = "webhook-secret";

const triagePayload = {
	action: "labeled",
	label: { name: config.labels.triage },
	issue: { number: 12, labels: [{ name: config.labels.triage }] },
	repository: { full_name: REPO },
	installation: { id: 7 },
	sender: { login: "maintainer", type: "User" },
};

const ISSUE = { kind: "issue" as const, number: 12 };

const commentPayload = (body: string, issue: Record<string, unknown> = {}) => ({
	action: "created",
	issue: { number: 12, ...issue },
	comment: { id: 99, body },
	repository: { full_name: REPO },
	installation: { id: 7 },
	sender: { login: "maintainer", type: "User" },
});

async function finishRun(runId: string, outcome: string, waiting?: "reply"): Promise<void> {
	const finished = { state: "done" as const, outcome, summary: `${outcome}.`, links: [], duration_ms: 1, waiting };
	await db.withTx((tx) => append(tx, runEvent(runFinished, runId, githubThread(REPO, ISSUE), finished)));
}

const sign = (body: string | Buffer, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function webhook(
	body: string | Buffer<ArrayBuffer>,
	{ event = "issues", delivery = "delivery-1" as string | null, signature = sign(body) } = {},
): Request {
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
let db: Db;

beforeAll(async () => {
	({ db } = await pgliteDb());
});
afterAll(() => db.end());
beforeEach(async () => {
	await resetDb(db);
	startTask = vi.fn(async (_task: TaskName, _input: object, _key: string) => ({ id: "trn-123" }));
	app = createGateway({ startTask, webhookSecret: SECRET, db, hub: new EventHub(), eventsReadToken: "events-token" });
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

	it("verifies the signature over the raw body bytes, not their UTF-8 decoding", async () => {
		const [head, tail] = JSON.stringify({ ...triagePayload, note: "@@" }).split("@@");
		const body = Buffer.concat([Buffer.from(head), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from(tail)]);
		const decoded = await app.fetch(webhook(body, { signature: sign(body.toString("utf8")) }));
		expect(decoded.status).toBe(401);
		expect(startTask).not.toHaveBeenCalled();

		const res = await app.fetch(webhook(body));
		expect(res.status).toBe(202);
		expect(startTask).toHaveBeenCalledTimes(1);
	});

	it("rejects webhook bodies over 256 KB before starting work", async () => {
		const body = JSON.stringify({ padding: "x".repeat(256 * 1024) });
		const res = await app.fetch(webhook(body));
		expect(res.status).toBe(413);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("records the delivery and where it went, then starts its task keyed by the delivery id", async () => {
		const res = await app.fetch(webhook(JSON.stringify(triagePayload)));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ runId: "trn-123", task: "triage" });
		expect(startTask).toHaveBeenCalledExactlyOnceWith("triage", { repo: REPO, installationId: 7, issue: 12, actor: "maintainer" }, "delivery-1");
		expect(await readStream(db, "delivery:github:delivery-1", 0)).toMatchObject([
			{
				type: "delivery.received",
				thread: `github:${REPO}#issue-12`,
				source: "github",
				payload: { event: "issues", repo: REPO, task: "triage" },
			},
		]);
	});

	const SHA = "a".repeat(40);
	const AT = "2026-10-18T10:00:00Z";
	const approval = { kind: "label", labeledAt: AT };
	const PR = githubThread(REPO, { kind: "pr", number: 34 });
	const { repository, installation, sender } = triagePayload;
	type Delivery = [event: string, payload: object];
	const labeled = (label: string): Delivery => ["issues", { ...triagePayload, label: { name: label }, issue: { number: 12, updated_at: AT } }];
	const prLabeled = (state: string): Delivery => [
		"pull_request",
		{ ...triagePayload, label: { name: config.labels.prReview }, pull_request: { number: 34, state, head: { sha: SHA } } },
	];
	const comment = (body: string): Delivery => ["issue_comment", commentPayload(body)];
	const push = (branch: string): Delivery => ["push", { repository, installation, sender, ref: `refs/heads/${branch}`, after: SHA }];
	type Outcome = { task: TaskName; input: object; key?: string; thread?: string } | { ignored: string };

	it.each<[string, Delivery, Outcome]>([
		["spec-approved label starts spec-to-pr", labeled(config.labels.specApproved), { task: "spec-to-pr", input: { approval } }],
		["autopilot label starts autopilot", labeled(config.labels.autopilot), { task: "autopilot", input: { issue: 12 } }],
		["a reply while Triage waits resumes triage", comment("Details."), { task: "triage", input: { issue: 12, commentId: 99 } }],
		["pr-review label on a PR runs on its thread", prLabeled("open"), { task: "pr-review", input: { pr: 34, headSha: SHA }, thread: PR }],
		["cancel command on an issue starts cancel", comment(`${config.commandPrefix} cancel`), { task: "cancel", input: { number: 12, kind: "issue" } }],
		[
			"cancel command on a PR runs on its thread",
			["issue_comment", commentPayload(`${config.commandPrefix} cancel`, { number: 34, pull_request: {} })],
			{ task: "cancel", input: { number: 34, kind: "pr" }, thread: PR },
		],
		["push to the base branch refreshes the snapshot", push("main"), { task: "refresh-snapshot", input: { sha: SHA }, key: `${REPO}@${SHA}` }],
		["ignores a bot sender", ["issues", { ...triagePayload, sender: { login: "factory[bot]", type: "Bot" } }], { ignored: "bot sender" }],
		["ignores an unconfigured repo", ["issues", { ...triagePayload, repository: { full_name: "someone/else" } }], { ignored: "unconfigured repo" }],
		["ignores a closed PR labeled for review", prLabeled("closed"), { ignored: "pull request not open" }],
		["ignores a push to another branch", push("feature"), { ignored: "not base branch" }],
	])("%s", async (_name, [event, payload], outcome) => {
		await startRun(db, REPO, ISSUE, { traceId: "trn-triage" });
		await finishRun("trn-triage", "asked", "reply");
		const res = await app.fetch(webhook(JSON.stringify(payload), { event }));
		if ("ignored" in outcome) {
			expect(await res.json()).toEqual(outcome);
			expect(startTask).not.toHaveBeenCalled();
			return;
		}
		const { task, input, key = "delivery-1", thread } = outcome;
		expect(res.status).toBe(202);
		expect(startTask).toHaveBeenCalledExactlyOnceWith(task, expect.objectContaining({ repo: REPO, ...input }), key);
		if (thread) expect((await readStream(db, "delivery:github:delivery-1", 0))[0]?.thread).toBe(thread);
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

	it("records an ignored delivery with the reason", async () => {
		const res = await app.fetch(webhook(JSON.stringify({ zen: "hi" }), { event: "ping", delivery: "delivery-ping" }));
		expect(await res.json()).toEqual({ ignored: "ping" });
		expect((await readStream(db, "delivery:github:delivery-ping", 0))[0]?.payload).toEqual({ event: "ping", ignored: "ping" });
	});

	it("records a redelivery once and starts its task again, under the same idempotency key", async () => {
		await app.fetch(webhook(JSON.stringify(triagePayload)));
		const res = await app.fetch(webhook(JSON.stringify(triagePayload)));
		expect(res.status).toBe(202);
		expect(startTask.mock.calls.map(([, , key]) => key)).toEqual(["delivery-1", "delivery-1"]);
		expect(await readStream(db, "delivery:github:delivery-1", 0)).toHaveLength(1);
	});

	it("resumes the task whose root run left the issue waiting for a reply, and nothing else", async () => {
		await startRun(db, REPO, ISSUE, { traceId: "trn-autopilot", task: "autopilot", title: "Autopilot" });
		await startRun(db, REPO, ISSUE, { traceId: "trn-autopilot", runId: "trn-triage" });
		await finishRun("trn-triage", "asked", "reply");
		await finishRun("trn-autopilot", "waiting_for_answers", "reply");

		const res = await app.fetch(webhook(JSON.stringify(commentPayload("Here are the answers.")), { event: "issue_comment" }));

		expect(res.status).toBe(202);
		expect(startTask).toHaveBeenCalledWith(
			"autopilot",
			{ repo: REPO, installationId: 7, issue: 12, actor: "maintainer", commentId: 99, replyTo: "trn-autopilot" },
			"delivery-1",
		);
	});

	it("replays a delivery's recorded decision on redelivery instead of routing it again", async () => {
		const comment = JSON.stringify(commentPayload("Thanks!"));
		expect(await (await app.fetch(webhook(comment, { event: "issue_comment" }))).json()).toEqual({ ignored: "thread is not waiting for a reply" });

		await startRun(db, REPO, ISSUE, { traceId: "trn-triage" });
		await finishRun("trn-triage", "asked", "reply");

		expect(await (await app.fetch(webhook(comment, { event: "issue_comment" }))).json()).toEqual({ ignored: "thread is not waiting for a reply" });
		expect(startTask).not.toHaveBeenCalled();
	});

	it("ignores a comment while a trace runs, and after a root run that isn't waiting", async () => {
		await startRun(db, REPO, ISSUE, { traceId: "trn-spec", task: "spec-to-pr", title: "Spec-to-PR" });
		const comment = JSON.stringify(commentPayload("Thanks, looking forward to the PR!"));
		expect(await (await app.fetch(webhook(comment, { event: "issue_comment" }))).json()).toEqual({ ignored: "thread is not waiting for a reply" });

		await startRun(db, REPO, ISSUE, { traceId: "trn-triage" });
		await finishRun("trn-triage", "declined");
		await app.fetch(webhook(comment, { event: "issue_comment", delivery: "delivery-2" }));

		expect(startTask).not.toHaveBeenCalled();
		expect((await readStream(db, "delivery:github:delivery-2", 0))[0]?.payload).toEqual({
			event: "issue_comment",
			ignored: "thread is not waiting for a reply",
		});
	});

	it("returns 502 without starting the task when the delivery can't be recorded", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const down: Db = { ...db, withTx: async () => Promise.reject(new Error("connection refused")) };
		const res = await createGateway({ startTask, webhookSecret: SECRET, db: down, hub: new EventHub(), eventsReadToken: "events-token" }).fetch(
			webhook(JSON.stringify(triagePayload)),
		);
		expect(res.status).toBe(502);
		expect(startTask).not.toHaveBeenCalled();
		expect(JSON.parse(warn.mock.calls[0]?.[0] as string)).toMatchObject({ msg: "could not record delivery", deliveryId: "delivery-1" });
		warn.mockRestore();
	});
});
