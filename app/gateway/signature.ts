import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies GitHub's `x-hub-signature-256` HMAC over the raw body. */
export function verifySignature(body: string, signature: string | null | undefined, secret: string): boolean {
	if (!secret || !signature) return false;
	const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
	const actual = Buffer.from(signature);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}
