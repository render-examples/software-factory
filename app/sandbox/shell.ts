/** Quotes one argument for a POSIX shell. Every host-built sandbox command quotes what it interpolates. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Branch names the factory will clone or fetch: no leading dash, no shell or refspec metacharacters. */
export const SAFE_REF = /^\w[\w./-]*$/;

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** One JSON line on stderr. */
export function log(level: "info" | "warn", message: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ level, component: "sandbox", message, ...fields }));
}
