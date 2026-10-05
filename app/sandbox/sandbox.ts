import { shellEscape } from "../shell/index.js";
import { collectExecOutput, mapExecEvents } from "./exec.js";
import { api } from "./client.js";
import type { ExecEvent, ExecResult, UploadData } from "./types.js";

export class Sandbox {
	constructor(readonly id: string) {}

	async exec(
		command: string,
		opts?: { signal?: AbortSignal },
	): Promise<AsyncGenerator<ExecEvent>> {
		const { client, ownerId } = api();
		return mapExecEvents(
			await client.exec(this.id, command, ownerId, opts?.signal),
		);
	}

	async run(
		command: string,
		opts?: { signal?: AbortSignal },
	): Promise<ExecResult> {
		return collectExecOutput(await this.exec(command, opts));
	}

	async mustRun(command: string, label: string): Promise<string> {
		const { output, exitCode } = await this.run(command);
		if (exitCode !== 0) {
			throw new Error(
				`${label} failed (exit ${exitCode}): ${output.slice(0, 500)}`,
			);
		}
		return output;
	}

	async readFile(path: string): Promise<string> {
		return this.mustRun(`cat ${shellEscape(path)}`, `Read ${path}`);
	}

	async writeFile(path: string, content: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash > 0) {
			await this.mustRun(
				`mkdir -p ${shellEscape(path.slice(0, slash))}`,
				`Create parent of ${path}`,
			);
		}
		await this.upload(path, content);
	}

	async listDir(path: string): Promise<string[]> {
		const output = await this.mustRun(
			`ls -1F ${shellEscape(path)}`,
			`List ${path}`,
		);
		return output.split("\n").filter(Boolean);
	}

	async upload(path: string, data: UploadData): Promise<void> {
		const { client, ownerId } = api();
		await client.upload(this.id, path, data, ownerId);
	}

	async download(path: string): Promise<Buffer> {
		const { client, ownerId } = api();
		const result = await client.download(this.id, path, ownerId);
		return result.data;
	}

	async terminate(): Promise<void> {
		const { client, ownerId } = api();
		await client.terminate(this.id, ownerId);
	}
}
