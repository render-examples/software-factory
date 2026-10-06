import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two strings. Returns false when
 * lengths differ (after the buffer allocation) so the timing
 * does not leak the secret length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

const SESSION_COOKIE = "rf_session";
const HMAC_ALGO = "sha256";

/** Sessions are stateless, so a fixed lifetime is the only way one ends. */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function sessionSignature(adminToken: string, payload: string): string {
	return createHmac(HMAC_ALGO, adminToken).update(payload).digest("hex");
}

/** A session value is `<issuedAtMs>.<nonce>.<hmac>`, signed with the admin token. */
export function signSession(adminToken: string, now = Date.now()): string {
	const payload = `${now}.${randomBytes(32).toString("hex")}`;
	return `${payload}.${sessionSignature(adminToken, payload)}`;
}

/** Valid when the signature matches and the session is younger than its lifetime. */
export function verifySession(
	value: string,
	adminToken: string,
	now = Date.now(),
): boolean {
	const parts = value.split(".");
	if (parts.length !== 3) return false;
	const [issuedAt, nonce, sig] = parts;
	if (!/^\d+$/.test(issuedAt) || !nonce || !sig) return false;
	const expected = sessionSignature(adminToken, `${issuedAt}.${nonce}`);
	if (!constantTimeEqual(sig, expected)) return false;
	const age = now - Number(issuedAt);
	return age >= 0 && age <= SESSION_MAX_AGE_SECONDS * 1000;
}

export function sessionCookieName(): string {
	return SESSION_COOKIE;
}

/** Build a Set-Cookie header for the session. */
export function sessionSetCookie(value: string): string {
	return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

/** Build a Set-Cookie header that clears the session. */
export function sessionClearCookie(): string {
	return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Parse cookies from a Cookie header value. */
export function parseCookies(header: string | null): Record<string, string> {
	if (!header) return {};
	const result: Record<string, string> = {};
	for (const pair of header.split(";")) {
		const eq = pair.indexOf("=");
		if (eq === -1) continue;
		const key = pair.slice(0, eq).trim();
		const val = pair.slice(eq + 1).trim();
		result[key] = val;
	}
	return result;
}
