import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "factory_session";
/** Sessions are stateless, so a fixed lifetime is the only way one ends; rotating the admin token ends them all. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Compares HMACs of both strings, so neither the content nor the length of the secret leaks through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
	const key = randomBytes(32);
	const digest = (value: string) => createHmac("sha256", key).update(value).digest();
	return timingSafeEqual(digest(a), digest(b));
}

/** The signing key is derived from the admin token rather than being the token itself. */
function sessionSignature(adminToken: string, payload: string): string {
	const key = createHmac("sha256", adminToken).update("factory-ui-session-v1").digest();
	return createHmac("sha256", key).update(payload).digest("base64url");
}

/** A session value is `<expiresAtMs>.<nonce>.<signature>`. */
export function signSession(adminToken: string, now = Date.now()): string {
	const payload = `${now + SESSION_MAX_AGE_SECONDS * 1000}.${randomBytes(16).toString("base64url")}`;
	return `${payload}.${sessionSignature(adminToken, payload)}`;
}

/** Valid when the signature matches and the session has not expired. */
export function verifySession(value: string | undefined, adminToken: string, now = Date.now()): boolean {
	if (!value) return false;
	const parts = value.split(".");
	if (parts.length !== 3) return false;
	const [expiresAt, nonce, signature] = parts as [string, string, string];
	if (!/^\d{1,15}$/.test(expiresAt) || !nonce || !signature) return false;
	if (!constantTimeEqual(signature, sessionSignature(adminToken, `${expiresAt}.${nonce}`))) return false;
	return now < Number(expiresAt);
}

/** Lax, not Strict: a Strict cookie is withheld on a link from GitHub, which then lands on the login page. */
export function sessionSetCookie(value: string, secure: boolean): string {
	return `${SESSION_COOKIE}=${value}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function sessionClearCookie(secure: boolean): string {
	return `${SESSION_COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!header) return result;
	for (const pair of header.split(";")) {
		const eq = pair.indexOf("=");
		if (eq === -1) continue;
		result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}
	return result;
}

/** Render terminates TLS in front of the service and reports the original scheme in x-forwarded-proto. */
export function isHttps(request: Request): boolean {
	const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
	return forwarded === "https" || new URL(request.url).protocol === "https:";
}

/** The token from `Authorization: Bearer <token>`, if present. */
export function bearerToken(header: string | undefined): string | undefined {
	const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
	return match?.[1];
}

/** A post-login redirect target: a relative path under /ui, or /ui. Anything else could redirect off-site. */
export function safeNext(next: unknown): string {
	if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return "/ui";
	// Backslashes and control characters are normalized by browsers into other URLs.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
	if (/[\\\u0000-\u001f\u007f]/.test(next)) return "/ui";
	let url: URL;
	try {
		url = new URL(next, "http://gateway.invalid");
	} catch {
		return "/ui";
	}
	if (url.origin !== "http://gateway.invalid") return "/ui";
	if (url.pathname !== "/ui" && !url.pathname.startsWith("/ui/")) return "/ui";
	if (url.pathname === "/ui/login" || url.pathname === "/ui/logout") return "/ui";
	return `${url.pathname}${url.search}`;
}
