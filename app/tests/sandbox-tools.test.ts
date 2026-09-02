import { describe, expect, it, vi } from "vitest";
import {
	isBuiltIn,
	isCustomTool,
	type Sandbox,
	type SandboxExecEvent,
	type ToolContext,
} from "#factory/sdk";
import {
	allSandboxTools,
	sandboxApplyPatch,
	sandboxExec,
	sandboxListDir,
	sandboxReadFile,
	sandboxSearch,
	sandboxWriteFile,
} from "../tools/index.js";

async function* execEvents(
	output: string,
	exitCode = 0,
): AsyncGenerator<SandboxExecEvent> {
	if (output) yield { type: "output", stream: "stdout", data: output };
	yield { type: "exit", exitCode };
}

function fakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
	return {
		id: "sandbox-1",
		exec: async () => execEvents("ok"),
		upload: async () => {},
		download: async () => ({
			data: Buffer.from(""),
			size: 0,
			contentType: "application/octet-stream",
		}),
		status: async () => "running",
		terminate: async () => {},
		readFile: async () => "contents",
		writeFile: async () => {},
		listDir: async () => ["a.ts", "b.ts"],
		...overrides,
	} as Sandbox;
}

function ctxWith(sandbox: Sandbox): ToolContext {
	return {
		agentId: "analyst",
		environment: {
			sandbox,
			workspace: { repoDir: "/home/user/repo" },
		},
	};
}

describe("application sandbox tools", () => {
	it("exports the six bounded sandbox capabilities", () => {
		const tools = [
			sandboxExec,
			sandboxReadFile,
			sandboxWriteFile,
			sandboxListDir,
			sandboxApplyPatch,
			sandboxSearch,
		];

		expect(tools.map((tool) => tool.name)).toEqual([
			"sandbox__exec",
			"sandbox__read_file",
			"sandbox__write_file",
			"sandbox__list_dir",
			"sandbox__apply_patch",
			"sandbox__search",
		]);
		expect(allSandboxTools).toEqual(tools);
		for (const tool of tools) {
			expect(isCustomTool(tool)).toBe(true);
			expect(isBuiltIn(tool)).toBe(false);
		}
	});

	it("uses the sandbox already resolved onto the environment", async () => {
		const readFile = vi.fn().mockResolvedValue("file contents");
		const ctx = ctxWith(fakeSandbox({ readFile }));

		await expect(
			sandboxReadFile.invoke({ path: "/home/user/repo/a.ts" }, ctx),
		).resolves.toEqual({ content: "file contents" });
		expect(readFile).toHaveBeenCalledWith("/home/user/repo/a.ts");
	});

	it("never exposes a sandbox selector in any tool schema", () => {
		for (const tool of allSandboxTools) {
			expect(tool.inputSchema).not.toHaveProperty("sandbox");
			expect(tool.inputSchema).not.toHaveProperty("sandbox_id");
			expect(tool.inputSchema).not.toHaveProperty("sandboxId");
		}
	});

	it("fails when orchestration did not bind a sandbox", async () => {
		await expect(
			sandboxReadFile.invoke(
				{ path: "/home/user/repo/a.ts" },
				{ agentId: "analyst" },
			),
		).rejects.toThrow(/no sandbox binding/);
	});

	it("fails when the environment carries no sandbox", async () => {
		await expect(
			sandboxExec.invoke(
				{ command: "npm test" },
				{
					agentId: "implementer",
					environment: { workspace: { repoDir: "/home/user/repo" } },
				},
			),
		).rejects.toThrow(/no sandbox binding/);
	});

	it("reports a non-zero exit code as tool error output", async () => {
		const ctx = ctxWith(
			fakeSandbox({ exec: async () => execEvents("boom", 1) }),
		);

		await expect(
			sandboxExec.invoke({ command: "npm test" }, ctx),
		).resolves.toEqual({
			content: "Exit code: 1\nboom",
			isError: true,
		});
	});

	it("reports no matches distinctly from a search failure", async () => {
		const noMatches = ctxWith(
			fakeSandbox({ exec: async () => execEvents("", 1) }),
		);
		await expect(
			sandboxSearch.invoke({ pattern: "zzz" }, noMatches),
		).resolves.toEqual({ content: "(no matches)" });

		const failed = ctxWith(
			fakeSandbox({ exec: async () => execEvents("bad regex", 2) }),
		);
		const result = await sandboxSearch.invoke({ pattern: "(" }, failed);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Search failed");
	});
});
