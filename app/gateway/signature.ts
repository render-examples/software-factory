import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify GitHub's HMAC. Runs before the body is parsed. */
export function verifySignature(body: string, headers: Headers): boolean {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	const signature = headers.get("x-hub-signature-256");
	if (!secret || !signature) return false;

	const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
	try {
		return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
	} catch {
		return false;
	}
}
