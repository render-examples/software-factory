import type { Readable } from "node:stream";

export type ExecEvent =
	| { type: "output"; stream: "stdout" | "stderr"; data: string }
	| { type: "exit"; exitCode: number };

export type UploadData = Buffer | Uint8Array | string | Readable;

export interface ExecResult {
	output: string;
	exitCode: number;
}

export interface CreateSandboxOptions {
	timeoutSeconds?: number;
	networkPolicy?: {
		default: "allow-all" | "deny-all" | "allow-list";
		allowedDomains?: string[];
	};
}
