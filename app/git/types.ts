/** The branch this run works on, plus where it started from. */
export interface Checkout {
	remoteUrl: string;
	/** Default branch name, e.g. "main". */
	base: string;
	/** Commit the working branch was cut from; the diff baseline. */
	baseSha: string;
	branch: string;
}

export interface CommandResult {
	command: string;
	exitCode: number;
	durationMs: number;
	outputTail: string;
}

export interface VerificationResult {
	passed: boolean;
	failures: string;
	results: CommandResult[];
}
