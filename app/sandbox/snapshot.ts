import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ClientError, SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { SandboxSnapshot } from "@renderinc/sdk/experimental";
import { create as createTar } from "tar";
import { AGENTS } from "../agents/registry.js";
import type { RepoContext } from "../config/index.js";
import { githubToken } from "../github/auth.js";
import { bundleRunner } from "../runner/bundle.js";
import type { HarnessProvision } from "../harness/types.js";
import { type SandboxApi, type SandboxClient, TRANSIENT } from "./client.js";
import { errorMessage, log, SAFE_REF, shq } from "./shell.js";
import { APP_DIR, REPO_DIR, RUN_AS, SANDBOX_ROOT, SCRATCH_DIR, type SnapshotManifest } from "./types.js";
import { ALLOW_ALL_EGRESS, verifySandbox } from "./verify.js";

/** The one named snapshot per repository: `factory-<owner>-<name>`, restricted to [A-Za-z0-9_.-]. */
export function snapshotName(repo: Pick<RepoContext, "owner" | "name">): string {
	return `factory-${repo.owner}-${repo.name}`.replace(/[^A-Za-z0-9_.-]/g, "-");
}

/** Snapshots kept per name: a sandbox that started restoring just before a new build finished must still find its own. */
const KEEP_SNAPSHOTS = 2;
/** Render terminates the builder after this, even if the task building it crashed. */
const BUILDER_TIMEOUT_SECONDS = 3_600;
const SANDBOX_SCRIPTS_DIR = fileURLToPath(new URL("../../sandbox/", import.meta.url));

/** Copied into APP_DIR and kept in the snapshot. `build/` is needed again when a restored sandbox fetches. */
const RUNTIME_SCRIPTS = [
	"install-tools.sh",
	"as-runner.sh",
	"run-agent.sh",
	"collect-changes.sh",
	"lockfile-hash.sh",
	"verify.sh",
	"build/git-credential-staged.sh",
	"build/scrub-credentials.sh",
] as const;

const STAGING_DIR = "/tmp/factory-stage";
const STAGING_CREDS = `${STAGING_DIR}/creds`;
const SANDBOX_GITCONFIG = "[core]\n\tfsmonitor = false\n[advice]\n\tdetachedHead = false\n";
/** Username GitHub expects alongside an installation token. */
const GITHUB_TOKEN_USER = "x-access-token";

export interface SnapshotDeps {
	/** A read-only token for the repository. Defaults to a GitHub App installation token with `contents: read`. */
	readToken?: (repo: RepoContext) => Promise<string>;
}

export interface BuiltSnapshot {
	id: string;
	sandboxGroupId: string;
	name: string;
	manifest: SnapshotManifest;
}

export function readToken(repo: RepoContext): Promise<string> {
	return githubToken({ installationId: repo.installationId, repo: repo.name, permissions: { contents: "read" } });
}

/** Runs a command as the runner user from REPO_DIR (as-runner.sh), with each argument quoted. */
export function asRunner(...argv: string[]): string {
	return `bash ${APP_DIR}/as-runner.sh ${argv.map(shq).join(" ")}`;
}

/** The credential helper that answers git from a staged `<dir>/<host>` file; the token is never in argv or config. */
export function credentialHelperArgs(credsDir: string): string[] {
	return ["-c", "credential.helper=", "-c", `credential.helper=!bash ${APP_DIR}/build/git-credential-staged.sh ${credsDir}`];
}

/** The staged credential file's contents: username on line 1, token on line 2, no trailing newline. */
export function credentialFile(token: string): string {
	return `${GITHUB_TOKEN_USER}\n${token}`;
}

// ── Build ───────────────────────────────────────────────────────────────
//
// Each step is an exec or upload in an allow-all builder sandbox, ordered by trust:
//
//   1. Upload the scripts and runner payload; install tools; create the runner user; apply harness provisions;
//      self-test the runner
//   2. Upload a read-only token, clone at `sha`, scrub the token and verify none remains
//   3. Hand REPO_DIR to the runner user and run the repository's install as that user (no secret present)
//   4. Manifest, lockdown, verify.sh, named snapshot, prune

/** Builds the repository's named snapshot at `sha` and prunes older ones, keeping the newest two. */
export async function buildSnapshot(client: SandboxClient, repo: RepoContext, sha: string, deps: SnapshotDeps = {}): Promise<BuiltSnapshot> {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`refusing to build ${repo.fullName} at ${JSON.stringify(sha)}: not a commit SHA`);
	const branch = repo.config.baseBranch;
	if (!SAFE_REF.test(branch)) throw new Error(`${repo.fullName}: unsupported base branch ${JSON.stringify(branch)}`);
	const name = snapshotName(repo);
	const t = client.t;
	const prepare = { timeoutMs: t.prepareTimeoutMs };
	const boot = { timeoutMs: t.bootTimeoutMs };
	const started = Date.now();
	log("info", "snapshot build started", { repo: repo.fullName, sha, snapshot: name });

	const { id } = await client.call(() => client.api.create({ timeoutSeconds: BUILDER_TIMEOUT_SECONDS, networkPolicy: ALLOW_ALL_EGRESS }));
	try {
		await client.waitRunning(id);

		// ── 1. Scripts, tools, runner user, self-test ───────────────────
		await client.check(id, `mkdir -p -m 700 ${STAGING_DIR}`, { ...boot, waitReady: true });
		// Uploaded as an opaque .tgz and extracted in the sandbox: the upload endpoint rejects an
		// uncompressed tar of the bundled runner's JavaScript, and doesn't accept application/gzip.
		const payload = await runnerPayload();
		await client.upload(id, `${STAGING_DIR}/stage.tgz`, await stagingArchive(payload));
		await client.check(id, `tar -xzf ${STAGING_DIR}/stage.tgz -C ${STAGING_DIR} && rm ${STAGING_DIR}/stage.tgz`, boot);
		await client.check(
			id,
			`mkdir -p ${APP_DIR}/runner ${APP_DIR}/build ${REPO_DIR} ${SCRATCH_DIR}` +
				` && cp ${STAGING_DIR}/*.sh ${APP_DIR}/ && cp ${STAGING_DIR}/build/*.sh ${APP_DIR}/build/` +
				` && cp -R ${STAGING_DIR}/runner/. ${APP_DIR}/runner/`,
			boot,
		);
		await client.check(id, `bash ${APP_DIR}/install-tools.sh`, prepare);
		const node = await nodePath(client, id);
		await client.check(id, createRunnerUserCommand(), boot);
		await client.upload(id, `${APP_DIR}/env`, envFileContent(node));
		await client.upload(id, `${APP_DIR}/gitconfig`, SANDBOX_GITCONFIG);
		await applyProvisions(client, id, payload.provisions);
		// The self-test executes third-party code (the bundled packages); the token arrives only after it passes.
		await client.check(
			id,
			[
				`chmod 755 ${SANDBOX_ROOT}`,
				`chmod -R a+rX,go-w ${APP_DIR}`,
				`chown ${RUN_AS}: ${SCRATCH_DIR}`,
				`chmod 700 ${SCRATCH_DIR}`,
				`timeout 120 ${asRunner(node, `${APP_DIR}/runner/runner.mjs`, "--self-test")}`,
			].join(" && "),
			prepare,
		);

		// ── 2. Token, clone, scrub ───────────────────────────────────────
		const token = await (deps.readToken ?? readToken)(repo);
		await client.check(id, `mkdir -p -m 700 ${STAGING_CREDS}`, boot);
		await client.upload(id, `${STAGING_CREDS}/github.com`, credentialFile(token));
		await client.check(id, cloneCommand(repo, sha), prepare);
		const scrub = await client.exec(id, `bash ${APP_DIR}/build/scrub-credentials.sh ${STAGING_CREDS} ${REPO_DIR} ${SCRATCH_DIR}/home`, prepare);
		if (scrub.exitCode !== 0) throw new Error(`credential scrub failed: ${(scrub.stderr || scrub.stdout).trim().slice(-2000)}`);

		// ── 3. Runner-owned checkout, install as the runner ──────────────
		await client.check(id, `chown -R ${RUN_AS}: ${REPO_DIR}`, prepare);
		const lockfileHash = await computeLockfileHash(client, id);
		const install = repo.config.install?.trim() || null;
		if (install) await runInstall(client, id, install);

		// ── 4. Manifest, lockdown, verify, snapshot ──────────────────────
		const manifest: SnapshotManifest = {
			repo: repo.fullName,
			baseBranch: branch,
			sha,
			lockfileHash,
			install,
			createdAt: new Date().toISOString(),
		};
		await client.upload(id, `${APP_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
		await client.check(id, lockdownCommand(node), prepare);
		await verifySandbox(client, id);

		const snap = await createSnapshot(client, id, name);
		await pruneSnapshots(client, snap.sandboxGroupId, name, KEEP_SNAPSHOTS);
		log("info", "snapshot build finished", { repo: repo.fullName, sha, snapshot: name, id: snap.id, ms: Date.now() - started });
		return { id: snap.id, sandboxGroupId: snap.sandboxGroupId, name, manifest };
	} finally {
		await client.terminateQuietly(id);
	}
}

/** The base image's node, which the runner and the repository's tools run under. */
async function nodePath(client: SandboxClient, id: string): Promise<string> {
	const path = (await client.check(id, "command -v node", { timeoutMs: client.t.bootTimeoutMs })).trim();
	if (!path.startsWith("/")) throw new Error(`command -v node printed ${JSON.stringify(path.slice(0, 200))}`);
	return path;
}

/** Creates the unprivileged runner user. */
function createRunnerUserCommand(): string {
	return (
		`id -u ${RUN_AS} >/dev/null 2>&1` +
		` || useradd --system --user-group --no-create-home --home-dir ${SCRATCH_DIR}/home --shell /usr/sbin/nologin ${RUN_AS}`
	);
}

/** The env file that the sandbox scripts source. */
function envFileContent(nodePath: string): string {
	const nodeDir = nodePath.substring(0, nodePath.lastIndexOf("/"));
	return `${[
		`FACTORY_ROOT=${SANDBOX_ROOT}`,
		`FACTORY_APP_DIR=${APP_DIR}`,
		`FACTORY_REPO_DIR=${REPO_DIR}`,
		`FACTORY_SCRATCH_DIR=${SCRATCH_DIR}`,
		`FACTORY_RUN_AS=${RUN_AS}`,
		`FACTORY_NODE=${nodePath}`,
		`FACTORY_RUNNER_NODE=${APP_DIR}/node-runner`,
		`FACTORY_PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
	].join("\n")}\n`;
}

/** Clones the base branch into REPO_DIR and checks out `sha` on a local branch named after it. */
function cloneCommand(repo: RepoContext, sha: string): string {
	const url = `https://github.com/${repo.owner}/${repo.name}.git`;
	const branch = repo.config.baseBranch;
	const auth = credentialHelperArgs(STAGING_CREDS).map(shq).join(" ");
	return [
		`GIT_TERMINAL_PROMPT=0 git ${auth} clone --quiet --single-branch --branch ${shq(branch)} --no-tags -- ${shq(url)} ${REPO_DIR}`,
		`git -C ${REPO_DIR} checkout --quiet -B ${shq(branch)} ${sha}`,
		`head=$(git -C ${REPO_DIR} rev-parse HEAD) && [ "$head" = ${sha} ]`,
	].join(" && ");
}

/** sha256 over the repository's lockfiles (lockfile-hash.sh), computed as the runner user. */
export async function computeLockfileHash(client: SandboxClient, id: string): Promise<string> {
	const out = (await client.check(id, asRunner("bash", `${APP_DIR}/lockfile-hash.sh`, "."), { timeoutMs: client.t.verifyTimeoutMs })).trim();
	if (!/^[0-9a-f]{64}$/.test(out)) throw new Error(`lockfile-hash.sh printed ${JSON.stringify(out.slice(0, 200))}`);
	return out;
}

/**
 * Runs the repository's install command as the runner user, then fails if it changed any tracked file: the
 * checkout is what agents edit and publish from, so a dirty tree would leak into every PR.
 */
export async function runInstall(client: SandboxClient, id: string, install: string): Promise<void> {
	const res = await client.exec(id, asRunner("bash", "-c", install), { timeoutMs: client.t.prepareTimeoutMs });
	if (res.exitCode !== 0) {
		throw new Error(`install (${install}) exited ${res.exitCode}: ${(res.stderr || res.stdout).trim().slice(-2000)}`);
	}
	const dirty = (
		await client.check(id, asRunner("git", "status", "--porcelain", "--untracked-files=no"), {
			timeoutMs: client.t.verifyTimeoutMs,
		})
	).trim();
	if (dirty) {
		throw new Error(
			`install (${install}) modified tracked files, which would leak into every PR; ` +
				`make the install leave the checkout clean (e.g. npm ci, not npm install):\n${dirty.split("\n").slice(0, 20).join("\n")}`,
		);
	}
}

/** Makes APP_DIR root-owned and read-only and installs the execute-only node the runner runs under. */
function lockdownCommand(nodePath: string): string {
	return [
		`chown root:root ${SANDBOX_ROOT}`,
		`chmod 755 ${SANDBOX_ROOT}`,
		`chown -R root:root ${APP_DIR}`,
		`chmod -R a+rX,go-w ${APP_DIR}`,
		`chown ${RUN_AS}: ${SCRATCH_DIR}`,
		`chmod 700 ${SCRATCH_DIR}`,
		`install -o root -g root -m 0711 ${shq(nodePath)} ${APP_DIR}/node-runner`,
		`rm -rf ${STAGING_DIR}`,
	].join(" && ");
}

async function createSnapshot(client: SandboxClient, sandboxId: string, name: string): Promise<SandboxSnapshot> {
	let snap = await client.call(() => client.api.snapshots.create({ sandboxId, kind: "filesystem", name }));
	const until = Date.now() + client.t.snapshotTimeoutMs;
	while (snap.status === "creating") {
		if (Date.now() > until) throw new Error(`snapshot ${snap.id} still creating after ${client.t.snapshotTimeoutMs}ms`);
		await sleep(client.t.pollMs);
		const { id, sandboxGroupId } = snap;
		snap = await client.call(() => client.api.snapshots.get({ sandboxGroupId, snapshotId: id }), { retryOn: TRANSIENT });
	}
	if (snap.status !== "available") throw new Error(`snapshot ${snap.id} ${snap.status}: ${snap.error ?? "no error given"}`);
	return snap;
}

// ── Runner payload ──────────────────────────────────────────────────────

const RUNNER_DIR = `${APP_DIR}/runner`;
const PROVISION_DIR = `${APP_DIR}/provision`;

export interface RunnerPayload {
	/** Paths relative to APP_DIR/runner/: the bundle, then every file the agents' harnesses provision. */
	files: ReadonlyMap<string, Buffer>;
	sha256: string;
	runnerSha256: string;
	provisions: readonly HarnessProvision[];
}

let built: Promise<RunnerPayload> | undefined;

/** The runner bundle and the agents' harness provisions, built once per process. */
export function runnerPayload(): Promise<RunnerPayload> {
	built ??= buildPayload().catch((err: unknown) => {
		built = undefined;
		throw err;
	});
	return built;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function buildPayload(): Promise<RunnerPayload> {
	const runner = Buffer.from(await bundleRunner());
	const files = new Map<string, Buffer>([["runner.mjs", runner]]);
	const provisions = [...new Map(AGENTS.flatMap((a) => (a.harness.provision ? [a.harness.provision()] : [])).map((p) => [p.id, p])).values()];
	for (const provision of provisions) {
		if (!/^[a-z0-9-]+$/.test(provision.id)) throw new Error(`harness provision id ${JSON.stringify(provision.id)} must be [a-z0-9-]`);
		if (!/^[A-Za-z0-9._-]+$/.test(provision.hash)) throw new Error(`harness provision ${provision.id}: hash must be [A-Za-z0-9._-]`);
		for (const file of provision.files) {
			const parts = file.path.split("/");
			if (file.path.startsWith("/") || parts.includes("..") || parts.includes("") || ["runner.mjs", "payload.sha256"].includes(file.path)) {
				throw new Error(`harness provision ${provision.id}: unsafe path ${JSON.stringify(file.path)}`);
			}
			const data = await readFile(file.source);
			const existing = files.get(file.path);
			if (existing && !existing.equals(data)) throw new Error(`harness provisions ship different files at ${file.path}`);
			files.set(file.path, data);
		}
	}
	const digest = createHash("sha256");
	for (const path of [...files.keys()].sort()) {
		const data = files.get(path) as Buffer;
		digest.update(`${path}\0${data.length}\0`).update(data);
	}
	return { files, sha256: digest.digest("hex"), runnerSha256: sha256(runner), provisions };
}

/** The payload as a gzipped tar rooted at APP_DIR/runner/. */
async function payloadArchive(payload: RunnerPayload): Promise<Buffer> {
	const dir = await mkdtemp(join(tmpdir(), "factory-payload-"));
	try {
		for (const [path, data] of payload.files) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), data);
		}
		await writeFile(join(dir, "payload.sha256"), payload.sha256);
		const chunks: Buffer[] = [];
		for await (const chunk of createTar({ cwd: dir, portable: true, gzip: true }, await readdir(dir))) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Replaces a restored sandbox's runner directory with this host's payload when they differ, then applies the
 * harness provisions, so harness, model, and agent changes reach existing snapshots without a rebuild. It runs
 * before verify.sh, which self-tests the runner. Returns whether it replaced the payload.
 */
export async function ensureRunnerPayload(client: SandboxClient, id: string): Promise<boolean> {
	const payload = await runnerPayload();
	const quick = { timeoutMs: client.t.verifyTimeoutMs };
	const current = (await client.exec(id, `cat ${RUNNER_DIR}/payload.sha256 2>/dev/null`, { ...quick, waitReady: true })).stdout.trim();
	let replaced = false;
	if (current !== payload.sha256) {
		const stage = `/tmp/factory-runner-${randomUUID()}`;
		const next = `${APP_DIR}/runner.next`;
		await client.check(id, `mkdir -m 700 ${stage}`, quick);
		try {
			// Gzipped, as the staging archive: the upload endpoint rejects the bundle's raw JavaScript.
			await client.upload(id, `${stage}/payload.tgz`, await payloadArchive(payload));
			await client.check(
				id,
				[
					`rm -rf ${next} ${APP_DIR}/runner.prev`,
					`mkdir -m 755 ${next}`,
					`tar -xzf ${stage}/payload.tgz -C ${next}`,
					`[ "$(sha256sum ${next}/runner.mjs | cut -d' ' -f1)" = ${payload.runnerSha256} ]`,
					`chown -R root:root ${next}`,
					`chmod -R a+rX,go-w ${next}`,
					`mv ${RUNNER_DIR} ${APP_DIR}/runner.prev`,
					`mv ${next} ${RUNNER_DIR}`,
					`rm -rf ${APP_DIR}/runner.prev`,
				].join(" && "),
				quick,
			);
		} finally {
			await client.exec(id, `rm -rf ${stage}`, quick).catch(() => {});
		}
		log("info", "runner payload replaced", { sandbox: id, from: current || null, to: payload.sha256 });
		replaced = true;
	}
	await applyProvisions(client, id, payload.provisions);
	return replaced;
}

/** Runs each provision's command as root from APP_DIR/runner when its hash differs from the one recorded. */
async function applyProvisions(client: SandboxClient, id: string, provisions: readonly HarnessProvision[]): Promise<void> {
	for (const provision of provisions) {
		if (!provision.command) continue;
		const marker = `${PROVISION_DIR}/${provision.id}.hash`;
		const recorded = (await client.exec(id, `cat ${marker} 2>/dev/null`, { timeoutMs: client.t.verifyTimeoutMs })).stdout.trim();
		if (recorded === provision.hash) continue;
		const started = Date.now();
		await client.check(
			id,
			`cd ${RUNNER_DIR} && bash -c ${shq(provision.command)} && mkdir -p -m 755 ${PROVISION_DIR} && printf '%s' ${shq(provision.hash)} > ${marker}`,
			{ timeoutMs: client.t.prepareTimeoutMs },
		);
		log("info", "harness provision applied", { sandbox: id, provision: provision.id, ms: Date.now() - started });
	}
}

/** A gzipped tar of the runtime scripts and the runner payload under runner/. */
async function stagingArchive(payload: RunnerPayload): Promise<Buffer> {
	const dir = await mkdtemp(join(tmpdir(), "factory-stage-"));
	try {
		await mkdir(join(dir, "runner"));
		await mkdir(join(dir, "build"));
		for (const [path, data] of payload.files) {
			await mkdir(dirname(join(dir, "runner", path)), { recursive: true });
			await writeFile(join(dir, "runner", path), data);
		}
		await writeFile(join(dir, "runner/payload.sha256"), payload.sha256);
		for (const file of RUNTIME_SCRIPTS) await cp(join(SANDBOX_SCRIPTS_DIR, file), join(dir, file));
		const chunks: Buffer[] = [];
		for await (const chunk of createTar({ cwd: dir, portable: true, gzip: true }, await readdir(dir))) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ── Prune ───────────────────────────────────────────────────────────────

/** Deletes older available/failed snapshots with this name, keeping the newest `keep`. Logs instead of throwing. */
async function pruneSnapshots(client: SandboxClient, sandboxGroupId: string, name: string, keep: number): Promise<void> {
	try {
		const list: Awaited<ReturnType<SandboxApi["snapshots"]["list"]>> = [];
		for (let cursor: string | undefined; ; ) {
			const page = await client.call(() => client.api.snapshots.list({ sandboxGroupId, status: ["available", "failed"], cursor, limit: 100 }));
			list.push(...page);
			cursor = page.at(-1)?.cursor;
			if (page.length < 100 || !cursor) break;
		}
		const stale = list
			.filter(({ snapshot }) => snapshot.name === name)
			.sort((a, b) => Date.parse(b.snapshot.requestedAt) - Date.parse(a.snapshot.requestedAt))
			.slice(keep);
		for (const { snapshot } of stale) {
			try {
				await client.call(() => client.api.snapshots.delete({ sandboxGroupId, snapshotId: snapshot.id }));
			} catch (err) {
				if (err instanceof SandboxSnapshotNotFoundError || (err instanceof ClientError && err.statusCode === 404)) continue;
				throw err;
			}
		}
	} catch (err) {
		log("warn", "snapshot prune failed", { snapshot: name, error: errorMessage(err) });
	}
}

// ── Base branch head (host side) ────────────────────────────────────────

/**
 * Resolves the base branch tip with `git ls-remote` on the host. The token reaches git only through this
 * process's environment and a credential helper that reads it, never argv or a URL.
 */
export async function resolveBaseHead(repo: RepoContext, deps: SnapshotDeps = {}): Promise<string> {
	const branch = repo.config.baseBranch;
	if (!SAFE_REF.test(branch)) throw new Error(`${repo.fullName}: unsupported base branch ${JSON.stringify(branch)}`);
	const token = await (deps.readToken ?? readToken)(repo);
	const url = `https://github.com/${repo.owner}/${repo.name}.git`;
	const helper = `credential.helper=!f() { test "$1" = get || return 0; printf 'username=${GITHUB_TOKEN_USER}\\npassword=%s\\n' "$FACTORY_GIT_TOKEN"; }; f`;
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", FACTORY_GIT_TOKEN: token };
	const out = await new Promise<string>((resolve, reject) => {
		execFile(
			"git",
			["-c", "credential.helper=", "-c", helper, "ls-remote", url, `refs/heads/${branch}`],
			{ env, timeout: 60_000, maxBuffer: 1024 * 1024 },
			(err, stdout, stderr) => (err ? reject(new Error(`git ls-remote ${repo.fullName}: ${stderr.trim() || err.message}`)) : resolve(stdout)),
		);
	});
	const sha = parseLsRemote(out, branch);
	if (!sha) throw new Error(`git ls-remote ${repo.fullName}: no branch ${branch}`);
	return sha;
}

function parseLsRemote(out: string, branch: string): string | null {
	for (const line of out.split("\n")) {
		const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim());
		if (m?.[2] === `refs/heads/${branch}`) return m[1] ?? null;
	}
	return null;
}
