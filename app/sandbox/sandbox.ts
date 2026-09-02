import { api } from "./client.js";
import { collectExecOutput, mapExecEvents, shellEscape } from "./exec.js";
import type { ExecEvent, ExecResult, UploadData } from "./types.js";

/**
 * One Render Sandbox. Workflow code owns the lifecycle; agents only reach a
 * sandbox through the tools in app/tools, which receive an instance of this
 * class already bound to the run.
 */
export class Sandbox {
	constructor(readonly id: string) {}

	/** Stream a command's output. Use `run` unless you need it incrementally. */
	async exec(
		command: string,
		opts?: { signal?: AbortSignal },
	): Promise<AsyncGenerator<ExecEvent>> {
		const { client, ownerId } = api();
		return mapExecEvents(
			await client.exec(this.id, command, ownerId, opts?.signal),
		);
	}

	/** Run a command to completion. A non-zero exit is returned, not thrown. */
	async run(
		command: string,
		opts?: { signal?: AbortSignal },
	): Promise<ExecResult> {
		return collectExecOutput(await this.exec(command, opts));
	}

	/** Run a command and throw if it fails. `label` names the step in the error. */
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

	async terminate(): Promise<void> {
		const { client, ownerId } = api();
		await client.terminate(this.id, ownerId);
	}
}
