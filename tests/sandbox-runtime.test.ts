import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUNTIME = fileURLToPath(new URL("../sandbox-runtime/", import.meta.url));
const TOKEN = "ghs_scrubTestToken000000000000000000000";

/**
 * Stand-in for the bundled runner.mjs that follows its CLI contract. input.mode "fail" exits 3; "no-read" exits 0
 * after one read of stdin. input.keyFile is checked for existence; input.probe receives the runner's argv and env.
 */
const FAKE_RUNNER = `
import { existsSync, readFileSync, readSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--self-test")) {
	console.log(JSON.stringify({ ok: true, version: "fake" }));
	process.exit(0);
}
const head = Buffer.alloc(65536);
const first = head.subarray(0, readSync(0, head, 0, head.length, null)).toString("utf8");
if (first.includes('"mode":"no-read"')) process.exit(0);
const text = first + readFileSync(0, "utf8");
let key = null;
let rest = text;
if (args.includes("--key-stdin")) {
	const newline = text.indexOf("\\n");
	key = text.slice(0, newline);
	rest = text.slice(newline + 1);
}
const input = JSON.parse(rest);
const keyFileExists = input.keyFile ? existsSync(input.keyFile) : null;
if (input.probe) writeFileSync(input.probe, JSON.stringify({ argv: process.argv, env: process.env }));
const report = { input, key, keyFileExists, args, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() };
console.log(JSON.stringify({ type: "started" }));
console.log(JSON.stringify({ type: "report", report }));
process.stderr.write("fake runner diagnostics\\n");
process.exit(input.mode === "fail" ? 3 : 0);
`;

let tmp: string;
let env: NodeJS.ProcessEnv;
let root: string;
let app: string;
let repo: string;
let scratch: string;
let commit: string;

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const child = execFile(cmd, args, { cwd: opts.cwd, env: { ...env, ...opts.env } }, (err, stdout, stderr) => {
			resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
		});
		child.stdin?.end(opts.input ?? "");
	});
}

async function git(args: string[], cwd?: string): Promise<string> {
	const ident = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
	const res = await run("git", [...ident, ...args], { cwd });
	if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
	return res.stdout.trim();
}

const bash = (script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) => run("bash", [script, ...args], { env: extra });

beforeAll(async () => {
	tmp = await realpath(await mkdtemp(join(tmpdir(), "factory-scripts-")));
	const shim = join(tmp, "shim");
	await mkdir(join(tmp, "home"), { recursive: true });
	await mkdir(shim);
	// coreutils timeout is missing on macOS: drop its options and duration, run the command.
	const timeoutShim = ["#!/bin/sh", 'while [ "$' + '{1#-}" != "$1" ]; do shift; done', "shift", 'exec "$@"', ""].join("\n");
	await writeFile(join(shim, "timeout"), timeoutShim, { mode: 0o755 });
	await writeFile(join(shim, "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	env = {
		PATH: `${shim}:${dirname(process.execPath)}:${process.env.PATH}`,
		HOME: join(tmp, "home"),
		GIT_CONFIG_GLOBAL: join(tmp, "home/.gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		DATABASE_URL: "postgres://must-not-leak",
	};

	const work = join(tmp, "work");
	await mkdir(work);
	await git(["init", "-q", "-b", "main"], work);
	await writeFile(join(work, "README.md"), "# widget\n");
	await writeFile(join(work, "package-lock.json"), '{"lockfileVersion":3}\n');
	await git(["add", "-A"], work);
	await git(["commit", "-q", "-m", "init"], work);
	commit = await git(["rev-parse", "HEAD"], work);
	await git(["clone", "-q", "--bare", work, join(tmp, "remote.git")]);

	root = join(tmp, "factory");
	app = join(root, "app");
	repo = join(root, "repo");
	scratch = join(root, "scratch");
	await mkdir(join(app, "runner"), { recursive: true });
	await mkdir(scratch, { recursive: true });
	await cp(RUNTIME, app, { recursive: true });
	await writeFile(join(app, "runner/runner.mjs"), FAKE_RUNNER);
	await writeFile(join(app, "gitconfig"), "[core]\n\tfsmonitor = false\n");
	const lines = {
		FACTORY_ROOT: root,
		FACTORY_APP_DIR: app,
		FACTORY_REPO_DIR: repo,
		FACTORY_SCRATCH_DIR: scratch,
		FACTORY_RUN_AS: userInfo().username,
		FACTORY_DROP: "none",
		FACTORY_NODE: process.execPath,
		FACTORY_RUNNER_NODE: process.execPath,
		FACTORY_PATH: `${shim}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
	};
	await writeFile(join(app, "env"), Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""));
	await git(["clone", "-q", "--single-branch", "--branch", "main", join(tmp, "remote.git"), repo]);
	await git(["-C", repo, "checkout", "-q", "-B", "main", commit]);
	await writeFile(
		join(app, "manifest.json"),
		JSON.stringify({ repo: "acme/widget", baseBranch: "main", sha: commit, lockfileHash: "", install: null, createdAt: "" }),
	);
});

afterAll(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("verify.sh", { timeout: 30_000 }, () => {
	it("passes on a well-formed layout and describes the sandbox (non-root: no dumpability probe)", async () => {
		const res = await bash(join(app, "verify.sh"));
		expect(res.stderr).toBe("");
		expect(res.code).toBe(0);
		expect(JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
			runAs: userInfo().username,
			drop: "none",
			runnerNonDumpable: false,
			selfTest: { ok: true },
		});
		// The write probes are cleaned up.
		expect(await git(["-C", repo, "status", "--porcelain"])).toBe("");
	});

	it("fails when a tracked file is modified", async () => {
		await writeFile(join(repo, "README.md"), "changed\n");
		try {
			const res = await bash(join(app, "verify.sh"));
			expect(res.code).toBe(1);
			expect(res.stderr).toContain("tracked files modified");
		} finally {
			await git(["-C", repo, "checkout", "--", "README.md"]);
		}
	});

	it("fails when HEAD is not the manifest's commit", async () => {
		await writeFile(join(repo, "new.txt"), "x\n");
		await git(["-C", repo, "add", "new.txt"]);
		await git(["-C", repo, "commit", "-q", "-m", "drift"]);
		try {
			const res = await bash(join(app, "verify.sh"));
			expect(res.code).toBe(1);
			expect(res.stderr).toContain(`!= manifest ${commit}`);
		} finally {
			await git(["-C", repo, "reset", "-q", "--hard", commit]);
		}
	});

	it("fails when the remote URL carries credentials", async () => {
		const url = await git(["-C", repo, "config", "remote.origin.url"]);
		await git(["-C", repo, "config", "remote.origin.url", `https://x-access-token:${TOKEN}@github.com/acme/widget.git`]);
		try {
			const res = await bash(join(app, "verify.sh"));
			expect(res.code).toBe(1);
			expect(res.stderr).toContain("remote URL carries credentials");
			expect(res.stderr).not.toContain(TOKEN);
		} finally {
			await git(["-C", repo, "config", "remote.origin.url", url]);
		}
	});
});

describe("run-agent.sh", { timeout: 30_000 }, () => {
	async function runDir(name: string, input: object, key?: string): Promise<string> {
		const dir = join(tmp, "runs", name);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "input.json"), JSON.stringify({ ...input, keyFile: join(dir, "key"), probe: `${dir}.probe` }));
		if (key) await writeFile(join(dir, "key"), key);
		return dir;
	}

	const reportOf = (jsonl: string) => {
		const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
		return lines.find((l) => l.type === "report").report;
	};

	it("deletes the key file before the runner starts and feeds the key as the first line of stdin with --key-stdin", async () => {
		const key = "sk-ant-script-key";
		const dir = await runDir("run-ok", { mode: "ok", task: "hello" }, `${key}\n`);
		const res = await bash(join(app, "run-agent.sh"), [dir, "30"]);
		expect(res.code).toBe(0);
		expect(res.stdout).toBe("");
		expect(res.stderr).toContain("fake runner diagnostics");
		expect(await readFile(`${dir}.exit`, "utf8")).toBe("0\n");
		const report = reportOf(await readFile(`${dir}.jsonl`, "utf8"));
		expect(report).toMatchObject({ input: { task: "hello" }, key, keyFileExists: false, args: ["--key-stdin"], cwd: repo });
		expect(report.envKeys).not.toContain("DATABASE_URL");
		expect(report.envKeys).toEqual(expect.arrayContaining(["HOME", "PATH", "TMPDIR", "GIT_CONFIG_GLOBAL"]));
		const probe = await readFile(`${dir}.probe`, "utf8");
		expect(JSON.parse(probe).argv).toContain("--key-stdin");
		expect(probe).not.toContain("--key-file");
		expect(probe).not.toContain(key);
		expect(existsSync(join(dir, "key"))).toBe(false);
	});

	it("records the runner's exit status when it fails, and when it exits without reading stdin", async () => {
		const dir = await runDir("run-fail", { mode: "fail" }, "sk-ant-fail");
		const res = await bash(join(app, "run-agent.sh"), [dir, "30"]);
		expect(res.code).toBe(3);
		expect(await readFile(`${dir}.exit`, "utf8")).toBe("3\n");
		expect(existsSync(join(dir, "key"))).toBe(false);

		// Larger than a pipe buffer, so the writer gets SIGPIPE; the runner's status still wins.
		const early = await runDir("run-no-read", { mode: "no-read", padding: "x".repeat(1 << 20) }, "sk-ant-early");
		const res2 = await bash(join(app, "run-agent.sh"), [early, "30"]);
		expect(res2.code).toBe(0);
		expect(await readFile(`${early}.exit`, "utf8")).toBe("0\n");
		expect(existsSync(join(early, "key"))).toBe(false);
	});

	it("refuses a key file with more than one line, without starting the runner", async () => {
		const dir = await runDir("run-multiline", { mode: "ok" }, "sk-ant-line1\nsk-ant-line2");
		const res = await bash(join(app, "run-agent.sh"), [dir, "30"]);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("more than one line");
		expect(res.stderr).not.toContain("sk-ant-line");
		expect(existsSync(join(dir, "key"))).toBe(false);
		expect(existsSync(`${dir}.probe`)).toBe(false);
	});

	it("passes no key flag and the input as-is when there is no key", async () => {
		const dir = await runDir("run-nokey", { mode: "ok" });
		const res = await bash(join(app, "run-agent.sh"), [`${dir}/`, "30"]);
		expect(res.code).toBe(0);
		expect(await readFile(`${dir}.exit`, "utf8")).toBe("0\n");
		expect(reportOf(await readFile(`${dir}.jsonl`, "utf8"))).toMatchObject({ input: { mode: "ok" }, key: null, keyFileExists: false, args: [] });
	});
});

describe("lockfile-hash.sh", { timeout: 30_000 }, () => {
	const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

	it("hashes the root lockfiles in sorted order, and nothing to the hash of the empty string", async () => {
		const dir = await mkdtemp(join(tmp, "lock-"));
		const empty = await bash(join(app, "lockfile-hash.sh"), [dir]);
		expect(empty.code).toBe(0);
		expect(empty.stdout.trim()).toBe(sha(""));

		await writeFile(join(dir, "package-lock.json"), "npm\n");
		await writeFile(join(dir, "go.sum"), "go\n");
		await writeFile(join(dir, "requirements-dev.txt"), "pytest\n");
		await writeFile(join(dir, "README.md"), "not a lockfile\n");
		await mkdir(join(dir, "sub"));
		await writeFile(join(dir, "sub/yarn.lock"), "nested, ignored\n");
		const files = ["go.sum", "package-lock.json", "requirements-dev.txt"];
		const contents: Record<string, string> = { "go.sum": "go\n", "package-lock.json": "npm\n", "requirements-dev.txt": "pytest\n" };
		const expected = sha(files.map((f) => `${sha(contents[f] ?? "")}  ${f}\n`).join(""));
		const res = await bash(join(app, "lockfile-hash.sh"), [dir]);
		expect(res.stderr).toBe("");
		expect(res.stdout.trim()).toBe(expected);

		await writeFile(join(dir, "package-lock.json"), "npm changed\n");
		expect((await bash(join(app, "lockfile-hash.sh"), [dir])).stdout.trim()).not.toBe(expected);
	});
});

describe("credential scripts", { timeout: 30_000 }, () => {
	const helper = () => join(app, "build/git-credential-staged.sh");
	const scrub = () => join(app, "build/scrub-credentials.sh");

	async function stageCreds(): Promise<string> {
		const dir = await mkdtemp(join(tmp, "creds-"));
		await writeFile(join(dir, "github.com"), `x-access-token\n${TOKEN}`);
		return dir;
	}

	it("git-credential-staged.sh answers get for a staged host only", async () => {
		const creds = await stageCreds();
		const ask = async (action: string, request: string) => (await run("bash", [helper(), creds, action], { input: request })).stdout;
		expect(await ask("get", "protocol=https\nhost=github.com\n\n")).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
		expect(await ask("get", "protocol=https\nhost=gitlab.com\n\n")).toBe("");
		expect(await ask("get", "protocol=https\nhost=../github.com\n\n")).toBe("");
		expect(await ask("store", "protocol=https\nhost=github.com\n\n")).toBe("");
	});

	it("scrub-credentials.sh deletes staged credentials when no token leaked", async () => {
		const creds = await stageCreds();
		const res = await bash(scrub(), [creds, repo, join(scratch, "home")]);
		expect(res.stderr).toBe("");
		expect(res.code).toBe(0);
		expect(existsSync(creds)).toBe(false);
	});

	it("scrub-credentials.sh fails without echoing the token when it reached .git", async () => {
		const creds = await stageCreds();
		await git(["-C", repo, "config", "remote.origin.pushurl", `https://x:${TOKEN}@github.com/acme/widget.git`]);
		try {
			const res = await bash(scrub(), [creds, repo]);
			expect(res.code).toBe(1);
			expect(res.stderr).toContain("token for github.com found in");
			expect(res.stderr).not.toContain(TOKEN);
			expect(existsSync(creds)).toBe(true);
		} finally {
			await git(["-C", repo, "config", "--unset", "remote.origin.pushurl"]);
		}
	});

	it("scrub-credentials.sh fails when an extra home holds a credential store", async () => {
		const creds = await stageCreds();
		const home = await mkdtemp(join(tmp, "home-"));
		await writeFile(join(home, ".git-credentials"), `https://x-access-token:${TOKEN}@github.com\n`);
		const res = await bash(scrub(), [creds, repo, home]);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain(".git-credentials");
		expect(res.stderr).not.toContain(TOKEN);
	});

	it("fetches through the staged helper as the runner, then scrubs (the open flow, against a local remote)", async () => {
		const creds = await stageCreds();
		const work = join(tmp, "work");
		await writeFile(join(work, "feature.txt"), "feature\n");
		await git(["-C", work, "checkout", "-q", "-b", "feature"]);
		await git(["-C", work, "add", "-A"]);
		await git(["-C", work, "commit", "-q", "-m", "feature"]);
		const featureSha = await git(["-C", work, "rev-parse", "HEAD"]);
		await git(["-C", work, "push", "-q", join(tmp, "remote.git"), "feature"]);

		const asRunner = (...args: string[]) => bash(join(app, "as-runner.sh"), args);
		const helperArg = `credential.helper=!bash ${helper()} ${creds}`;
		const fetched = await asRunner("git", "-c", "credential.helper=", "-c", helperArg, "fetch", "--quiet", "--no-tags", "origin", "refs/heads/feature");
		expect(fetched.stderr).toBe("");
		expect(fetched.code).toBe(0);
		expect((await bash(scrub(), [creds, repo, join(scratch, "home")])).code).toBe(0);
		expect((await asRunner("git", "rev-parse", "FETCH_HEAD^{commit}")).stdout.trim()).toBe(featureSha);
		expect((await asRunner("git", "checkout", "--quiet", "--detach", featureSha)).code).toBe(0);
		expect(await git(["-C", repo, "rev-parse", "HEAD"])).toBe(featureSha);
		await git(["-C", repo, "checkout", "-q", "main"]);
	});
});
