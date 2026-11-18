import { describe, expect, it, vi } from "vitest";
import { followRun, LineRelay } from "../app/agent-runs/relay.js";
import { asciiJson, createEmitter } from "../app/runner/core/emit.js";
import type { ExecStreamOptions, Sandbox } from "../app/sandbox/types.js";

vi.mock("node:timers/promises", () => ({ setTimeout: () => Promise.resolve() }));

const TEXT = "café – naïve 👍 …[truncated]";

describe("runner output", () => {
	it("is 7-bit ASCII that parses back to the same strings", async () => {
		let out = "";
		const emit = createEmitter(async (chunk) => {
			out += chunk;
		});
		emit({ type: "assistant_text", message_id: "m1", text: TEXT });
		await emit.flush();
		expect(out).not.toMatch(/[^\x20-\x7e\n]/);
		expect(JSON.parse(out)).toMatchObject({ text: TEXT });
		expect(JSON.parse(asciiJson(JSON.stringify("\u{1f680}")))).toBe("\u{1f680}");
	});

	it("keeps the relay's offset equal to the file's bytes however the chunks split", () => {
		const file = [TEXT, "second", TEXT].map((text) => `${asciiJson(JSON.stringify({ text }))}\n`).join("");
		const firstLine = file.indexOf("\n") + 1;
		for (const cut of [1, firstLine - 1, firstLine, firstLine + 1, Math.floor(file.length / 2), file.length - 1]) {
			const lines: string[] = [];
			const relay = new LineRelay((line) => lines.push(line));
			relay.push(file.slice(0, cut));
			relay.push(file.slice(cut, cut + 7));
			relay.restart();
			relay.finish(Buffer.from(file));
			expect(lines.map((line) => JSON.parse(line).text)).toEqual([TEXT, "second", TEXT]);
			expect(relay.offset).toBe(Buffer.byteLength(file));
		}
	});
});

describe("followRun", () => {
	const sandbox = (codes: number[]) =>
		({
			async execStream(_command: string, opts: ExecStreamOptions) {
				const code = codes.shift() ?? 0;
				if (code === 0) opts.onData("stdout", "done\n");
				return code;
			},
		}) as unknown as Sandbox;

	it("retries while run-agent.sh has not started, then follows the file", async () => {
		const lines: string[] = [];
		expect(await followRun(sandbox([75, 75, 0]), "/run/r1", new LineRelay((line) => lines.push(line)), Date.now() + 60_000)).toBeUndefined();
		expect(lines).toEqual(["done"]);
	});

	it("stops on any other failed follow", async () => {
		const box = sandbox([1]);
		expect(await followRun(box, "/run/r1", new LineRelay(() => {}), Date.now() + 60_000)).toBe("following /run/r1.jsonl exited 1");
	});
});
