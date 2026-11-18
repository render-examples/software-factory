export const SANDBOX_ROOT = "/opt/factory";
export const APP_DIR = `${SANDBOX_ROOT}/app`;
export const REPO_DIR = `${SANDBOX_ROOT}/repo`;
export const SCRATCH_DIR = `${SANDBOX_ROOT}/scratch`;
export const RUN_AS = "factory";

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	timeoutMs?: number;
	asRunner?: boolean;
	signal?: AbortSignal;
}

export interface ExecStreamOptions {
	onData: (stream: "stdout" | "stderr", data: string) => void;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface Sandbox {
	readonly id: string;
	exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
	execStream(command: string, opts: ExecStreamOptions): Promise<number>;
	upload(path: string, data: string | Buffer): Promise<void>;
	download(path: string, signal?: AbortSignal): Promise<Buffer>;
	close(): Promise<void>;
}

export type SandboxRef =
	| { kind: "branch"; name: string }
	| {
			kind: "pull";
			number: number;
			headSha: string;
			baseBranch?: string;
	  };

export interface SnapshotManifest {
	repo: string;
	baseBranch: string;
	sha: string;
	lockfileHash: string;
	install: string | null;
	createdAt: string;
}

export interface OpenedSandbox extends Sandbox {
	headSha: string;
	manifest: SnapshotManifest;
}
