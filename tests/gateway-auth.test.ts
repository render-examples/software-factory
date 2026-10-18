import { describe, expect, it } from "vitest";
import {
	bearerToken,
	constantTimeEqual,
	isHttps,
	parseCookies,
	SESSION_MAX_AGE_SECONDS,
	safeNext,
	sessionClearCookie,
	sessionSetCookie,
	signSession,
	verifySession,
} from "../app/gateway/auth.js";

const TOKEN = "admin-token";

describe("constantTimeEqual", () => {
	it("compares strings of any length", () => {
		expect(constantTimeEqual("abc", "abc")).toBe(true);
		expect(constantTimeEqual("abc", "abd")).toBe(false);
		expect(constantTimeEqual("abc", "abcd")).toBe(false);
		expect(constantTimeEqual("", "x")).toBe(false);
	});
});

describe("sessions", () => {
	it("verifies a fresh session and rejects it after about 12 hours", () => {
		const now = 1_800_000_000_000;
		const session = signSession(TOKEN, now);
		expect(verifySession(session, TOKEN, now)).toBe(true);
		expect(verifySession(session, TOKEN, now + SESSION_MAX_AGE_SECONDS * 1000 - 1)).toBe(true);
		expect(verifySession(session, TOKEN, now + SESSION_MAX_AGE_SECONDS * 1000)).toBe(false);
		expect(SESSION_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
	});

	it("rejects sessions signed with another token, tampered, or malformed", () => {
		const session = signSession(TOKEN);
		expect(verifySession(session, "other-token")).toBe(false);
		const [expires, nonce, sig] = session.split(".") as [string, string, string];
		expect(verifySession(`${Number(expires) + 1_000_000}.${nonce}.${sig}`, TOKEN)).toBe(false);
		expect(verifySession(`${expires}.${nonce}x.${sig}`, TOKEN)).toBe(false);
		expect(verifySession(undefined, TOKEN)).toBe(false);
		expect(verifySession("", TOKEN)).toBe(false);
		expect(verifySession("a.b", TOKEN)).toBe(false);
		expect(verifySession(`abc.${nonce}.${sig}`, TOKEN)).toBe(false);
	});

	it("does not contain the admin token", () => {
		expect(signSession(TOKEN)).not.toContain(TOKEN);
	});
});

describe("cookies", () => {
	it("sets HttpOnly, SameSite=Lax, a 12h Max-Age, and Secure only over https", () => {
		const secure = sessionSetCookie("v", true);
		expect(secure).toContain("factory_session=v");
		expect(secure).toContain("HttpOnly");
		expect(secure).toContain("Secure");
		expect(secure).toContain("SameSite=Lax");
		expect(secure).toContain("Path=/");
		expect(secure).toContain(`Max-Age=${12 * 60 * 60}`);
		expect(sessionSetCookie("v", false)).not.toContain("Secure");
		expect(sessionClearCookie(true)).toContain("Max-Age=0");
	});

	it("parses a cookie header", () => {
		expect(parseCookies("a=1; factory_session=x.y.z; b")).toEqual({ a: "1", factory_session: "x.y.z" });
		expect(parseCookies(undefined)).toEqual({});
	});

	it("detects https from the URL or x-forwarded-proto", () => {
		expect(isHttps(new Request("https://gw/ui"))).toBe(true);
		expect(isHttps(new Request("http://gw/ui"))).toBe(false);
		expect(isHttps(new Request("http://gw/ui", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
	});
});

describe("bearerToken", () => {
	it("reads a bearer token", () => {
		expect(bearerToken("Bearer abc")).toBe("abc");
		expect(bearerToken("bearer abc")).toBe("abc");
		expect(bearerToken("Basic abc")).toBeUndefined();
		expect(bearerToken("Bearer")).toBeUndefined();
		expect(bearerToken(undefined)).toBeUndefined();
	});
});

describe("safeNext", () => {
	it("keeps relative paths under /ui", () => {
		expect(safeNext("/ui")).toBe("/ui");
		expect(safeNext("/ui/traces/trn-1")).toBe("/ui/traces/trn-1");
		expect(safeNext("/ui?repo=acme%2Fweb&before=x")).toBe("/ui?repo=acme%2Fweb&before=x");
	});

	it.each([
		undefined,
		"",
		"https://evil.example/ui",
		"//evil.example/ui",
		"/\\evil.example",
		"/ui\\..\\..\\evil",
		"/ui/../webhooks/github",
		"/uix",
		"/api/traces",
		"ui",
		"/ui/login",
		"/ui/logout",
		"/ui/\nx",
		"javascript:alert(1)",
	])("falls back to /ui for %j", (next) => {
		expect(safeNext(next)).toBe("/ui");
	});
});
