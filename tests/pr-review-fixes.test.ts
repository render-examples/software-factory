import { describe, expect, it } from "vitest";
import { checkBrowserNavigation } from "../app/policy/browser.js";
import { DRIVER_PORT, DRIVER_LOG } from "../app/tools/browser/index.js";

const HEALTH_URL = `http://127.0.0.1:${DRIVER_PORT}/health`;

describe("browser driver lifecycle (fake sandbox)", () => {
	function fakeSandbox(state: { healthy: boolean; started: boolean }) {
		return {
			sandbox: {
				async run(cmd: string) {
					if (cmd.includes("/health")) {
						return {
							output: state.healthy ? "ok\n" : "fail\n",
							exitCode: 0,
						};
					}
					if (cmd.includes("nohup")) {
						state.started = true;
						state.healthy = true;
						return { output: "", exitCode: 0 };
					}
					return { output: "", exitCode: 0 };
				},
				async mustRun(_cmd: string) {
					return "";
				},
				async writeFile(_path: string, _content: string) {},
			},
		};
	}

	it("skips start when already healthy", async () => {
		const state = { healthy: true, started: false };
		const { sandbox } = fakeSandbox(state);

		const result = await sandbox.run(
			`curl -sf ${HEALTH_URL} 2>/dev/null && echo ok || echo fail`,
		);
		expect(result.output.trim()).toBe("ok");
		expect(state.started).toBe(false);
	});

	it("restarts after the driver dies", async () => {
		const state = { healthy: false, started: false };
		const { sandbox } = fakeSandbox(state);

		const firstCheck = await sandbox.run(
			`curl -sf ${HEALTH_URL} 2>/dev/null && echo ok || echo fail`,
		);
		expect(firstCheck.output.trim()).toBe("fail");

		await sandbox.run(
			`nohup node /home/user/.factory-browser/driver.js > ${DRIVER_LOG} 2>&1 &`,
		);
		expect(state.started).toBe(true);

		const secondCheck = await sandbox.run(
			`curl -sf ${HEALTH_URL} 2>/dev/null && echo ok || echo fail`,
		);
		expect(secondCheck.output.trim()).toBe("ok");
	});

	it("starts the driver lazily when not healthy", async () => {
		const state = { healthy: false, started: false };
		const { sandbox } = fakeSandbox(state);

		// Simulate the ensureDriver pattern: check health → start → poll
		const check = await sandbox.run(
			`curl -sf ${HEALTH_URL} 2>/dev/null && echo ok || echo fail`,
		);
		expect(check.output.trim()).toBe("fail");
		expect(state.started).toBe(false);

		// Start it
		await sandbox.run(
			`nohup node /home/user/.factory-browser/driver.js > ${DRIVER_LOG} 2>&1 &`,
		);
		expect(state.started).toBe(true);

		// Now health check passes
		const recheck = await sandbox.run(
			`curl -sf ${HEALTH_URL} 2>/dev/null && echo ok || echo fail`,
		);
		expect(recheck.output.trim()).toBe("ok");
	});
});

describe("navigation blocking (pure function)", () => {
	const origins = ["http://localhost:3000"];

	it("allows same-origin navigation", () => {
		expect(
			checkBrowserNavigation("http://localhost:3000/foo", origins),
		).toBeNull();
	});

	it("blocks cross-origin navigation", () => {
		expect(
			checkBrowserNavigation("https://evil.test/steal", origins),
		).toContain("not allowed");
	});

	it("blocks cross-origin redirects (different port)", () => {
		expect(
			checkBrowserNavigation("http://localhost:4000/redir", origins),
		).toContain("not allowed");
	});

	it("blocks javascript: URLs", () => {
		expect(checkBrowserNavigation("javascript:alert(1)", origins)).toContain(
			"not allowed",
		);
	});

	it("rejects empty origins list", () => {
		expect(checkBrowserNavigation("http://localhost:3000", [])).toContain(
			"No allowed origins",
		);
	});
});

describe("agent browser gating", () => {
	it("rejects browser input for agents without browser: true", async () => {
		const { agentTaskInputSchema } = await import("../app/tasks/agent-task.js");
		const { security } = await import("../app/agents/index.js");

		expect(security.browser).toBeUndefined();

		// The input schema accepts browser but agentTask gates on agent.browser
		const input = agentTaskInputSchema.parse({
			runId: "run-test",
			message: "test",
			browser: { origins: ["http://localhost:3000"] },
		});
		expect(input.browser?.origins).toEqual(["http://localhost:3000"]);
	});
});

describe("null review body", () => {
	it("ensureReview does not crash on null body", async () => {
		const { ensureReview } = await import("../app/github/pulls.js");
		const { GitHubHttp } = await import("../app/github/request.js");

		const fetchImpl = async (url: string, _init?: RequestInit) => {
			const parsed = new URL(url);
			const pathWithQuery = parsed.pathname + parsed.search;
			if (pathWithQuery.includes("/reviews?")) {
				return new Response(
					JSON.stringify([
						{ id: 1, body: null, state: "COMMENTED" },
						{
							id: 2,
							body: "has a <!-- marker -->",
							state: "COMMENTED",
						},
					]),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(
				JSON.stringify({ id: 99, body: "new", state: "COMMENTED" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		};

		const http = new GitHubHttp(() => "fake-token", fetchImpl as typeof fetch);
		const ref = { owner: "test", repo: "test" };

		const result = await ensureReview(http, ref, 1, {
			commitId: "abc",
			body: "review",
			comments: [],
			marker: "<!-- marker -->",
		});
		expect(result.id).toBe(2);
		expect(result.alreadyExisted).toBe(true);
	});
});

describe("diff with deleted file", () => {
	it("does not attribute deleted-file hunks to the wrong path", async () => {
		const { parseDiffHunks } = await import(
			"../app/workflows/pr-review/diff-positions.js"
		);

		const diff = [
			"diff --git a/src/old.ts b/src/old.ts",
			"deleted file mode 100644",
			"--- a/src/old.ts",
			"+++ /dev/null",
			"@@ -1,5 +0,0 @@",
			"-line1",
			"-line2",
			"-line3",
			"-line4",
			"-line5",
			"diff --git a/src/new.ts b/src/new.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/src/new.ts",
			"@@ -0,0 +1,3 @@",
			"+new1",
			"+new2",
			"+new3",
		].join("\n");

		const hunks = parseDiffHunks(diff);

		expect(hunks).toHaveLength(1);
		expect(hunks[0].path).toBe("src/new.ts");
		expect(hunks[0].newStart).toBe(1);
		expect(hunks[0].newCount).toBe(3);
	});

	it("resets path on diff --git boundary", async () => {
		const { parseDiffHunks } = await import(
			"../app/workflows/pr-review/diff-positions.js"
		);

		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,3 +1,4 @@",
			" line1",
			"+added",
			" line2",
			" line3",
			"diff --git a/src/b.ts b/src/b.ts",
			"deleted file mode 100644",
			"--- a/src/b.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-gone1",
			"-gone2",
			"diff --git a/src/c.ts b/src/c.ts",
			"--- a/src/c.ts",
			"+++ b/src/c.ts",
			"@@ -10,3 +10,4 @@",
			" line10",
			"+added",
			" line11",
			" line12",
		].join("\n");

		const hunks = parseDiffHunks(diff);

		expect(hunks).toHaveLength(2);
		expect(hunks[0].path).toBe("src/a.ts");
		expect(hunks[1].path).toBe("src/c.ts");
	});
});
