import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import type { SandboxExecEvent } from "@renderinc/sdk/experimental";
import { list as listTar } from "tar";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoContext } from "../app/config/index.js";
import { buildSnapshot, type OpenSandboxDeps, openSandbox, type SandboxApi, SandboxClient, type SnapshotManifest } from "../app/sandbox/index.js";
import { runnerPayload } from "../app/sandbox/snapshot.js";

async function untar(data: Buffer): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	await pipeline(
		Readable.from(data),
		listTar({
			onReadEntry: (e) => {
				const chunks: Buffer[] = [];
				e.on("data", (c: Buffer) => chunks.push(c));
				e.on("end", () => files.set(e.path.replace(/^\.\//, ""), Buffer.concat(chunks).toString("utf8")));
			},
		}),
	);
	return files;
}

const FAKE_BUNDLE = "// fake runner bundle\n";
vi.mock("../app/runner-bundle/bundle.js", () => ({ bundleRunner: async () => "// fake runner bundle\n" }));

const TOKEN = "ghs_factoryReadToken0000000000000000000";
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const HASH = "a".repeat(64);
const NAME = "factory-acme-web";

const allowList = (...domains: string[]) => ({ type: "allow-list", rules: domains.map((domain) => ({ domain })) });

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
	| { op: "upload"; id: string; path: string; data: unknown }
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

class FakeApi {
	calls: Call[] = [];
	createError?: (input: Parameters<SandboxApi["create"]>[0]) => Error | undefined;
	lockfileHash = HASH;
	fetchedSha = HEAD_SHA;
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
			async upload(id: string, path: string, data: unknown) {
				self.calls.push({ op: "upload", id, path, data });
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
const client = () => new SandboxClient(fake.api(), { pollMs: 1, bootTimeoutMs: 1_000 });
const readToken = async () => TOKEN;

beforeEach(() => {
	fake = new FakeApi();
});

describe("buildSnapshot", () => {
	it("keeps the token out of commands, scrubs it before install, and snapshots under the repository's name", async () => {
		const built = await buildSnapshot(client(), repo(), BASE_SHA, { readToken });
		expect(built).toMatchObject({ id: "snp-new", name: NAME, manifest: { sha: BASE_SHA, lockfileHash: HASH } });

		expect(fake.commands().some((c) => c.includes(TOKEN))).toBe(false);
		const scrub = fake.execIndex("scrub-credentials.sh");
		expect(scrub).toBeGreaterThanOrEqual(0);
		expect(fake.execIndex("npm ci")).toBeGreaterThan(scrub);

		expect(fake.inputs("snapshot.create")).toEqual([{ sandboxId: "sbx-1", kind: "filesystem", name: NAME }]);
		expect(fake.terminated()).toEqual(["sbx-1"]);
	});

	it("names the allow-list when install fails, since a blocked host looks like a network flake", async () => {
		fake.overrides = (_id, command) => (command.includes("'npm ci'") ? [out("npm error ECONNRESET\n", "stderr"), exit(1)] : []);
		await expect(buildSnapshot(client(), repo(), BASE_SHA, { readToken })).rejects.toThrow(
			'Sandbox egress is limited to github.com, deb.debian.org. If install needs another host, add it to egress for "acme/web" in factory.config.ts.',
		);
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

const deps = (extra: Partial<OpenSandboxDeps> = {}): OpenSandboxDeps => ({ client: client(), readToken, ...extra });

describe("Sandbox egress", () => {
	it.each([
		{
			name: "adds the repository's hosts to the builder's allow-list, once each",
			open: () => buildSnapshot(client(), repo({ egress: ["registry.npmjs.org", "github.com"] }), BASE_SHA, { readToken }),
			policy: allowList("github.com", "deb.debian.org", "registry.npmjs.org"),
		},
		{
			name: "adds the repository's hosts to an agent sandbox's allow-list",
			open: () => openSandbox(repo({ egress: ["proxy.golang.org", "*.example.com"] }), { kind: "branch", name: "main" }, deps()),
			policy: allowList("github.com", "api.anthropic.com", "proxy.golang.org", "*.example.com"),
		},
		{
			name: "lifts the limit only for a repository configured allow-all",
			open: () => openSandbox(repo({ egress: "allow-all" }), { kind: "branch", name: "main" }, deps()),
			policy: { type: "allow-all" },
		},
	])("$name", async ({ open, policy }) => {
		await open();
		expect(fake.inputs("create").map((input) => (input as { networkPolicy: unknown }).networkPolicy)).toEqual([policy]);
	});
});

describe("openSandbox", () => {
	it("restores by snapshot name, verifies, and checks out the fetched head without the token in any command", async () => {
		const sbx = await openSandbox(repo(), { kind: "branch", name: "main" }, deps());
		expect(sbx).toMatchObject({ id: "sbx-1", headSha: HEAD_SHA, manifest: fake.manifest });
		expect(fake.inputs("create")).toMatchObject([{ snapshotName: NAME }]);
		expect(fake.execIndex("verify.sh")).toBeGreaterThanOrEqual(0);
		expect(fake.commands().some((c) => c.includes(TOKEN))).toBe(false);
		expect(fake.execIndex("npm ci")).toBe(-1);
		expect(fake.terminated()).toEqual([]);
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

	it("replaces a stale runner payload before verifying the sandbox, and leaves a matching one alone", async () => {
		const payloadUpload = () => fake.index((c) => c.op === "upload" && c.path.includes("factory-runner-"));

		await openSandbox(repo(), { kind: "branch", name: "main" }, deps());
		const upload = fake.calls[payloadUpload()] as { data: Buffer };
		expect((await untar(upload.data)).get("runner.mjs")).toBe(FAKE_BUNDLE);
		expect(payloadUpload()).toBeLessThan(fake.execIndex("verify.sh"));

		fake = new FakeApi();
		const { sha256: current } = await runnerPayload();
		fake.overrides = (_id, command) => (command.startsWith("cat /opt/factory/app/runner/payload.sha256") ? [out(current), exit(0)] : []);
		await openSandbox(repo(), { kind: "branch", name: "main" }, deps());
		expect(payloadUpload()).toBe(-1);
	});

	it("refuses a sandbox where the runner could not be confirmed non-dumpable", async () => {
		fake.overrides = (_id, command) => (command.includes("verify.sh") ? [out(info({ runnerNonDumpable: false })), exit(0)] : []);
		await expect(openSandbox(repo(), { kind: "branch", name: "main" }, deps())).rejects.toThrow("non-dumpable");
		expect(fake.calls.at(-1)).toEqual({ op: "terminate", id: "sbx-1" });
	});
});

describe("SandboxClient.execStream", () => {
	it("passes on every chunk in order and resolves with the exit code", async () => {
		fake.overrides = () => [out('{"a":1}\n{"b"'), out("diagnostics\n", "stderr"), out(":2}\n"), exit(3)];
		const chunks: string[] = [];
		const exitCode = await client().execStream("sbx-1", "run", { timeoutMs: 1_000, onData: (stream, data) => chunks.push(`${stream}:${data}`) });
		expect(exitCode).toBe(3);
		expect(chunks).toEqual(['stdout:{"a":1}\n{"b"', "stderr:diagnostics\n", "stdout::2}\n"]);
	});

	it("stops a command that outlives its timeout, keeping what it already passed on", async () => {
		const api = {
			async exec(_id: string, _command: string, _ownerId: undefined, signal: AbortSignal) {
				return (async function* () {
					yield out("started\n");
					await new Promise((_, reject) => signal.addEventListener("abort", reject));
				})();
			},
		} as unknown as SandboxApi;
		const chunks: string[] = [];
		const run = new SandboxClient(api).execStream("sbx-1", "sleep 600", {
			timeoutMs: 50,
			onData: (_, data) => chunks.push(data),
		});
		await expect(run).rejects.toThrow("timed out after 50ms");
		expect(chunks).toEqual(["started\n"]);
	});
});
