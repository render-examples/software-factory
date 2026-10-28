import { randomUUID } from "node:crypto";
import { SandboxSnapshotNotFoundError, SandboxSnapshotNotReadyError } from "@renderinc/sdk";
import { z } from "zod";
import { config, type RepoContext } from "../config/index.js";
import { type SandboxClient, sandboxClient } from "./client.js";
import { errorMessage, log, SAFE_REF } from "./shell.js";
import {
	asRunner,
	type BuiltSnapshot,
	buildSnapshot,
	computeLockfileHash,
	credentialFile,
	credentialHelperArgs,
	ensureRunnerPayload,
	readToken,
	resolveBaseHead,
	runInstall,
	type SnapshotDeps,
	snapshotName,
} from "./snapshot.js";
import { APP_DIR, type OpenedSandbox, REPO_DIR, RUN_AS, type Sandbox, type SandboxRef, SCRATCH_DIR, type SnapshotManifest } from "./types.js";
import { ALLOW_ALL_EGRESS, verifySandbox } from "./verify.js";

const SnapshotManifestSchema = z.object({
	repo: z.string(),
	baseBranch: z.string(),
	sha: z.string().regex(/^[0-9a-f]{40}$/),
	lockfileHash: z.string(),
	install: z.string().nullable(),
	createdAt: z.string(),
}) satisfies z.ZodType<SnapshotManifest>;

/** A handle on a running sandbox by id. */
function connectSandbox(id: string, client?: SandboxClient): Sandbox {
	const get = () => client ?? sandboxClient();
	return {
		id,
		async exec(command, opts = {}) {
			const c = get();
			const wrapped = opts.asRunner ? asRunner("bash", "-c", command) : command;
			return c.exec(id, wrapped, { timeoutMs: opts.timeoutMs ?? c.t.execTimeoutMs, signal: opts.signal });
		},
		async upload(path, data) {
			await get().upload(id, path, data);
		},
		async download(path, signal) {
			return get().download(id, path, signal);
		},
		async close() {
			await get().terminate(id);
		},
	};
}

export interface OpenSandboxDeps extends SnapshotDeps {
	client?: SandboxClient;
	resolveBaseHead?: (repo: RepoContext, deps: SnapshotDeps) => Promise<string>;
	buildSnapshot?: (client: SandboxClient, repo: RepoContext, sha: string, deps: SnapshotDeps) => Promise<BuiltSnapshot>;
}

/**
 * Restores the repository's named snapshot (building it inline once if none is available), verifies it,
 * fetches `ref` as the runner user, and reinstalls dependencies if the lockfiles changed. Terminates the
 * sandbox if anything after creation fails; the caller closes it in `finally` otherwise.
 */
export async function openSandbox(repo: RepoContext, ref: SandboxRef, deps: OpenSandboxDeps = {}): Promise<OpenedSandbox> {
	checkRef(ref);
	const client = deps.client ?? sandboxClient();
	const id = await createFromSnapshot(client, repo, deps);
	try {
		await client.waitRunning(id);
		await ensureRunnerPayload(client, id);
		const info = await verifySandbox(client, id);
		// verify.sh can only probe /proc as root; a sandbox where it couldn't check never gets a model key.
		if (!info.runnerNonDumpable) throw new Error(`could not confirm the runner is non-dumpable in ${id}`);
		const manifest = SnapshotManifestSchema.parse(JSON.parse((await client.download(id, `${APP_DIR}/manifest.json`)).toString("utf8")));
		if (manifest.repo !== repo.fullName) throw new Error(`snapshot in ${id} is for ${manifest.repo}, not ${repo.fullName}`);

		const headSha = await fetchRef(client, id, repo, ref, deps);
		const install = repo.config.install?.trim() || null;
		if (install) {
			const lockfileHash = await computeLockfileHash(client, id);
			if (lockfileHash !== manifest.lockfileHash || install !== manifest.install) {
				log("info", "reinstalling dependencies", { sandbox: id, repo: repo.fullName, headSha });
				await runInstall(client, id, install);
			}
		}
		return { ...connectSandbox(id, client), headSha, manifest };
	} catch (err) {
		await client.terminateQuietly(id);
		throw err;
	}
}

/**
 * Opens a sandbox, runs `fn` with it, and closes it whatever happens. Every task uses this, so no task can forget
 * to close one; the provider-side timeout covers a Workflows process that dies before `finally` runs.
 */
export async function withSandbox<S extends Sandbox, T>(open: () => Promise<S>, fn: (sandbox: S) => Promise<T>): Promise<T> {
	const sandbox = await open();
	try {
		return await fn(sandbox);
	} finally {
		await sandbox.close().catch((err: unknown) => log("warn", "could not close sandbox", { sandbox: sandbox.id, error: errorMessage(err) }));
	}
}

function checkRef(ref: SandboxRef): void {
	if (ref.kind === "branch" && !SAFE_REF.test(ref.name)) throw new Error(`unsupported branch name ${JSON.stringify(ref.name)}`);
	if (ref.kind === "pull") {
		if (!Number.isInteger(ref.number) || ref.number <= 0) throw new Error(`invalid pull request number ${ref.number}`);
		if (!/^[0-9a-f]{40}$/.test(ref.headSha)) throw new Error(`invalid head SHA ${JSON.stringify(ref.headSha)}`);
		if (ref.baseBranch !== undefined && !SAFE_REF.test(ref.baseBranch)) {
			throw new Error(`unsupported base branch name ${JSON.stringify(ref.baseBranch)}`);
		}
	}
}

function isSnapshotUnavailable(err: unknown): boolean {
	return err instanceof SandboxSnapshotNotFoundError || err instanceof SandboxSnapshotNotReadyError;
}

async function createFromSnapshot(client: SandboxClient, repo: RepoContext, deps: OpenSandboxDeps): Promise<string> {
	const name = snapshotName(repo);
	const create = async () =>
		(
			await client.call(() =>
				client.api.create({
					snapshotName: name,
					networkPolicy: ALLOW_ALL_EGRESS,
					timeoutSeconds: config.sandbox.timeoutSeconds,
				}),
			)
		).id;
	try {
		return await create();
	} catch (err) {
		if (!isSnapshotUnavailable(err)) throw err;
		log("warn", "no available snapshot; building one inline", { repo: repo.fullName, snapshot: name, error: errorMessage(err) });
	}
	const sha = await (deps.resolveBaseHead ?? resolveBaseHead)(repo, deps);
	await (deps.buildSnapshot ?? buildSnapshot)(client, repo, sha, deps);
	try {
		return await create();
	} catch (err) {
		if (isSnapshotUnavailable(err)) {
			throw new Error(`no available snapshot named ${name} even after building one inline: ${errorMessage(err)}`, { cause: err });
		}
		throw err;
	}
}

/**
 * Fetches `ref` into REPO_DIR as the runner user and checks it out detached. The read token is a file only the
 * runner user can read, deleted (and checked for leaks) right after the fetch, whether or not it succeeded.
 */
async function fetchRef(client: SandboxClient, id: string, repo: RepoContext, ref: SandboxRef, deps: SnapshotDeps): Promise<string> {
	const dir = `/tmp/factory-fetch-${randomUUID()}`;
	const quick = { timeoutMs: client.t.verifyTimeoutMs };
	const source = ref.kind === "branch" ? `refs/heads/${ref.name}` : `refs/pull/${ref.number}/head`;
	// FETCH_HEAD's first line is the first refspec, so `source` stays first.
	const refspecs = [source];
	if (ref.kind === "pull" && ref.baseBranch) refspecs.push(`+refs/heads/${ref.baseBranch}:refs/remotes/origin/${ref.baseBranch}`);
	await client.check(id, `mkdir -m 700 ${dir}`, quick);
	let fetchError: unknown;
	try {
		const token = await (deps.readToken ?? readToken)(repo);
		await client.upload(id, `${dir}/github.com`, credentialFile(token));
		await client.check(id, `chown -R ${RUN_AS}: ${dir} && chmod 600 ${dir}/github.com`, quick);
		await client.check(id, asRunner("git", ...credentialHelperArgs(dir), "fetch", "--quiet", "--no-tags", "origin", ...refspecs), {
			timeoutMs: client.t.prepareTimeoutMs,
		});
	} catch (err) {
		fetchError = err;
	}
	const scrub = await client.exec(id, `bash ${APP_DIR}/build/scrub-credentials.sh ${dir} ${REPO_DIR} ${SCRATCH_DIR}/home`, quick);
	if (scrub.exitCode !== 0) throw new Error(`credential scrub failed: ${(scrub.stderr || scrub.stdout).trim().slice(-2000)}`);
	if (fetchError) throw fetchError;

	const fetched = (await client.check(id, asRunner("git", "rev-parse", "FETCH_HEAD^{commit}"), quick)).trim();
	if (!/^[0-9a-f]{40}$/.test(fetched)) throw new Error(`fetching ${source} gave ${JSON.stringify(fetched.slice(0, 100))}`);
	if (ref.kind === "pull" && fetched !== ref.headSha) {
		throw new Error(`head moved: ${repo.fullName}#${ref.number} is at ${fetched}, expected ${ref.headSha}`);
	}
	await client.check(id, asRunner("git", "checkout", "--quiet", "--detach", fetched), quick);
	return fetched;
}
