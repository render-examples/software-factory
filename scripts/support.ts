/** Shared output and prompt helpers for the setup scripts. */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const useColor = !process.env.NO_COLOR && stdout.isTTY;

function paint(code: string, text: string): string {
	return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const bold = (text: string) => paint("1", text);
export const dim = (text: string) => paint("2", text);
export const green = (text: string) => paint("32", text);
export const red = (text: string) => paint("31", text);
export const yellow = (text: string) => paint("33", text);

export function heading(title: string): void {
	console.log(`\n${bold(title)}`);
}

export type Level = "ok" | "fail" | "warn";

export interface Finding {
	level: Level;
	message: string;
	/** What to do about it. Shown only for warnings and failures. */
	fix?: string;
}

export function print({ level, message, fix }: Finding): void {
	const mark =
		level === "ok" ? green("✓") : level === "fail" ? red("✗") : yellow("!");
	console.log(`  ${mark} ${message}`);
	if (fix && level !== "ok") console.log(`      ${dim(fix)}`);
}

export async function ask(question: string, fallback?: string): Promise<string> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const suffix = fallback ? ` ${dim(`(${fallback})`)}` : "";
		const answer = (await rl.question(`${question}${suffix}: `)).trim();
		return answer || fallback || "";
	} finally {
		rl.close();
	}
}

export async function confirm(question: string): Promise<boolean> {
	return /^y(es)?$/i.test(await ask(`${question} ${dim("(y/N)")}`));
}

/** Every script exits non-zero on failure so CI can gate on it. */
export function exitWith(findings: Finding[]): never {
	const failed = findings.filter((f) => f.level === "fail").length;
	const warned = findings.filter((f) => f.level === "warn").length;

	console.log();
	if (failed > 0) {
		console.log(red(`${failed} problem${failed === 1 ? "" : "s"} to fix.`));
		process.exit(1);
	}
	if (warned > 0) {
		console.log(yellow(`Ready, with ${warned} warning${warned === 1 ? "" : "s"}.`));
		process.exit(0);
	}
	console.log(green("Everything checks out."));
	process.exit(0);
}
