import { describe, expect, it } from "vitest";
import { contentHash, findMarkedComment, type IssueComment, parseMarker, renderMarker } from "../app/github/index.js";

const BOT = "software-factory[bot]";

function comment(id: number, login: string, body: string): IssueComment {
	return {
		id,
		body,
		author: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
		performedViaApp: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		htmlUrl: "",
	};
}

describe("markers", () => {
	it("round-trips status data inside a hidden HTML comment", () => {
		const data = { runId: "trn-1", phase: "triage", state: "running" as const };
		const marker = renderMarker("status", data);
		expect(marker).toMatch(/^<!-- software-factory:status [A-Za-z0-9_-]+ -->$/);
		expect(parseMarker(`Triage is running\n\n${marker}`, "status")).toEqual(data);
	});

	it("round-trips a spec with its content hash, independent of key order", () => {
		const spec = { title: "Add dark mode", criteria: ["toggle", "persists"], meta: { b: 1, a: 2 } };
		expect(contentHash(spec)).toBe(contentHash({ meta: { a: 2, b: 1 }, criteria: ["toggle", "persists"], title: "Add dark mode" }));
		const marker = renderMarker("spec", { spec, hash: contentHash(spec), version: 2 });
		expect(parseMarker(marker, "spec")).toEqual({ spec, hash: contentHash(spec), version: 2 });
	});

	it("survives edits around it, CRLF, and extra whitespace", () => {
		const marker = renderMarker("questions", { round: 1, questions: ["Which browsers?"] });
		const encoded = marker.split(" ")[2];
		const edited = `Edited by a maintainer\r\n\r\n<!--   software-factory:questions   ${encoded}\r\n-->\r\nmore text`;
		expect(parseMarker(edited, "questions")).toEqual({ round: 1, questions: ["Which browsers?"] });
	});

	it("returns null for missing, other-kind, corrupted, or invalid markers", () => {
		const status = renderMarker("status", { runId: "trn-1", phase: "triage", state: "done" });
		expect(parseMarker("no marker here", "status")).toBeNull();
		expect(parseMarker(status, "spec")).toBeNull();
		expect(parseMarker(status.replace(/ [A-Za-z0-9_-]+ -->/, " AAAA -->"), "status")).toBeNull();
		const wrongShape = Buffer.from(JSON.stringify({ runId: "x", phase: "triage", state: "exploded" })).toString("base64url");
		expect(parseMarker(`<!-- software-factory:status ${wrongShape} -->`, "status")).toBeNull();
	});

	it("rejects a spec whose content no longer matches its hash", () => {
		const spec = { title: "Original" };
		const tampered = { spec: { title: "Rewritten" }, hash: contentHash(spec), version: 1 };
		const encoded = Buffer.from(JSON.stringify(tampered)).toString("base64url");
		expect(parseMarker(`<!-- software-factory:spec ${encoded} -->`, "spec")).toBeNull();
	});

	it("refuses to render a marker too large for a comment", () => {
		expect(() => renderMarker("review", { blob: "x".repeat(60_000) })).toThrow("limit");
	});
});

describe("findMarkedComment", () => {
	const marker = (runId: string) => renderMarker("status", { runId, phase: "triage", state: "running" });

	it("returns the newest bot-authored comment with the marker", () => {
		const comments = [comment(1, BOT, marker("trn-old")), comment(2, "alice", "hi"), comment(3, BOT, marker("trn-new"))];
		expect(findMarkedComment(comments, "status", BOT)).toMatchObject({ comment: { id: 3 }, data: { runId: "trn-new" } });
	});

	it("ignores markers pasted by anyone else", () => {
		const comments = [comment(1, BOT, marker("trn-real")), comment(2, "mallory", `copied: ${marker("trn-forged")}`)];
		expect(findMarkedComment(comments, "status", BOT)?.data.runId).toBe("trn-real");
		expect(findMarkedComment([comments[1] as IssueComment], "status", BOT)).toBeNull();
		expect(findMarkedComment([comment(4, "software-factory", marker("trn-x"))], "status", BOT)).toBeNull();
	});

	it("skips bot comments without that kind of marker", () => {
		const comments = [comment(1, BOT, marker("trn-1")), comment(2, BOT, "just a reply")];
		expect(findMarkedComment(comments, "status", BOT)?.comment.id).toBe(1);
	});
});
