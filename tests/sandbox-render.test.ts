import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { SandboxExecEvent } from "@renderinc/sdk/experimental";
import { list as listTar } from "tar";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config, type RepoContext } from "../app/config/index.js";
import { buildSnapshot, type OpenSandboxDeps, openSandbox, type SandboxApi, SandboxClient, type SnapshotManifest } from "../app/sandbox/index.js";

vi.mock("../app/runner/bundle.js", () => ({ bundleRunner: async () => "// fake runner bundle\n" }));

const TOKEN = "ghs_factoryReadToken0000000000000000000";
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const HASH = "a".repeat(64);
const NAME = "factory-acme-web";

const repo = (overrides: Partial<RepoContext["config"]> = {}): RepoContext => ({
	owner: "acme",
	name: "web",
	fullName: "acme/web",
	installationId: 7,
	config: { baseBranch: "main", install: "npm ci", verify: ["npm test"], ...overrides },
});

type Call =
	| { op: "create"; id: string; input: Parameters<SandboxApi["create"]>[0] }
	| { op: "exec"; id: string; command: string }
	| { op: "upload"; id: string; path: string; data: unknown; contentType?: string }
	| { op: "download" | "terminate"; id: string; path?: string }
	| { op: "snapshot.create" | "snapshot.get" | "snapshot.list" | "snapshot.delete"; input: unknown };

type ExecHandler = (id: string, command: string) => SandboxExecEvent[];

const out = (data: string, stream: "stdout" | "stderr" = "stdout"): SandboxExecEvent => ({ type: "output", stream, data });
const exit = (code = 0): SandboxExecEvent => ({ type: "exit", exit_code: code });
const info = (overrides: object = {}) =>
	`${JSON.stringify({ runAs: "factory", uid: 0, node: "v24.14.1", runnerNonDumpable: true, selfTest: { ok: true }, ...overrides })}\n`;

function snapshot(id: string, status: "creating" | "available" | "failed", name: string | null, requestedAt = new Date().toISOString()) {
	return {
		id,
		sandboxGroupId: "sbg-1",
		sourceSandboxId: "sbx-1",
		name,
		kind: "filesystem" as const,
		status,
		plan: "starter" as const,
		requestedAt,
		expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
	};
}

/** In-memory stand-in for the SDK's SandboxesClient that records every call. */
class FakeApi {
	calls: Call[] = [];
	createError?: (input: Parameters<SandboxApi["create"]>[0]) => Error | undefined;
	lockfileHash = HASH;
	fetchedSha = HEAD_SHA;
	dirtyAfterInstall = "";
	overrides: ExecHandler = () => [];
	manifest: SnapshotManifest = {
		repo: "acme/web",
		baseBranch: "main",
		sha: BASE_SHA,
		lockfileHash: HASH,
		install: "npm ci",
		createdAt: new Date().toISOString(),
	};
	snapshots = [
		{ snapshot: snapshot("snp-new", "available", NAME), cursor: "a" },
		{ snapshot: snapshot("snp-other", "available", "factory-acme-api"), cursor: "b" },
	];
	#n = 0;

	exec(id: string, command: string): SandboxExecEvent[] {
		const override = this.overrides(id, command);
		if (override.length) return override;
		if (command.includes("verify.sh")) return [out("noise\n", "stderr"), out(info()), exit(0)];
		if (command === "command -v node") return [out("/usr/bin/node\n"), exit(0)];
		if (command.includes("lockfile-hash.sh")) return [out(`${this.lockfileHash}\n`), exit(0)];
		if (command.includes("'status' '--porcelain'")) return [out(this.dirtyAfterInstall), exit(0)];
		if (command.includes("FETCH_HEAD")) return [out(`${this.fetchedSha}\n`), exit(0)];
		return [out("progress\n", "stderr"), exit(0)];
	}

	api(): SandboxApi {
		const self = this;
		return {
			async create(input: Parameters<SandboxApi["create"]>[0] = {}) {
				const err = self.createError?.(input);
				if (err) throw err;
				const id = `sbx-${++self.#n}`;
				self.calls.push({ op: "create", id, input });
				return { id, status: "creating", networkPolicy: input.networkPolicy, timeoutSeconds: input.timeoutSeconds };
			},
			async get(id: string) {
				return { id, status: "running" };
			},
			async exec(id: string, command: string) {
				self.calls.push({ op: "exec", id, command });
				const events = self.exec(id, command);
				return (async function* () {
					yield* events;
				})();
			},
			async upload(id: string, path: string, data: unknown, _ownerId?: string, opts?: { contentType?: string }) {
				self.calls.push({ op: "upload", id, path, data, contentType: opts?.contentType });
			},
			async download(id: string, path: string) {
				self.calls.push({ op: "download", id, path });
				if (!path.endsWith("/manifest.json")) throw new Error(`no such file: ${path}`);
				const data = Buffer.from(JSON.stringify(self.manifest));
				return { data, size: data.length };
			},
			async terminate(id: string) {
				self.calls.push({ op: "terminate", id });
			},
			snapshots: {
				async create(input: { name?: string }) {
					self.calls.push({ op: "snapshot.create", input });
					return snapshot("snp-new", "creating", input.name ?? null);
				},
				async get(input: { snapshotId: string }) {
					self.calls.push({ op: "snapshot.get", input });
					return snapshot(input.snapshotId, "available", NAME);
				},
				async list(input: unknown) {
					self.calls.push({ op: "snapshot.list", input });
					return self.snapshots;
				},
				async delete(input: unknown) {
					self.calls.push({ op: "snapshot.delete", input });
				},
			},
		} as unknown as SandboxApi;
	}

	commands(): string[] {
		return this.calls.flatMap((c) => (c.op === "exec" ? [c.command] : []));
	}

	inputs(op: Call["op"]): unknown[] {
		return this.calls.flatMap((c) => (c.op === op && "input" in c ? [c.input] : []));
	}

	/** Index of the first call matching `pred`; -1 when none. */
	index(pred: (c: Call) => boolean): number {
		return this.calls.findIndex(pred);
	}

	execIndex(fragment: string): number {
		return this.index((c) => c.op === "exec" && c.command.includes(fragment));
	}

	terminated(): string[] {
		return this.calls.flatMap((c) => (c.op === "terminate" ? [c.id] : []));
	}
}

let fake: FakeApi;
const client = () => new SandboxClient(fake.api(), { minRequestIntervalMs: 0, pollMs: 1, bootTimeoutMs: 1_000 });
const readToken = async () => TOKEN;

beforeEach(() => {
	fake = new FakeApi();
});

describe("buildSnapshot", () => {
	it("orders the build by trust and snapshots under the repository's name", async () => {
		const built = await buildSnapshot(client(), repo(), BASE_SHA, { readToken });
		expect(built).toMatchObject({ id: "snp-new", sandboxGroupId: "sbg-1", name: NAME });

		const creates = fake.calls.filter((c) => c.op === "create");
		expect(creates).toHaveLength(1);
		expect(creates[0]?.input).toEqual({ timeoutSeconds: 3_600, networkPolicy: { type: "allow-all" } });

		const tokenUpload = fake.index((c) => c.op === "upload" && c.path === "/tmp/factory-stage/creds/github.com");
		const order = [
			fake.execIndex("install-tools.sh"),
			fake.execIndex("--self-test"),
			tokenUpload,
			fake.execIndex(" clone "),
			fake.execIndex("scrub-credentials.sh"),
			fake.execIndex("chown -R factory: /opt/factory/repo"),
			fake.execIndex("lockfile-hash.sh"),
			fake.execIndex("'bash' '-c' 'npm ci'"),
			fake.execIndex("'status' '--porcelain'"),
			fake.index((c) => c.op === "upload" && c.path === "/opt/factory/app/manifest.json"),
			fake.execIndex("node-runner"),
			fake.execIndex("verify.sh"),
			fake.index((c) => c.op === "snapshot.create"),
			fake.index((c) => c.op === "snapshot.list"),
			fake.index((c) => c.op === "terminate"),
		];
		for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
		expect(order).toEqual([...order].sort((a, b) => a - b));

		// The token is uploaded as a file and never appears in a command.
		expect(fake.commands().some((c) => c.includes(TOKEN))).toBe(false);
		const credUpload = fake.calls[tokenUpload] as { data: string };
		expect(credUpload.data).toBe(`x-access-token\n${TOKEN}`);

		// Clone the base branch single-branch, then the pushed commit on a local branch of that name.
		const clone = fake.commands().find((c) => c.includes(" clone "));
		expect(clone).toContain("clone --quiet --single-branch --branch 'main' --no-tags -- 'https://github.com/acme/web.git' /opt/factory/repo");
		expect(clone).toContain(`checkout --quiet -B 'main' ${BASE_SHA}`);
		expect(clone).toContain("'credential.helper=!bash /opt/factory/app/build/git-credential-staged.sh /tmp/factory-stage/creds'");

		// The install runs as the runner user, through as-runner.sh.
		expect(fake.commands()).toContain("bash /opt/factory/app/as-runner.sh 'bash' '-c' 'npm ci'");

		expect(fake.inputs("snapshot.create")).toEqual([{ sandboxId: "sbx-1", kind: "filesystem", name: NAME }]);
		expect(fake.terminated()).toEqual(["sbx-1"]);

		const manifestUpload = fake.calls.find((c) => c.op === "upload" && c.path === "/opt/factory/app/manifest.json") as {
			data: string;
		};
		expect(JSON.parse(manifestUpload.data)).toMatchObject({
			repo: "acme/web",
			baseBranch: "main",
			sha: BASE_SHA,
			lockfileHash: HASH,
			install: "npm ci",
		});
		expect(built.manifest.sha).toBe(BASE_SHA);

		// Stage archive: scripts plus the runner bundle, uploaded as an opaque .tgz.
		const stage = fake.calls.find((c) => c.op === "upload" && c.path === "/tmp/factory-stage/stage.tgz") as {
			data: Buffer;
			contentType?: string;
		};
		expect(stage.contentType).toBeUndefined();
		const files = new Map<string, string>();
		await pipeline(
			Readable.from(stage.data),
			listTar({
				onReadEntry: (e) => {
					const chunks: Buffer[] = [];
					e.on("data", (c: Buffer) => chunks.push(c));
					e.on("end", () => files.set(e.path, Buffer.concat(chunks).toString("utf8")));
				},
			}),
		);
		expect([...files.keys()].filter((p) => !p.endsWith("/")).sort()).toEqual([
			"as-runner.sh",
			"build/git-credential-staged.sh",
			"build/scrub-credentials.sh",
			"collect-changes.sh",
			"install-tools.sh",
			"lockfile-hash.sh",
			"run-agent.sh",
			"runner/runner.mjs",
			"verify.sh",
		]);
		expect(files.get("runner/runner.mjs")).toBe("// fake runner bundle\n");

		const env = fake.calls.find((c) => c.op === "upload" && c.path === "/opt/factory/app/env") as { data: string };
		expect(env.data).toContain("FACTORY_RUN_AS=factory\n");
		expect(env.data).toContain("FACTORY_REPO_DIR=/opt/factory/repo\n");
		expect(env.data).toContain("FACTORY_RUNNER_NODE=/opt/factory/app/node-runner\n");
		expect(env.data).toContain("FACTORY_NODE=/usr/bin/node\n");
	});

	it("never installs when the scrub fails", async () => {
		fake.overrides = (_id, command) =>
			command.includes("scrub-credentials.sh") ? [out("scrub-credentials: token for github.com found in x\n", "stderr"), exit(1)] : [];
		await expect(buildSnapshot(client(), repo(), BASE_SHA, { readToken })).rejects.toThrow("credential scrub failed");
		expect(fake.execIndex("npm ci")).toBe(-1);
		expect(fake.inputs("snapshot.create")).toEqual([]);
		expect(fake.calls.at(-1)).toEqual({ op: "terminate", id: "sbx-1" });
	});
});

describe("openSandbox", () => {
	const deps = (extra: Partial<OpenSandboxDeps> = {}): OpenSandboxDeps => ({ client: client(), readToken, ...extra });

	it("restores by snapshot name, verifies, and fetches a branch as the runner user", async () => {
		const sbx = await openSandbox(repo(), { kind: "branch", name: "main" }, deps());
		expect(sbx).toMatchObject({ id: "sbx-1", headSha: HEAD_SHA, manifest: fake.manifest });

		const creates = fake.calls.filter((c) => c.op === "create");
		expect(creates.map((c) => c.input)).toEqual([
			{ snapshotName: NAME, networkPolicy: { type: "allow-all" }, timeoutSeconds: config.sandbox.timeoutSeconds },
		]);
		expect(fake.commands().filter((c) => c.includes("verify.sh"))).toEqual(["bash /opt/factory/app/verify.sh"]);

		const credUpload = fake.calls.find((c) => c.op === "upload" && /^\/tmp\/factory-fetch-[0-9a-f-]{36}\/github\.com$/.test(c.path)) as {
			path: string;
			data: string;
		};
		expect(credUpload.data).toBe(`x-access-token\n${TOKEN}`);
		const dir = credUpload.path.replace(/\/github\.com$/, "");
		const commands = fake.commands();
		expect(commands.some((c) => c.includes(TOKEN))).toBe(false);
		expect(commands).toContain(`chown -R factory: ${dir} && chmod 600 ${dir}/github.com`);
		const fetchIdx = fake.execIndex("'fetch'");
		const fetchCmd = commands.find((c) => c.includes("'fetch'"));
		expect(fetchCmd).toBe(
			"bash /opt/factory/app/as-runner.sh 'git' '-c' 'credential.helper=' " +
				`'-c' 'credential.helper=!bash /opt/factory/app/build/git-credential-staged.sh ${dir}' ` +
				"'fetch' '--quiet' '--no-tags' 'origin' 'refs/heads/main'",
		);
		const scrubIdx = fake.execIndex(`scrub-credentials.sh ${dir} /opt/factory/repo`);
		expect(scrubIdx).toBeGreaterThan(fetchIdx);
		expect(fake.execIndex(`'checkout' '--quiet' '--detach' '${HEAD_SHA}'`)).toBeGreaterThan(scrubIdx);
		// Lockfiles unchanged: no reinstall.
		expect(fake.execIndex("'bash' '-c' 'npm ci'")).toBe(-1);
		expect(fake.calls.some((c) => c.op === "terminate")).toBe(false);
	});

	it("builds the snapshot inline exactly once when it is missing, then retries", async () => {
		let missing = true;
		fake.createError = (input) => (input?.snapshotName && missing ? new SandboxSnapshotNotFoundError("not found", 404) : undefined);
		const resolveBaseHead = vi.fn(async () => BASE_SHA);
		const build = vi.fn(async () => {
			missing = false;
			return { id: "snp-new", sandboxGroupId: "sbg-1", name: NAME, manifest: fake.manifest };
		});
		const sbx = await openSandbox(repo(), { kind: "branch", name: "main" }, deps({ resolveBaseHead, buildSnapshot: build }));
		expect(sbx.headSha).toBe(HEAD_SHA);
		expect(resolveBaseHead).toHaveBeenCalledTimes(1);
		expect(build).toHaveBeenCalledTimes(1);
		expect(build.mock.calls[0]?.slice(1, 3)).toEqual([repo(), BASE_SHA]);
	});

	it("fetches a pull ref and fails when the head moved, terminating the sandbox", async () => {
		fake.fetchedSha = "3".repeat(40);
		await expect(openSandbox(repo(), { kind: "pull", number: 12, headSha: HEAD_SHA }, deps())).rejects.toThrow(/head moved/);
		expect(fake.commands().some((c) => c.includes("'refs/pull/12/head'"))).toBe(true);
		expect(fake.execIndex("'checkout'")).toBe(-1);
		expect(fake.terminated()).toEqual(["sbx-1"]);
	});

	it("reinstalls as the runner user only when the lockfile hash changed", async () => {
		fake.lockfileHash = "b".repeat(64);
		await openSandbox(repo(), { kind: "branch", name: "main" }, deps());
		expect(fake.commands()).toContain("bash /opt/factory/app/as-runner.sh 'bash' '-c' 'npm ci'");
		expect(fake.execIndex("'bash' '-c' 'npm ci'")).toBeGreaterThan(fake.execIndex("'checkout'"));
	});

	it("scrubs the token even when the fetch fails", async () => {
		fake.overrides = (_id, command) => (command.includes("'fetch'") ? [out("fatal: couldn't find remote ref\n", "stderr"), exit(128)] : []);
		await expect(openSandbox(repo(), { kind: "branch", name: "gone" }, deps())).rejects.toThrow("couldn't find remote ref");
		expect(fake.execIndex("scrub-credentials.sh")).toBeGreaterThan(fake.execIndex("'fetch'"));
		expect(fake.calls.at(-1)).toEqual({ op: "terminate", id: "sbx-1" });
	});

	it("refuses a sandbox where the runner could not be confirmed non-dumpable", async () => {
		fake.overrides = (_id, command) => (command.includes("verify.sh") ? [out(info({ runnerNonDumpable: false })), exit(0)] : []);
		await expect(openSandbox(repo(), { kind: "branch", name: "main" }, deps())).rejects.toThrow("non-dumpable");
		expect(fake.calls.at(-1)).toEqual({ op: "terminate", id: "sbx-1" });
	});
});
