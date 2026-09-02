import { describe, expect, it, vi } from "vitest";
import type { ExecResult, Sandbox } from "../app/sandbox/index.js";
import {
	sandboxApplyPatch,
	sandboxExec,
	sandboxListDir,
	sandboxReadFile,
	sandboxSearch,
	sandboxWriteFile,
	type ToolContext,
} from "../app/tools/index.js";

function context(sandbox: Partial<Sandbox>): ToolContext {
	return { sandbox: sandbox as Sandbox };
}

type RunFn = (
	command: string,
	opts?: { signal?: AbortSignal },
) => Promise<ExecResult>;

/** Typed so assertions can read back the command that was run. */
const runMock = (output: string, exitCode = 0) =>
	vi.fn<RunFn>(async () => ({ output, exitCode }));

describe("sandbox__exec", () => {
	it("returns command output on success", async () => {
		const run = runMock("all tests passed");
		const out = await sandboxExec.invoke(
			{ command: "npm test" },
			context({ run }),
		);

		expect(run).toHaveBeenCalledWith("npm test", { signal: undefined });
		expect(out.content).toBe("all tests passed");
		expect(out.isError).toBe(false);
	});

	it("reports a non-zero exit as a tool error with its exit code", async () => {
		const run = runMock("1 failing", 1);
		const out = await sandboxExec.invoke(
			{ command: "npm test" },
			context({ run }),
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("Exit code: 1");
		expect(out.content).toContain("1 failing");
	});

	it("runs inside cwd when given one", async () => {
		const run = runMock("");
		await sandboxExec.invoke(
			{ command: "ls", cwd: "/home/user/repo" },
			context({ run }),
		);

		expect(run.mock.calls[0][0]).toBe("cd '/home/user/repo' && ls");
	});
});

describe("sandbox file tools", () => {
	it("reads a file", async () => {
		const readFile = vi.fn(async () => "export const x = 1;");
		const out = await sandboxReadFile.invoke(
			{ path: "src/x.ts" },
			context({ readFile }),
		);
		expect(out.content).toBe("export const x = 1;");
	});

	it("reports bytes written", async () => {
		const writeFile = vi.fn(async () => undefined);
		const out = await sandboxWriteFile.invoke(
			{ path: "src/x.ts", content: "hello" },
			context({ writeFile }),
		);

		expect(writeFile).toHaveBeenCalledWith("src/x.ts", "hello");
		expect(out.content).toContain("Wrote 5 bytes");
	});

	it("defaults list_dir to the sandbox root", async () => {
		const listDir = vi.fn(async () => ["a.ts", "b/"]);
		const out = await sandboxListDir.invoke({}, context({ listDir }));

		expect(listDir).toHaveBeenCalledWith(".");
		expect(out.content).toBe("a.ts\nb/");
	});

	it("describes an empty directory rather than returning nothing", async () => {
		const listDir = vi.fn(async () => []);
		const out = await sandboxListDir.invoke(
			{ path: "empty" },
			context({ listDir }),
		);
		expect(out.content).toBe("(empty directory)");
	});
});

describe("sandbox__search", () => {
	it("treats ripgrep exit 1 as no matches, not a failure", async () => {
		const run = runMock("", 1);
		const out = await sandboxSearch.invoke(
			{ pattern: "nope" },
			context({ run }),
		);

		expect(out.content).toBe("(no matches)");
		expect(out.isError).toBeUndefined();
	});

	it("reports a real ripgrep failure as an error", async () => {
		const run = runMock("bad pattern", 2);
		const out = await sandboxSearch.invoke({ pattern: "[" }, context({ run }));
		expect(out.isError).toBe(true);
	});

	it("passes an include glob through to ripgrep", async () => {
		const run = runMock("src/x.ts:1:hit");
		await sandboxSearch.invoke(
			{ pattern: "hit", include: "*.ts" },
			context({ run }),
		);

		expect(run.mock.calls[0][0]).toContain("'--glob' '*.ts'");
	});
});

describe("sandbox__apply_patch", () => {
	it("uploads the diff and applies it", async () => {
		const upload = vi.fn(async () => undefined);
		const run = runMock("");
		const out = await sandboxApplyPatch.invoke(
			{ diff: "--- a\n+++ b\n" },
			context({ upload, run }),
		);

		expect(upload).toHaveBeenCalledOnce();
		expect(run.mock.calls[0][0]).toContain("git apply --whitespace=nowarn");
		expect(out.content).toBe("Patch applied successfully.");
	});

	it("surfaces a rejected patch as an error", async () => {
		const out = await sandboxApplyPatch.invoke(
			{ diff: "garbage" },
			context({
				upload: vi.fn(async () => undefined),
				run: runMock("does not apply", 1),
			}),
		);

		expect(out.isError).toBe(true);
		expect(out.content).toContain("does not apply");
	});
});
