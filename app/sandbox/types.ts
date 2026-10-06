import type { Readable } from "node:stream";

export type ExecEvent =
	| { type: "output"; stream: "stdout" | "stderr"; data: string }
	| { type: "exit"; exitCode: number };

export type UploadData = Buffer | Uint8Array | string | Readable;

export interface ExecResult {
	output: string;
	exitCode: number;
}

export type SandboxNetworkPolicy =
	| { default: "allow-all" }
	| { default: "deny-all" }
	| { default: "allow-list"; allowedDomains: string[] };

export interface CreateSandboxOptions {
	timeoutSeconds?: number;
	networkPolicy?: SandboxNetworkPolicy;
	snapshotId?: string;
}
