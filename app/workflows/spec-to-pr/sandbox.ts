import type {
	ExecutionHandle,
	FactoryStore,
} from "#factory/store";
import { shellEscape, type Sandbox, type SandboxProvider } from "#factory/sdk";
import type { FactoryRepository } from "../../lib/factory-config.js";
import { execGitWithToken, githubRemoteUrl } from "../../lib/sandbox-git.js";
import {
	DOWNSTREAM_STAGES,
	REPO_DIR,
	SPEC_TO_PR_SANDBOX_TIMEOUT_SECONDS,
	SPEC_TO_PR_TASK_NAME,
	STAGES,
} from "./constants.js";
import type { ReadySandboxCheckpoint } from "./contracts.js";
import { branchName } from "./context.js";
import { runCommand } from "./git.js";

export interface SandboxResult {
	sandbox: Sandbox;
	state: ReadySandboxCheckpoint;
}

interface SandboxOptions {
	provider: SandboxProvider;
	store: FactoryStore;
	execution: ExecutionHandle;
	token: string;
	repository: FactoryRepository;
	issueNumber: number;
	runId: string;
}

async function connectCheckpointedSandbox(
	provider: SandboxProvider,
	saved: ReadySandboxCheckpoint,
): Promise<Sandbox | null> {
	try {
		const sandbox = await provider.connect(saved.id);
		if ((await sandbox.status()) === "running") return sandbox;
		await sandbox.terminate().catch(() => {});
		return null;
	} catch {
		return null;
	}
}

async function createSandbox(options: SandboxOptions): Promise<SandboxResult> {
	const begun = await options.store.runs.beginStep<ReadySandboxCheckpoint>(
		options.runId,
		STAGES.sandbox.key,
		"safe",
		options.execution,
	);
	if (begun.kind === "reuse") {
		const connected = await connectCheckpointedSandbox(
			options.provider,
			begun.value,
		);
		if (connected) return { sandbox: connected, state: begun.value };
		throw new Error("Checkpointed sandbox became unavailable");
	}
	if (begun.kind === "busy") {
		throw new Error("Sandbox setup is already executing");
	}
	if (begun.kind === "blocked") {
		throw new Error("Sandbox setup was interrupted");
	}

	const sandbox = await options.provider.create({
		timeoutSeconds: SPEC_TO_PR_SANDBOX_TIMEOUT_SECONDS,
		metadata: {
			workflow: SPEC_TO_PR_TASK_NAME,
			repo: options.repository.fullName,
			issue: String(options.issueNumber),
			run: options.runId,
		},
	});
	try {
		await options.store.runs.addLink({
			runId: options.runId,
			kind: "render.sandbox",
			externalId: sandbox.id,
			metadata: { ready: false },
		});
		const remoteUrl = githubRemoteUrl(
			options.repository.owner,
			options.repository.repo,
		);
		const clone = await execGitWithToken(sandbox, options.token, [
			"git",
			"clone",
			"--depth=50",
			remoteUrl,
			REPO_DIR,
		]);
		if (clone.exitCode !== 0) {
			throw new Error(`Clone failed: ${clone.output.slice(0, 500)}`);
		}

		const remoteHead = (
			await runCommand(
				sandbox,
				`git -C ${shellEscape(REPO_DIR)} symbolic-ref --short refs/remotes/origin/HEAD`,
				"Default branch discovery",
			)
		).trim();
		if (!remoteHead.startsWith("origin/")) {
			throw new Error(`Unexpected default branch ref: ${remoteHead}`);
		}
		const base = remoteHead.slice("origin/".length);
		const baseSha = (
			await runCommand(
				sandbox,
				`git -C ${shellEscape(REPO_DIR)} rev-parse ${shellEscape(remoteHead)}`,
				"Base revision",
			)
		).trim();
		const branch = branchName(options.issueNumber, options.runId);

		await runCommand(
			sandbox,
			`git -C ${shellEscape(REPO_DIR)} checkout -b ${shellEscape(branch)} ${shellEscape(remoteHead)} && ` +
				`git -C ${shellEscape(REPO_DIR)} config user.name "render-factory[bot]" && ` +
				`git -C ${shellEscape(REPO_DIR)} config user.email "bot@render-factory.dev"`,
			"Repository setup",
		);
		const state: ReadySandboxCheckpoint = {
			id: sandbox.id,
			ready: true,
			remoteUrl,
			remoteHead,
			base,
			baseSha,
			branch,
		};
		await options.store.runs.completeStep(
			options.runId,
			STAGES.sandbox.key,
			state,
			options.execution,
		);
		await options.store.runs.addLink({
			runId: options.runId,
			kind: "render.sandbox",
			externalId: sandbox.id,
			metadata: { ready: true },
		});
		return { sandbox, state };
	} catch (error) {
		await options.store.runs
			.failStep(
				options.runId,
				STAGES.sandbox.key,
				"sandbox_setup_failed",
				options.execution,
			)
			.catch(() => {});
		await sandbox.terminate().catch(() => {});
		throw error;
	}
}

export async function getOrCreateSandbox(
	options: SandboxOptions,
): Promise<SandboxResult> {
	const saved = await options.store.runs.getStep<ReadySandboxCheckpoint>(
		options.runId,
		STAGES.sandbox.key,
	);
	if (saved?.status === "completed" && saved.value?.ready) {
		const sandbox = await connectCheckpointedSandbox(
			options.provider,
			saved.value,
		);
		if (sandbox) return { sandbox, state: saved.value };
		await options.store.runs.invalidateSteps(
			options.runId,
			[STAGES.sandbox.key, ...DOWNSTREAM_STAGES],
			"sandbox_unavailable",
			options.execution,
		);
	}

	for (const link of await options.store.runs.listLinks(options.runId)) {
		if (link.kind !== "render.sandbox") continue;
		try {
			await (await options.provider.connect(link.externalId)).terminate();
		} catch {
			// A partially-created or prior sandbox may already be gone.
		}
	}
	return createSandbox(options);
}

export async function terminateCheckpointedSandbox(
	provider: SandboxProvider,
	store: FactoryStore,
	runId: string,
): Promise<void> {
	const saved = await store.runs.getStep<ReadySandboxCheckpoint>(
		runId,
		STAGES.sandbox.key,
	);
	if (saved?.status !== "completed" || !saved.value) return;
	try {
		await (await provider.connect(saved.value.id)).terminate();
	} catch {
		// A prior terminal execution may already have removed it.
	}
}
