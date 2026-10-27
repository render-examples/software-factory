import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "@cursor/sdk";
import { cursorSdkVersion, loadCursorSdk, runCursor } from "../runner/cursor/run.js";
import type { Harness, HarnessProvision } from "./types.js";

export interface CursorOptions {
	/** A Cursor model, e.g. `{ id: "composer-2.5" }`; see `Cursor.models.list()`. */
	model: ModelSelection;
	/**
	 * Replace Cursor's system prompt with the agent's prompt. Cursor enables this per account; without it, the
	 * agent's prompt leads the first message instead. Default false.
	 */
	replaceSystemPrompt?: boolean;
}

/**
 * Installs the locked SDK (cursor/package-lock.json) root-owned beside the bundle at APP_DIR/cursor-sdk, with the
 * base image's npm; the SDK's platform package comes with it. Replaces the previous install only once complete.
 */
const CURSOR_SDK_COMMAND = [
	"set -euo pipefail",
	"rm -rf ../cursor-sdk.next",
	"mkdir -p ../cursor-sdk.next",
	"cp cursor/package.json cursor/package-lock.json ../cursor-sdk.next/",
	"cache=$(mktemp -d) && trap 'rm -rf \"$cache\"' EXIT",
	'npm ci --prefix ../cursor-sdk.next --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error --cache "$cache"',
	"chown -R root:root ../cursor-sdk.next",
	"chmod -R a+rX,go-w ../cursor-sdk.next",
	"rm -rf ../cursor-sdk",
	"mv ../cursor-sdk.next ../cursor-sdk",
].join("\n");

function cursorProvision(): HarnessProvision {
	const dir = new URL("../../cursor/", import.meta.url);
	const files = ["package.json", "package-lock.json"].map((name) => ({ path: `cursor/${name}`, source: fileURLToPath(new URL(name, dir)) }));
	const lock = readFileSync(new URL("package-lock.json", dir));
	return { id: "cursor-sdk", files, command: CURSOR_SDK_COMMAND, hash: createHash("sha256").update(lock).digest("hex") };
}

/**
 * Runs an agent on a local Cursor agent inside the Sandbox, with Cursor-hosted models. Cursor's own tools and the
 * checkout's .cursor/ settings are off: the model gets the factory's tools and `submit` as custom tools. The cloud
 * runtime isn't offered: it runs outside the Sandbox and can write to GitHub itself.
 */
export function cursor(opts: CursorOptions): Harness {
	if (!opts.model?.id) throw new Error('cursor: model.id is required, e.g. { id: "composer-2.5" }');
	return {
		name: "cursor",
		label: opts.model.id,
		credential: "CURSOR_API_KEY",
		provision: cursorProvision,
		run: (run) => runCursor(run, { model: opts.model, replaceSystemPrompt: opts.replaceSystemPrompt ?? false }),
		async selfTest() {
			const version = cursorSdkVersion();
			const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
			if (major < 22 || (major === 22 && minor < 13)) {
				return { version, problems: [`cursor: the Cursor SDK needs Node 22.13 or later, not ${process.version}`] };
			}
			try {
				const sdk = await loadCursorSdk();
				return { version, problems: typeof sdk.Agent?.create === "function" ? [] : ["cursor: the Cursor SDK loaded without Agent.create"] };
			} catch (err) {
				return { version, problems: [`cursor: could not load the Cursor SDK: ${err instanceof Error ? err.message : String(err)}`] };
			}
		},
	};
}
