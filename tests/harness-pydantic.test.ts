import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pydantic } from "../app/harness/index.js";

const pythonFile = (path: string) => readFileSync(new URL(`../python/${path}`, import.meta.url));

describe("pydantic adapter", () => {
	it("refuses a module outside python/ and a credential that isn't an env var name", () => {
		expect(() => pydantic({ module: "../app/evil.py", credential: "ANTHROPIC_API_KEY" })).toThrow("module must be a .py path inside python/");
		expect(() => pydantic({ module: "/etc/agent.py", credential: "ANTHROPIC_API_KEY" })).toThrow("module must be a .py path inside python/");
		expect(() => pydantic({ module: "agents/sonnet.py", credential: "not a var" })).toThrow("credential must be an env var name");
	});

	it("ships the wrapper, the agent modules, and the locked requirements, and reinstalls only when the lockfile changes", () => {
		const provision = pydantic({ module: "agents/sonnet.py", credential: "ANTHROPIC_API_KEY" }).provision?.();
		const paths = provision?.files.map((f) => f.path) ?? [];
		expect(paths).toEqual(expect.arrayContaining(["python/factory_harness/__main__.py", "python/agents/sonnet.py", "python/requirements.txt"]));
		expect(paths.every((p) => p.startsWith("python/") && !p.includes("__pycache__") && !p.includes(".venv"))).toBe(true);
		expect(provision?.hash).toBe(createHash("sha256").update(pythonFile("requirements.txt")).digest("hex"));
		expect(provision?.command).toContain("--require-hashes -r python/requirements.txt");
	});
});
