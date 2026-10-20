import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ClientError, SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { SandboxSnapshot } from "@renderinc/sdk/experimental";
import { create as createTar } from "tar";
import type { RepoContext } from "../config/index.js";
import { githubToken } from "../github/auth.js";
import { bundleRunner } from "../runner/bundle.js";
import { type SandboxApi, type SandboxClient, TRANSIENT } from "./client.js";
import { errorMessage, log, SAFE_REF, shq } from "./shell.js";
import { APP_DIR, REPO_DIR, RUN_AS, SANDBOX_ROOT, SCRATCH_DIR, type SnapshotManifest } from "./types.js";
import { verifySandbox, wirePolicy } from "./verify.js";

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

const STAGE = "/tmp/factory-stage";
const STAGE_CREDS = `${STAGE}/creds`;
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
//   1. Upload the scripts and runner bundle; install tools; create the runner user; self-test the runner
//   2. Upload a read-only token, clone at `sha`, scrub the token and verify none remains
//   3. Hand REPO_DIR to the runner user and run the repository's install as that user (no secret present)
//   4. Manifest, lockdown, verify.sh, named snapshot, prune

/** Builds the repository's named snapshot at `sha` and prunes older ones, keeping the newest two. */
export async function buildSnapshot(
	client: SandboxClient,
	repo: RepoContext,
	sha: string,
	deps: SnapshotDeps = {},
): Promise<BuiltSnapshot> {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`refusing to build ${repo.fullName} at ${JSON.stringify(sha)}: not a commit SHA`);
	const branch = repo.config.baseBranch;
	if (!SAFE_REF.test(branch)) throw new Error(`${repo.fullName}: unsupported base branch ${JSON.stringify(branch)}`);
	const name = snapshotName(repo);
	const t = client.t;
	const prepare = { timeoutMs: t.prepareTimeoutMs };
	const boot = { timeoutMs: t.bootTimeoutMs };
	const started = Date.now();
	log("info", "snapshot build started", { repo: repo.fullName, sha, snapshot: name });

	const { id } = await client.call(() =>
		client.api.create({ timeoutSeconds: BUILDER_TIMEOUT_SECONDS, networkPolicy: wirePolicy("allow-all") }),
	);
	try {
		await client.waitRunning(id);

		// ── 1. Stage, tools, runner user, self-test ─────────────────────
		await client.check(id, `mkdir -p -m 700 ${STAGE}`, { ...boot, waitReady: true });
		// Uploaded as an opaque .tgz and extracted in the sandbox: the upload endpoint rejects an
		// uncompressed tar of the bundled runner's JavaScript, and doesn't accept application/gzip.
		const stage = await stageArchive();
		await client.upload(id, `${STAGE}/stage.tgz`, stage.archive);
		await client.check(id, `tar -xzf ${STAGE}/stage.tgz -C ${STAGE} && rm ${STAGE}/stage.tgz`, boot);
		await client.check(
			id,
			`mkdir -p ${APP_DIR}/runner ${APP_DIR}/build ${REPO_DIR} ${SCRATCH_DIR}` +
				` && cp ${STAGE}/*.sh ${APP_DIR}/ && cp ${STAGE}/build/*.sh ${APP_DIR}/build/` +
				` && cp ${STAGE}/runner/runner.mjs ${APP_DIR}/runner/`,
			boot,
		);
		await client.check(id, `bash ${APP_DIR}/install-tools.sh ${APP_DIR}`, prepare);
		const env = await detectEnv(client, id);
		await client.check(id, createRunnerUserCommand(), boot);
		await client.upload(id, `${APP_DIR}/env`, envFileContent(env.nodePath, env.dropTool));
		await client.upload(id, `${APP_DIR}/gitconfig`, SANDBOX_GITCONFIG);
		// The self-test executes third-party code (the bundled packages); the token arrives only after it passes.
		await client.check(
			id,
			[
				`chmod 755 ${SANDBOX_ROOT}`,
				`chmod -R a+rX,go-w ${APP_DIR}`,
				`chown ${RUN_AS}: ${SCRATCH_DIR}`,
				`chmod 700 ${SCRATCH_DIR}`,
				`timeout 120 ${asRunner(env.nodePath, `${APP_DIR}/runner/runner.mjs`, "--self-test")}`,
			].join(" && "),
			prepare,
		);

		// ── 2. Token, clone, scrub ───────────────────────────────────────
		const token = await (deps.readToken ?? readToken)(repo);
		await client.check(id, `mkdir -p -m 700 ${STAGE_CREDS}`, boot);
		await client.upload(id, `${STAGE_CREDS}/github.com`, credentialFile(token));
		await client.check(id, cloneCommand(repo, sha), prepare);
		const scrub = await client.exec(
			id,
			`bash ${APP_DIR}/build/scrub-credentials.sh ${STAGE_CREDS} ${REPO_DIR} ${SCRATCH_DIR}/home`,
			prepare,
		);
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
			runnerHash: stage.runnerHash,
			install,
			createdAt: new Date().toISOString(),
		};
		await client.upload(id, `${APP_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
		await client.check(id, lockdownCommand(env.nodePath), prepare);
		await verifySandbox(client, id);

		const snap = await createSnapshot(client, id, name);
		await pruneSnapshots(client, snap.sandboxGroupId, name, KEEP_SNAPSHOTS);
		log("info", "snapshot build finished", { repo: repo.fullName, sha, snapshot: name, id: snap.id, ms: Date.now() - started });
		return { id: snap.id, sandboxGroupId: snap.sandboxGroupId, name, manifest };
	} finally {
		await client.terminateQuietly(id);
	}
}

/** Detects the node binary path and the available privilege-drop tool inside the sandbox. */
async function detectEnv(client: SandboxClient, id: string): Promise<{ nodePath: string; dropTool: string }> {
	const res = await client.exec(
		id,
		[
			`node=$([ -x ${APP_DIR}/node/bin/node ] && echo ${APP_DIR}/node/bin/node || command -v node)`,
			`drop=none; for t in setpriv runuser su; do command -v "$t" >/dev/null 2>&1 && drop=$t && break; done`,
			'printf "%s\\n%s\\n" "$node" "$drop"',
		].join(" && "),
		{ timeoutMs: client.t.bootTimeoutMs },
	);
	if (res.exitCode !== 0) throw new Error(`environment detection failed: ${res.stderr.trim()}`);
	const [nodePath, dropTool] = res.stdout.trim().split("\n");
	if (!nodePath?.startsWith("/")) throw new Error("environment detection returned no node path");
	if (!dropTool || dropTool === "none") throw new Error("no privilege-drop tool (setpriv, runuser, or su) in the builder");
	return { nodePath, dropTool };
}

/** Creates the unprivileged runner user (useradd or adduser, depending on the distro). */
function createRunnerUserCommand(): string {
	return (
		`id -u ${RUN_AS} >/dev/null 2>&1` +
		` || { command -v useradd >/dev/null && useradd --system --user-group --no-create-home` +
		` --home-dir ${SCRATCH_DIR}/home --shell /usr/sbin/nologin ${RUN_AS}; }` +
		` || { addgroup -S ${RUN_AS} && adduser -S -D -H -h ${SCRATCH_DIR}/home -s /sbin/nologin -G ${RUN_AS} ${RUN_AS}; }`
	);
}

/** The env file that the sandbox scripts source. */
function envFileContent(nodePath: string, dropTool: string): string {
	const nodeDir = nodePath.substring(0, nodePath.lastIndexOf("/"));
	return `${[
		`FACTORY_ROOT=${SANDBOX_ROOT}`,
		`FACTORY_APP_DIR=${APP_DIR}`,
		`FACTORY_REPO_DIR=${REPO_DIR}`,
		`FACTORY_SCRATCH_DIR=${SCRATCH_DIR}`,
		`FACTORY_RUN_AS=${RUN_AS}`,
		`FACTORY_DROP=${dropTool}`,
		`FACTORY_NODE=${nodePath}`,
		`FACTORY_RUNNER_NODE=${APP_DIR}/node-runner`,
		`FACTORY_PATH=${APP_DIR}/bin:${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
	].join("\n")}\n`;
}

/** Clones the base branch into REPO_DIR and checks out `sha` on a local branch named after it. */
function cloneCommand(repo: RepoContext, sha: string): string {
	const url = `https://github.com/${repo.owner}/${repo.name}.git`;
	const branch = repo.config.baseBranch;
	const auth = credentialHelperArgs(STAGE_CREDS).map(shq).join(" ");
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
		`rm -rf ${STAGE}`,
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

/** A gzipped tar of the runtime scripts and a freshly built, self-contained runner bundle. */
async function stageArchive(): Promise<{ archive: Buffer; runnerHash: string }> {
	const bundle = await bundleRunner();
	const runnerHash = createHash("sha256").update(bundle).digest("hex");
	const dir = await mkdtemp(join(tmpdir(), "factory-stage-"));
	try {
		await mkdir(join(dir, "runner"));
		await mkdir(join(dir, "build"));
		await writeFile(join(dir, "runner/runner.mjs"), bundle);
		for (const file of RUNTIME_SCRIPTS) await cp(join(SANDBOX_SCRIPTS_DIR, file), join(dir, file));
		const chunks: Buffer[] = [];
		for await (const chunk of createTar({ cwd: dir, portable: true, gzip: true }, await readdir(dir))) chunks.push(chunk as Buffer);
		return { archive: Buffer.concat(chunks), runnerHash };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ── Prune ───────────────────────────────────────────────────────────────

/** Deletes older available/failed snapshots with this name, keeping the newest `keep`. Logs instead of throwing. */
export async function pruneSnapshots(client: SandboxClient, sandboxGroupId: string, name: string, keep: number): Promise<void> {
	try {
		const list: Awaited<ReturnType<SandboxApi["snapshots"]["list"]>> = [];
		for (let cursor: string | undefined; ; ) {
			const page = await client.call(() =>
				client.api.snapshots.list({ sandboxGroupId, status: ["available", "failed"], cursor, limit: 100 }),
			);
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

export function parseLsRemote(out: string, branch: string): string | null {
	for (const line of out.split("\n")) {
		const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim());
		if (m?.[2] === `refs/heads/${branch}`) return m[1] ?? null;
	}
	return null;
}
