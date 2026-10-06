/** Enforce navigation to allowed origins only. */
export function checkBrowserNavigation(
	url: string,
	allowedOrigins: readonly string[],
): string | null {
	if (allowedOrigins.length === 0) {
		return "No allowed origins configured for browser navigation";
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `Invalid URL: ${url.slice(0, 120)}`;
	}
	const origin = parsed.origin;
	if (allowedOrigins.some((allowed) => origin === allowed)) {
		return null;
	}
	return `Navigation to ${origin} is not allowed. Allowed origins: ${allowedOrigins.join(", ")}`;
}
