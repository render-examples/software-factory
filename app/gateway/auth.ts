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

/** Sign a nonce with the admin token to produce a session cookie value. */
export function signSession(adminToken: string): string {
	const nonce = randomBytes(32).toString("hex");
	const sig = createHmac(HMAC_ALGO, adminToken).update(nonce).digest("hex");
	return `${nonce}.${sig}`;
}

/** Verify a session cookie value. Returns true if valid. */
export function verifySession(value: string, adminToken: string): boolean {
	const dot = value.indexOf(".");
	if (dot === -1) return false;
	const nonce = value.slice(0, dot);
	const sig = value.slice(dot + 1);
	if (!nonce || !sig) return false;
	const expected = createHmac(HMAC_ALGO, adminToken)
		.update(nonce)
		.digest("hex");
	return constantTimeEqual(sig, expected);
}

export function sessionCookieName(): string {
	return SESSION_COOKIE;
}

/** Build a Set-Cookie header for the session. */
export function sessionSetCookie(value: string): string {
	return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/`;
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
