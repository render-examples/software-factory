import { describe, expect, it } from "vitest";
import { config } from "../app/config/index.js";
import { PrReviewInput, SpecToPrInput, TriageInput } from "../app/contracts/tasks.js";
import { route } from "../app/gateway/routes.js";

const REPO = Object.keys(config.repos)[0] as string;
const BASE = config.repos[REPO]?.baseBranch as string;
const DELIVERY = "delivery-1";
const SHA = "a".repeat(40);

const envelope = (overrides: Record<string, unknown> = {}) => ({
	repository: { full_name: REPO },
	installation: { id: 7 },
	sender: { login: "maintainer", type: "User" },
	...overrides,
});

const issueLabeled = (label: string, issue: Record<string, unknown> = {}) =>
	envelope({
		action: "labeled",
		label: { name: label },
		issue: { number: 12, updated_at: "2026-10-18T10:00:00Z", labels: [{ name: label }], ...issue },
	});

const prLabeled = (label: string, state = "open") =>
	envelope({ action: "labeled", label: { name: label }, pull_request: { number: 34, state, head: { sha: SHA } } });

const comment = (body: string, issue: Record<string, unknown> = {}) =>
	envelope({
		action: "created",
		issue: { number: 12, labels: [{ name: config.labels.triage }], ...issue },
		comment: { id: 99, body },
	});

const push = (overrides: Record<string, unknown> = {}) => envelope({ ref: `refs/heads/${BASE}`, after: SHA, deleted: false, ...overrides });

describe("route: starts", () => {
	it("triage label on an issue starts triage", () => {
		const r = route("issues", issueLabeled(config.labels.triage), DELIVERY);
		expect(r).toEqual({
			kind: "start",
			task: "triage",
			input: { repo: REPO, installationId: 7, issue: 12, actor: "maintainer" },
			idempotencyKey: DELIVERY,
			subject: "issue#12",
		});
		if (r.kind === "start") expect(TriageInput.safeParse(r.input).success).toBe(true);
	});

	it("spec-approved label starts spec-to-pr with labeledAt from updated_at", () => {
		const r = route("issues", issueLabeled(config.labels.specApproved), DELIVERY);
		expect(r).toMatchObject({
			kind: "start",
			task: "spec-to-pr",
			input: { repo: REPO, installationId: 7, issue: 12, actor: "maintainer", labeledAt: "2026-10-18T10:00:00Z" },
			idempotencyKey: DELIVERY,
		});
		if (r.kind === "start") expect(SpecToPrInput.safeParse(r.input).success).toBe(true);
	});

	it("pr-review label on an open PR starts pr-review", () => {
		const r = route("pull_request", prLabeled(config.labels.prReview), DELIVERY);
		expect(r).toEqual({
			kind: "start",
			task: "pr-review",
			input: { repo: REPO, installationId: 7, pr: 34, headSha: SHA, actor: "maintainer" },
			idempotencyKey: DELIVERY,
			subject: "pr#34",
		});
		if (r.kind === "start") expect(PrReviewInput.safeParse(r.input).success).toBe(true);
	});

	it("cancel command on an issue starts cancel", () => {
		const r = route("issue_comment", comment(`  ${config.commandPrefix} cancel  \nbecause`), DELIVERY);
		expect(r).toMatchObject({
			kind: "start",
			task: "cancel",
			input: { repo: REPO, installationId: 7, number: 12, kind: "issue", actor: "maintainer" },
			subject: "issue#12",
		});
	});

	it("push to the base branch starts refresh-snapshot keyed by repo@sha", () => {
		const r = route("push", push(), DELIVERY);
		expect(r).toEqual({
			kind: "start",
			task: "refresh-snapshot",
			input: { repo: REPO, installationId: 7, sha: SHA },
			idempotencyKey: `${REPO}@${SHA}`,
		});
	});
});

describe("route: ignores untrusted or irrelevant deliveries", () => {
	it("does not start work for bots, unconfigured repositories, closed PRs, or invalid pushes", () => {
		const deliveries: [string, unknown][] = [
			["issues", { ...issueLabeled(config.labels.triage), sender: { login: "factory[bot]", type: "Bot" } }],
			["issues", { ...issueLabeled(config.labels.triage), repository: { full_name: "someone/else" } }],
			["pull_request", prLabeled(config.labels.prReview, "closed")],
			["push", push({ ref: "refs/heads/feature" })],
		];
		for (const [event, payload] of deliveries) expect(route(event, payload, DELIVERY).kind).toBe("ignore");
	});
});
