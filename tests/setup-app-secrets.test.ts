import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeEnvFile } from "../scripts/lib/env-file.js";

vi.mock("../app/config/index.js", () => ({
	config: {
		repos: { "acme/web": {} },
		labels: { triage: "factory:triage", specApproved: "factory:spec-approved", prReview: "factory:pr-review", autopilot: "factory:autopilot" },
	},
}));
vi.mock("../scripts/lib/env-file.js", () => ({ writeEnvFile: vi.fn() }));
vi.mock("../scripts/lib/manifest.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../scripts/lib/manifest.js")>()),
	startCallbackServer: async () => ({
		url: "http://127.0.0.1:5555",
		result: Promise.resolve({
			id: 123,
			slug: "sf-test",
			name: "sf-test",
			pem: "fake-private-key-do-not-print",
			html_url: "https://github.com/apps/sf-test",
		}),
		close: async () => {},
	}),
}));

const originalArgv = process.argv;
const directories: string[] = [];

afterEach(async () => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
	vi.clearAllMocks();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("setup:app credential output", () => {
	it.each([{ args: [] }, { args: ["--write-env"] }])("saves credentials without printing them with arguments $args", async ({ args }) => {
		process.argv = ["node", "scripts/setup-app.ts", ...args];
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.resetModules();
		await import("../scripts/setup-app.js");

		const [path, credentials] = vi.mocked(writeEnvFile).mock.calls[0];
		expect(path).toBe(".env");
		expect(credentials).toEqual({
			GITHUB_APP_ID: "123",
			GITHUB_APP_PRIVATE_KEY: Buffer.from("fake-private-key-do-not-print").toString("base64"),
			GITHUB_WEBHOOK_SECRET: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		const output = log.mock.calls.flat().join("\n");
		expect(output).toContain("Wrote GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET to .env");
		expect(output).toContain("https://github.com/apps/sf-test/installations/new");
		expect(output).not.toContain("fake-private-key-do-not-print");
		expect(output).not.toContain(credentials.GITHUB_APP_PRIVATE_KEY);
		expect(output).not.toContain(credentials.GITHUB_WEBHOOK_SECRET);
	});
});

describe("dotenv credential storage", () => {
	it.each(["new", "existing"])("protects $0 dotenv files and preserves unrelated settings", async (kind) => {
		const existing = kind === "existing";
		const directory = await mkdtemp(join(tmpdir(), "software-factory-env-"));
		directories.push(directory);
		const path = join(directory, ".env");
		if (existing) {
			await writeFile(path, "# Keep this comment\nOTHER_SETTING=keep\nGITHUB_APP_PRIVATE_KEY=old\n");
			if (process.platform !== "win32") await chmod(path, 0o644);
		}
		const { writeEnvFile: save } = await vi.importActual<typeof import("../scripts/lib/env-file.js")>("../scripts/lib/env-file.js");
		await save(path, { GITHUB_APP_PRIVATE_KEY: "new-private-key", GITHUB_WEBHOOK_SECRET: "new-webhook-secret" });

		const contents = await readFile(path, "utf8");
		expect(contents).toContain("GITHUB_APP_PRIVATE_KEY=new-private-key\n");
		expect(contents).toContain("GITHUB_WEBHOOK_SECRET=new-webhook-secret\n");
		expect(contents).not.toContain("GITHUB_APP_PRIVATE_KEY=old");
		if (existing) expect(contents).toContain("# Keep this comment\nOTHER_SETTING=keep\n");
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
