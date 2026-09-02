const SECRET_PATTERNS = [
	/\bsk-ant-api\S{10,}/g,
	/\bghp_\S{10,}/g,
	/\bghs_\S{10,}/g,
	/\bgithub_pat_\S{10,}/g,
	/\brnd_\S{10,}/g,
	/\bAKIA\S{12,}/g,
	/\bsk-\S{20,}/g,
];

/** Strip secret-shaped strings. Applied once when text leaves for GitHub. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}
