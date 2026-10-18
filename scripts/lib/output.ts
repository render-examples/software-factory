/** Terminal output for the setup scripts and doctor: colors, check lines, and secret redaction. */

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;

function paint(code: string, text: string): string {
	return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const bold = (text: string) => paint("1", text);
export const dim = (text: string) => paint("2", text);
export const green = (text: string) => paint("32", text);
export const red = (text: string) => paint("31", text);
export const yellow = (text: string) => paint("33", text);

export type Level = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
	level: Level;
	message: string;
	/** What to do about it; shown for warn, fail, and skip. */
	fix?: string;
}

const MARKS: Record<Level, (text: string) => string> = {
	pass: green,
	warn: yellow,
	fail: red,
	skip: dim,
};

/** Replaces every occurrence of each secret with `***`. Secrets shorter than 4 characters are ignored. */
export function redact(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length >= 4) out = out.split(secret).join("***");
	}
	return out;
}

/** Prints check lines through a redaction filter and counts them by level. */
export class Reporter {
	readonly results: CheckResult[] = [];
	private readonly secrets: string[] = [];

	constructor(private readonly write: (line: string) => void = (line) => console.log(line)) {}

	/** Values that must never appear in output, such as keys and tokens. */
	addSecrets(...values: (string | undefined)[]): void {
		for (const value of values) {
			const trimmed = value?.trim();
			if (trimmed) this.secrets.push(trimmed);
		}
	}

	heading(title: string): void {
		this.write(`\n${bold(this.clean(title))}`);
	}

	line(text = ""): void {
		this.write(this.clean(text));
	}

	record(result: CheckResult): CheckResult {
		this.results.push(result);
		this.write(`  ${MARKS[result.level](result.level.padEnd(4))}  ${this.clean(result.message)}`);
		if (result.fix && result.level !== "pass") this.write(`        ${dim(this.clean(result.fix))}`);
		return result;
	}

	pass(message: string): CheckResult {
		return this.record({ level: "pass", message });
	}

	warn(message: string, fix?: string): CheckResult {
		return this.record({ level: "warn", message, fix });
	}

	fail(message: string, fix?: string): CheckResult {
		return this.record({ level: "fail", message, fix });
	}

	skip(message: string, fix?: string): CheckResult {
		return this.record({ level: "skip", message, fix });
	}

	count(level: Level): number {
		return this.results.filter((r) => r.level === level).length;
	}

	/** Prints the totals and returns the process exit code: 1 when anything failed. */
	summary(): number {
		const failed = this.count("fail");
		const warned = this.count("warn");
		const skipped = this.count("skip");
		const parts = [`${this.count("pass")} passed`, `${warned} warned`, `${failed} failed`, `${skipped} skipped`];
		this.write("");
		this.write(failed > 0 ? red(parts.join(", ")) : warned > 0 ? yellow(parts.join(", ")) : green(parts.join(", ")));
		return failed > 0 ? 1 : 0;
	}

	private clean(text: string): string {
		return redact(text, this.secrets);
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
