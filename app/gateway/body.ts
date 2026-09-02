const MAX_BODY_BYTES = 256 * 1024;

/** Read the body with a hard cap. Returns null when exceeded. */
export async function readBody(request: Request): Promise<string | null> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
	if (!request.body) return "";

	const reader = request.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(Buffer.from(value));
	}

	return Buffer.concat(chunks, total).toString("utf8");
}
