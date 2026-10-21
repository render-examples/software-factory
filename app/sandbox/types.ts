/** Fixed paths inside every factory sandbox. The snapshot build creates them; restored sandboxes find them in place. */
export const SANDBOX_ROOT = "/opt/factory";
/** Runner bundle, scripts, env file, and manifest. Root-owned, read-only to the runner user. */
export const APP_DIR = `${SANDBOX_ROOT}/app`;
/** The repository checkout. Owned by the runner user, so agents with write tools can edit it. */
export const REPO_DIR = `${SANDBOX_ROOT}/repo`;
/** Scratch space for the runner user (HOME and TMPDIR). */
export const SCRATCH_DIR = `${SANDBOX_ROOT}/scratch`;
/** Unprivileged user agents and repository code run as. */
export const RUN_AS = "factory";

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	timeoutMs?: number;
	/** Run as RUN_AS from REPO_DIR with a scrubbed environment, instead of as root. */
	asRunner?: boolean;
	signal?: AbortSignal;
}

/** A running sandbox. */
export interface Sandbox {
	readonly id: string;
	exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
	upload(path: string, data: string | Buffer): Promise<void>;
	download(path: string, signal?: AbortSignal): Promise<Buffer>;
	/** Idempotent: a sandbox that no longer exists counts as closed. */
	close(): Promise<void>;
}

export type SandboxRef =
	| { kind: "branch"; name: string }
	| {
			kind: "pull";
			number: number;
			headSha: string;
			/** Also fetched, in the same fetch, to `refs/remotes/origin/<baseBranch>`, so the PR's merge base is present. */
			baseBranch?: string;
	  };

/** Written by the snapshot build to `${APP_DIR}/manifest.json`. */
export interface SnapshotManifest {
	repo: string;
	baseBranch: string;
	/** Commit the snapshot was built from. */
	sha: string;
	/** sha256 over the repository's lockfiles; a mismatch after fetch triggers a reinstall. */
	lockfileHash: string;
	install: string | null;
	createdAt: string;
}

export interface OpenedSandbox extends Sandbox {
	/** Commit checked out in REPO_DIR after the fetch. */
	headSha: string;
	manifest: SnapshotManifest;
}
