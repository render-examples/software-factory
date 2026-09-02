import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify GitHub's HMAC over the raw body.
 *
 * This runs before the body is parsed, so unauthenticated input never reaches
 * a JSON parser or a schema.
 */
export function verifySignature(body: string, headers: Headers): boolean {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	const signature = headers.get("x-hub-signature-256");
	if (!secret || !signature) return false;

	const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	try {
		return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
	} catch {
		// Length mismatch — timingSafeEqual throws rather than returning false.
		return false;
	}
}
