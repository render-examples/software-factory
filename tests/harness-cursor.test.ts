import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursor } from "../app/harness/index.js";
import { GOOD, makeInput, makeWorkspace, runContract, runLive, SUBMIT, terminal, toolResults } from "./helpers/runner.js";

const repoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
const harness = cursor({ model: { id: "composer-2.5" } });

describe("cursor adapter", () => {
	it("declares the Cursor key, the factory's tools, and the locked SDK install", () => {
		expect(harness).toMatchObject({ name: "cursor", label: "composer-2.5", credential: "CURSOR_API_KEY" });
		const provision = harness.provision?.();
		expect(provision?.files.map((f) => f.path)).toEqual(["cursor/package.json", "cursor/package-lock.json"]);
		expect(provision?.hash).toBe(createHash("sha256").update(repoFile("cursor/package-lock.json")).digest("hex"));
		expect(provision?.command).toContain("npm ci --prefix ../cursor-sdk.next --omit=dev --ignore-scripts");
	});

	it("pins one SDK version for the sandbox install and the repo, and reports the installed one", async () => {
		const pinned = (path: string) => JSON.parse(repoFile(path).toString()).dependencies["@cursor/sdk"];
		expect(pinned("cursor/package.json")).toBe(pinned("package.json"));
		expect(await harness.selfTest()).toEqual({ version: pinned("package.json"), problems: [] });
	});

	it("refuses a --test-stub run: Cursor's models can't be scripted", async () => {
		const { code, events } = await runContract(harness, makeInput(undefined), []);
		expect(terminal(events)).toMatchObject({ type: "error", code: "invalid_input", message: expect.stringContaining("no test model") });
		expect(code).toBe(2);
	});
});

// Live conformance against Cursor's hosted models: CURSOR_LIVE=1 CURSOR_API_KEY=... npx vitest run tests/harness-cursor.test.ts
const KEY = process.env.CURSOR_LIVE === "1" ? (process.env.CURSOR_API_KEY ?? "") : "";

describe.skipIf(!KEY)("cursor harness conformance (live)", { timeout: 240_000 }, () => {
	it("reads with the factory's tools and submits schema-valid output, without echoing the key", async () => {
		const ws = makeWorkspace();
		const input = makeInput(ws, {
			system_prompt: "You inspect repositories with the tools you have, then call submit exactly once.",
			message: `Read src/app.ts, then submit: summary describing what it exports, files listing the files you read, and confidence "high". Example: ${JSON.stringify(GOOD)}`,
			max_turns: 10,
		});
		const { code, stdout, events } = await runLive(harness, input, KEY);
		expect(events[0]).toMatchObject({
			type: "started",
			harness: "cursor",
			harness_version: (await harness.selfTest()).version,
			model: "composer-2.5",
		});
		expect(toolResults(events).some((r) => r.tool === "read" && !r.is_error)).toBe(true);
		expect(terminal(events)).toMatchObject({ type: "result", output: { summary: expect.any(String), files: expect.any(Array) } });
		expect(stdout).not.toContain(KEY);
		expect(code).toBe(0);
	});

	it("applies the read-only shell policy and keeps every key out of tool commands", async () => {
		const ws = makeWorkspace();
		const input = makeInput(ws, {
			tools: ["read", "ls", "bash"],
			system_prompt: "You follow instructions exactly, using the tools you have, then call submit exactly once.",
			message:
				"Run these two bash commands, one at a time, exactly as written: `env > $HOME/env.txt` and then `git push origin main`. " +
				`Then submit with summary "done", files [], and confidence "high".`,
			max_turns: 10,
		});
		const { events } = await runLive(harness, input, KEY);
		const push = toolResults(events).find((r) => r.tool === "bash" && r.output_preview.includes("git push"));
		expect(push).toMatchObject({ is_error: true, output_preview: expect.stringContaining("git push is not allowed") });
		const env = readFileSync(join(ws.scratchDir, "env.txt"), "utf8");
		for (const leaked of ["CURSOR", "ANTHROPIC", KEY]) expect(env).not.toContain(leaked);
		expect(terminal(events)).toMatchObject({ type: "result" });
		expect(
			toolResults(events)
				.filter((r) => r.tool === SUBMIT)
				.at(-1),
		).toMatchObject({ is_error: false });
	});
});
