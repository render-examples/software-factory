export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export const SAFE_REF = /^\w[\w./-]*$/;

export function log(level: "info" | "warn", msg: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ level, component: "sandbox", msg, ...fields }));
}
