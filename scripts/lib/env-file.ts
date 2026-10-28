import { chmod, readFile, writeFile } from "node:fs/promises";

/**
 * Sets each key in dotenv text: replaces an existing `KEY=` line (the first, commented-out lines untouched) or
 * appends one. Values must be single-line; base64 keeps the private key that way.
 */
function upsertEnv(text: string, values: Readonly<Record<string, string>>): string {
	const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
	for (const [key, value] of Object.entries(values)) {
		if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line`);
		const index = lines.findIndex((line) => line.startsWith(`${key}=`));
		if (index >= 0) lines[index] = `${key}=${value}`;
		else lines.push(`${key}=${value}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Updates (or creates) a dotenv file, readable only by the owner. */
export async function writeEnvFile(path: string, values: Readonly<Record<string, string>>): Promise<void> {
	let current = "";
	try {
		// writeFile's mode only protects new files. Restrict an existing file before adding secrets.
		if (process.platform !== "win32") await chmod(path, 0o600);
		current = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeFile(path, upsertEnv(current, values), { mode: 0o600 });
}
