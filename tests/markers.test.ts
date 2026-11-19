import { describe, expect, it } from "vitest";
import { contentHash, findMarkedComment, type IssueComment, parseMarker, renderMarker } from "../app/github/index.js";

const BOT = "software-factory[bot]";

function comment(id: number, login: string, body: string): IssueComment {
	return {
		id,
		body,
		author: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		htmlUrl: "",
	};
}

describe("markers", () => {
	it("round-trips a spec with its content hash, independent of key order", () => {
		const spec = { title: "Add dark mode", criteria: ["toggle", "persists"], meta: { b: 1, a: 2 } };
		expect(contentHash(spec)).toBe(contentHash({ meta: { a: 2, b: 1 }, criteria: ["toggle", "persists"], title: "Add dark mode" }));
		const marker = renderMarker("spec", { spec, hash: contentHash(spec), version: 2 });
		expect(parseMarker(marker, "spec")).toEqual({ spec, hash: contentHash(spec), version: 2 });
	});

	it("parses valid question and review markers, and returns null for missing, other-kind, corrupted, or invalid ones", () => {
		const questions = { round: 2, questions: ["Which API should this use?"] };
		const review = { headSha: "a".repeat(40), runId: "trn-2" };
		expect(parseMarker(renderMarker("questions", questions), "questions")).toEqual(questions);
		expect(parseMarker(renderMarker("review", review), "review")).toEqual(review);

		const status = renderMarker("status", { runId: "trn-1", stage: "triage", state: "done" });
		const raw = (kind: string, data: object) => `<!-- software-factory:${kind} ${Buffer.from(JSON.stringify(data)).toString("base64url")} -->`;
		for (const [body, kind] of [
			["no marker here", "status"],
			[status, "spec"],
			[status.replace(/ [A-Za-z0-9_-]+ -->/, " AAAA -->"), "status"],
			[raw("status", { runId: "x", stage: "triage", state: "exploded" }), "status"],
			[raw("questions", { round: 2 }), "questions"],
			[raw("review", { headSha: "short", runId: "trn-2" }), "review"],
		] as const) {
			expect(parseMarker(body, kind)).toBeNull();
		}
	});
});

describe("findMarkedComment", () => {
	const marker = (runId: string) => renderMarker("status", { runId, stage: "triage", state: "running" });

	it("ignores markers pasted by anyone else", () => {
		const comments = [comment(1, BOT, marker("trn-real")), comment(2, "mallory", `copied: ${marker("trn-forged")}`)];
		expect(findMarkedComment(comments, "status", BOT)?.data.runId).toBe("trn-real");
		expect(findMarkedComment([comments[1] as IssueComment], "status", BOT)).toBeNull();
		expect(findMarkedComment([comment(4, "software-factory", marker("trn-x"))], "status", BOT)).toBeNull();
	});
});
