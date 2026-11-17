import { describe, expect, it, vi } from "vitest";
import { followRun, LineRelay } from "../app/agents/relay.js";
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
		for (let cut = 1; cut < file.length; cut++) {
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
	const sandbox = (codes: number[]) => {
		const commands: string[] = [];
		const box = {
			async execStream(command: string, opts: ExecStreamOptions) {
				commands.push(command);
				const code = codes.shift() ?? 0;
				if (code === 0) opts.onData("stdout", "done\n");
				return code;
			},
		};
		return { box: box as unknown as Sandbox, commands };
	};

	it("retries while run-agent.sh has not started, then follows the file", async () => {
		const { box, commands } = sandbox([75, 75, 0]);
		const lines: string[] = [];
		expect(await followRun(box, "/run/r1", new LineRelay((line) => lines.push(line)), Date.now() + 60_000)).toBeUndefined();
		expect(commands).toHaveLength(3);
		expect(commands[0]).toContain("[ -e '/run/r1.exit' ] || exit 75");
		expect(lines).toEqual(["done"]);
	});

	it("stops on any other failed follow", async () => {
		const { box } = sandbox([1]);
		expect(await followRun(box, "/run/r1", new LineRelay(() => {}), Date.now() + 60_000)).toBe("following /run/r1.jsonl exited 1");
	});
});
