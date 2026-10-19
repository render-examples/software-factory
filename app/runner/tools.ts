import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	type AgentTool,
	type BashToolDetails,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExecutionToolContext,
	type ReadToolDetails,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "typebox";
import type { ToolName } from "./protocol.js";

/*
 * Read-only shell policy, applied when an agent has neither `edit` nor `write`. A usability guard, not a
 * security boundary: it rejects obviously mutating or networked commands so the model gets a clear message
 * and adapts instead of burning turns. Shell parsing here is approximate and can be bypassed; the sandbox
 * is the boundary.
 */

const READ_ONLY_GIT = new Set([
	"annotate",
	"blame",
	"branch",
	"cat-file",
	"check-attr",
	"check-ignore",
	"cherry",
	"config",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"diff-tree",
	"for-each-ref",
	"grep",
	"help",
	"log",
	"ls-files",
	"ls-tree",
	"merge-base",
	"name-rev",
	"range-diff",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-ref",
	"status",
	"tag",
	"version",
	"whatchanged",
]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
const BRANCH_WRITE_FLAGS = new Set([
	"-d",
	"-D",
	"--delete",
	"-m",
	"-M",
	"--move",
	"-c",
	"-C",
	"--copy",
	"-f",
	"--force",
	"-u",
	"--set-upstream-to",
	"--unset-upstream",
	"--edit-description",
	"-t",
	"--track",
	"--no-track",
]);
const TAG_WRITE_FLAGS = new Set([
	"-d",
	"--delete",
	"-a",
	"--annotate",
	"-s",
	"--sign",
	"-u",
	"--local-user",
	"-m",
	"--message",
	"-F",
	"--file",
	"-f",
	"--force",
	"-e",
	"--edit",
]);
const REF_LIST_VALUE_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);
const CONFIG_WRITE_FLAGS = new Set([
	"--global",
	"--system",
	"--add",
	"--unset",
	"--unset-all",
	"--replace-all",
	"--rename-section",
	"--remove-section",
	"-e",
	"--edit",
	"set",
	"unset",
	"rename-section",
	"remove-section",
	"edit",
]);

const DENIED = new Map<string, string>([
	...["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat"].map(
		(c) => [c, "read-only agents have no network tools"] as const,
	),
	...["sudo", "su", "doas"].map((c) => [c, "privilege escalation is not allowed"] as const),
	...["npx", "bunx"].map((c) => [c, "downloading packages is not allowed for read-only agents"] as const),
]);
const INSTALL_VERBS: Record<string, string[]> = {
	npm: ["install", "i", "ci", "add", "update", "exec"],
	pnpm: ["install", "i", "add", "update", "dlx"],
	yarn: ["install", "add", "dlx"],
	bun: ["install", "i", "add"],
	pip: ["install"],
	pip3: ["install"],
	pipx: ["install"],
	uv: ["install", "add", "sync"],
	gem: ["install"],
	cargo: ["install"],
	go: ["get", "install"],
	"apt-get": ["install"],
	apt: ["install"],
	apk: ["add"],
	brew: ["install"],
};
/** Commands that create, change, or delete files: allowed only when every path operand is in scratch. */
const FILE_WRITERS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"ln",
	"truncate",
	"shred",
	"install",
	"tee",
	"patch",
	"chmod",
	"chown",
	"chgrp",
]);
/** Commands that edit files in place with -i. */
const IN_PLACE_EDITORS = new Set(["sed", "perl"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
/** Prefix commands whose arguments are another command, with the flags that take a separate value. */
const WRAPPERS: Record<string, string[]> = {
	env: ["-u", "-C", "--unset", "--chdir"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	nice: ["-n", "--adjustment"],
	xargs: ["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a"],
	stdbuf: ["-i", "-o", "-e"],
	command: [],
	exec: [],
	time: [],
	nohup: [],
	builtin: [],
};
const REDIRECT = /^(\d*|&)>>?(.*)$/;
const HARMLESS_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

export interface PolicyContext {
	scratchDir: string;
}

/** Returns why `command` is rejected, or undefined if it may run. */
export function rejectReason(command: string, ctx: PolicyContext): string | undefined {
	for (const words of splitCommands(command)) {
		const reason = checkSimpleCommand(words, ctx);
		if (reason) return reason;
	}
	return undefined;
}

function inScratch(path: string, ctx: PolicyContext): boolean {
	if (path.split("/").includes("..")) return false;
	return (
		path === ctx.scratchDir ||
		path.startsWith(`${ctx.scratchDir}/`) ||
		path === "/tmp" ||
		path.startsWith("/tmp/") ||
		/^(\$\{?(TMPDIR|HOME)\}?|~)(\/|$)/.test(path)
	);
}

/** Rejects output redirections to files outside scratch, and returns the words without them. */
function stripRedirects(words: string[], ctx: PolicyContext): { words: string[]; reason?: string } {
	const rest: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const match = REDIRECT.exec(words[i] as string);
		if (!match) {
			rest.push(words[i] as string);
			continue;
		}
		const target = match[2] || words[++i] || "";
		if (/^&\d+$/.test(target) || HARMLESS_TARGETS.has(target) || inScratch(target, ctx)) continue;
		return { words: rest, reason: `redirecting output to ${target || "a file"} is not allowed: only files in the scratch directory (${ctx.scratchDir}) may be written` };
	}
	return { words: rest };
}

function checkSimpleCommand(raw: string[], ctx: PolicyContext): string | undefined {
	const { words, reason } = stripRedirects(raw, ctx);
	if (reason) return reason;
	let i = 0;
	while (i < words.length) {
		const word = words[i] as string;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++;
		else if (Object.hasOwn(WRAPPERS, basename(word))) i = skipWrapperArgs(basename(word), words, i + 1);
		else break;
	}
	if (i >= words.length) return undefined;
	const name = basename(words[i] as string);
	const args = words.slice(i + 1);

	const denied = DENIED.get(name);
	if (denied) return `${name} is not allowed: ${denied}`;
	const verb = args.find((a) => !a.startsWith("-"));
	if (verb && INSTALL_VERBS[name]?.includes(verb)) return `${name} ${verb} is not allowed: read-only agents don't install packages`;
	if (name === "git") return checkGit(args);
	if (FILE_WRITERS.has(name)) return checkFileWriter(name, args, ctx);
	if (IN_PLACE_EDITORS.has(name) && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
		return checkFileWriter(`${name} -i`, args.slice(1), ctx);
	}
	if (SHELLS.has(name)) {
		const script = args[args.indexOf("-c") + 1];
		return args.includes("-c") && script ? rejectReason(script, ctx) : undefined;
	}
	if (name === "eval") return rejectReason(args.join(" "), ctx);
	return undefined;
}

function skipWrapperArgs(wrapper: string, words: string[], i: number): number {
	const valueFlags = WRAPPERS[wrapper] ?? [];
	let sawDuration = false;
	let j = i;
	while (j < words.length) {
		const word = words[j] as string;
		if (word.startsWith("-")) j += valueFlags.includes(word) ? 2 : 1;
		else if (wrapper === "timeout" && !sawDuration) {
			sawDuration = true;
			j++;
		} else break;
	}
	return j;
}

function checkGit(args: string[]): string | undefined {
	let i = 0;
	while (i < args.length && (args[i] as string).startsWith("-")) {
		const arg = args[i] as string;
		if (arg === "-c" || arg.startsWith("--config-env") || arg.startsWith("--exec-path")) {
			return `git ${arg} is not allowed: it can run arbitrary commands via config`;
		}
		i += GIT_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1;
	}
	const sub = args[i];
	if (sub === undefined) return undefined;
	const rest = args.slice(i + 1);
	if (!READ_ONLY_GIT.has(sub)) {
		return `git ${sub} is not allowed: this agent is read-only (allowed: ${[...READ_ONLY_GIT].join(", ")})`;
	}
	if ((sub === "branch" || sub === "tag") && !isRefListing(sub, rest)) {
		return `git ${sub} may only list refs here (e.g. git ${sub} --list, git ${sub} --contains <commit>)`;
	}
	if (sub === "config") {
		const write = rest.find((a) => CONFIG_WRITE_FLAGS.has(a.split("=")[0] as string));
		const positional = rest.filter((a) => !a.startsWith("-"));
		if (write || positional.length > 1) return "git config may only read values here (e.g. git config --get <key>, git config --list)";
	}
	return undefined;
}

function isRefListing(sub: "branch" | "tag", rest: string[]): boolean {
	const writeFlags = sub === "branch" ? BRANCH_WRITE_FLAGS : TAG_WRITE_FLAGS;
	if (rest.some((a) => writeFlags.has(a.split("=")[0] as string))) return false;
	if (rest.includes("-l") || rest.includes("--list")) return true;
	for (let i = 0; i < rest.length; i++) {
		if (REF_LIST_VALUE_FLAGS.has(rest[i] as string)) i++;
		else if (!(rest[i] as string).startsWith("-")) return false;
	}
	return true;
}

function checkFileWriter(name: string, args: string[], ctx: PolicyContext): string | undefined {
	let operands = args.filter((a) => !a.startsWith("-"));
	// chmod/chown/chgrp take a mode or owner before the paths.
	if (["chmod", "chown", "chgrp"].includes(name)) operands = operands.slice(1);
	// Copies and links write only their destination.
	if (["cp", "ln", "install"].includes(name)) operands = operands.slice(-1);
	if (operands.length > 0 && operands.every((p) => inScratch(p, ctx))) return undefined;
	if (name === "tee" && operands.length === 0) return undefined;
	return `${name} is only allowed on files in the scratch directory (${ctx.scratchDir}): this agent is read-only`;
}

/**
 * Splits a shell command line into simple commands (lists of words with quotes removed). Command
 * substitutions and subshells become separate commands, so `echo $(curl x)` yields ["echo"], ["curl", "x"].
 */
export function splitCommands(line: string): string[][] {
	type Quote = "'" | '"' | undefined;
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: Quote;
	// Open substitutions: the char that closes each one and the quote state to resume after it.
	const open: Array<{ close: ")" | "`"; quote: Quote }> = [];
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let i = 0; i < line.length; i++) {
		const c = line[i] as string;
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else word += c;
			continue;
		}
		if (c === "\\" && i + 1 < line.length) {
			word += line[++i];
			inWord = true;
			continue;
		}
		if (!quote && c === open.at(-1)?.close) {
			endCommand();
			quote = open.pop()?.quote;
			inWord = quote !== undefined;
			continue;
		}
		if (c === "`" || (c === "$" && line[i + 1] === "(")) {
			// Substitutions run even inside double quotes; their body is parsed unquoted.
			endCommand();
			open.push({ close: c === "`" ? "`" : ")", quote });
			quote = undefined;
			if (c === "$") i++;
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = undefined;
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (/\s/.test(c) && c !== "\n") {
			endWord();
		} else if (";&|()\n".includes(c) && !(c === "&" && (line[i + 1] === ">" || line[i - 1] === ">"))) {
			endCommand();
		} else {
			word += c;
			inWord = true;
		}
	}
	endCommand();
	return commands;
}

// ── tools ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;
const LS_DEFAULT_LIMIT = 500;
const LS_MAX_LIMIT = 2000;
const OUTPUT_LIMIT = `${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB`;

export interface ToolOptions {
	tools: readonly ToolName[];
	cwd: string;
	scratchDir: string;
}

/** Without edit or write the agent is read-only, and bash applies the read-only shell policy. */
const isReadOnly = (tools: readonly ToolName[]): boolean => !tools.includes("edit") && !tools.includes("write");

/**
 * Builds the child env from an allowlist so nothing from the runner's environment (model credentials,
 * the Render API key) can reach a model-controlled process.
 */
function shellEnv(path: string | undefined, scratchDir: string): Record<string, string> {
	return {
		PATH: path || "/usr/local/bin:/usr/bin:/bin",
		LANG: process.env.LANG || "C.UTF-8",
		HOME: scratchDir,
		TMPDIR: scratchDir,
		PAGER: "cat",
		GIT_PAGER: "cat",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		// The checkout can be owned by another uid; without this git refuses "dubious ownership".
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "safe.directory",
		GIT_CONFIG_VALUE_0: "*",
	};
}

/** The tools named in `opts.tools`, in that order, all rooted at `opts.cwd`. */
// biome-ignore lint/suspicious/noExplicitAny: tools with different parameter schemas share one list, as in Pi.
export function createTools(opts: ToolOptions): AgentTool<any>[] {
	const context: ExecutionToolContext = {
		env: new NodeExecutionEnv({ cwd: opts.cwd, shellEnv: shellEnv(process.env.PATH, opts.scratchDir) }),
	};
	// biome-ignore lint/suspicious/noExplicitAny: see above.
	const factories: Record<ToolName, () => AgentTool<any>> = {
		read: () => createTextReadTool(context, opts),
		ls: () => createLsTool(opts),
		bash: () => createShellTool(context, opts, isReadOnly(opts.tools)),
		edit: () => withContext(createEditTool(), context),
		write: () => withContext(createWriteTool(), context),
	};
	return [...new Set(opts.tools)].map((name) => factories[name]());
}

type HarnessTool = ReturnType<typeof createEditTool> | ReturnType<typeof createWriteTool>;

/** Binds one of Pi's harness tools (which take the execution context per call) to `context`. */
// biome-ignore lint/suspicious/noExplicitAny: see createTools.
function withContext(inner: HarnessTool, context: ExecutionToolContext): AgentTool<any> {
	return {
		...inner,
		// biome-ignore lint/suspicious/noExplicitAny: the params match inner.parameters, validated by Pi.
		execute: (toolCallId: string, params: any, signal?: AbortSignal) => inner.execute(toolCallId, params, signal, undefined, context),
	};
}

/** Pi's read tool without image attachments: images only cost tokens. */
function createTextReadTool(context: ExecutionToolContext, { cwd }: ToolOptions) {
	const inner = createReadTool();
	const tool: AgentTool<typeof inner.parameters, ReadToolDetails | undefined> = {
		...inner,
		description:
			`Read a text file. path is relative to ${cwd} or absolute. offset is the first line to read (1-based) and ` +
			`limit the number of lines. Output is truncated to ${OUTPUT_LIMIT}; continue with offset for the rest.`,
		async execute(toolCallId, params, signal) {
			const result = await inner.execute(toolCallId, params, signal, undefined, context);
			const content = result.content.map((c) => (c.type === "image" ? { type: "text" as const, text: "[image omitted]" } : c));
			return { ...result, content };
		},
	};
	return tool;
}

const LsParams = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list, relative to the working directory or absolute (default: the working directory)" })),
	limit: Type.Optional(Type.Integer({ description: `Maximum entries to return (default ${LS_DEFAULT_LIMIT})` })),
});

function createLsTool({ cwd }: ToolOptions): AgentTool<typeof LsParams> {
	return {
		name: "ls",
		label: "ls",
		description: `List a directory's entries in sorted order, with a trailing / on directories. Paths are relative to ${cwd}.`,
		parameters: LsParams,
		async execute(_toolCallId, { path, limit }) {
			const entries = await readdir(resolve(cwd, path ?? "."), { withFileTypes: true });
			const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort((a, b) => a.localeCompare(b));
			const max = Math.min(Math.max(limit ?? LS_DEFAULT_LIMIT, 1), LS_MAX_LIMIT);
			let text = names.slice(0, max).join("\n") || "(empty directory)";
			if (names.length > max) text += `\n\n[${names.length - max} more entries; raise limit or use bash]`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}

/** Pi's bash tool with an allowlisted env and bounded timeouts; read-only agents also get the shell policy. */
function createShellTool(context: ExecutionToolContext, { cwd, scratchDir }: ToolOptions, readOnly: boolean) {
	const inner = createBashTool({
		prepare: (execution) => {
			execution.cwd = cwd;
			execution.env = shellEnv(process.env.PATH, scratchDir);
			execution.inheritEnv = false;
		},
	});
	const limits = `Output keeps the last ${OUTPUT_LIMIT}. timeout is in seconds: default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.`;
	const description = readOnly
		? `Run a bash command for read-only inspection. Working directory: ${cwd}. Writable scratch directory: ${scratchDir} ` +
			"($HOME and $TMPDIR point there). Use it to search (rg, git grep, find), for git history (git log/show/blame/diff), " +
			"sed -n, wc, and scripts or tests that do not modify the working directory. Commands that write outside scratch, " +
			`mutating git commands, network tools, package installs, and sudo are rejected. ${limits}`
		: `Run a bash command. Working directory: ${cwd}. Scratch directory: ${scratchDir} ($HOME and $TMPDIR point there). ${limits}`;
	const tool: AgentTool<typeof inner.parameters, BashToolDetails | undefined> = {
		...inner,
		description,
		async execute(toolCallId, params, signal, onUpdate) {
			const reason = readOnly ? rejectReason(params.command, { scratchDir }) : undefined;
			if (reason) {
				throw new Error(
					`Command rejected by the read-only shell policy: ${reason}. ` +
						"This agent can't modify the working directory; inspect with read-only commands instead.",
				);
			}
			const timeout = Math.min(Math.max(params.timeout ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
			return inner.execute(toolCallId, { ...params, timeout }, signal, onUpdate, context);
		},
	};
	return tool;
}
