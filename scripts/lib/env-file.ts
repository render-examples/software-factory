import { chmod, readFile, writeFile } from "node:fs/promises";

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

export async function writeEnvFile(path: string, values: Readonly<Record<string, string>>): Promise<void> {
	let current = "";
	try {
		if (process.platform !== "win32") await chmod(path, 0o600);
		current = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeFile(path, upsertEnv(current, values), { mode: 0o600 });
}
