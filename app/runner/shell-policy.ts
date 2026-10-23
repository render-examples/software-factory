import { basename } from "node:path";

/*
 * Read-only shell policy, applied when an agent has neither `edit` nor `write`. A usability guard, not a security
 * boundary: it rejects obviously mutating or networked commands so the model gets a clear message and adapts
 * instead of burning turns. Its parsing is approximate and easy to bypass; the sandbox is the boundary.
 */

const READ_ONLY_GIT = new Set([
	"blame",
	"cat-file",
	"describe",
	"diff",
	"diff-tree",
	"for-each-ref",
	"grep",
	"log",
	"ls-files",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-ref",
	"status",
]);
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat"]);
const PRIVILEGE = new Set(["sudo", "su", "doas"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx"]);
const INSTALL_VERBS: Record<string, string[]> = {
	npm: ["install", "i", "ci", "add", "update", "exec"],
	pnpm: ["install", "i", "add", "update", "dlx"],
	yarn: ["install", "add", "dlx"],
	bun: ["install", "i", "add"],
	pip: ["install"],
	pip3: ["install"],
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
const FILE_WRITERS = new Set(["rm", "rmdir", "mv", "cp", "mkdir", "touch", "ln", "truncate", "tee", "patch", "chmod", "chown"]);
/** Prefixes whose arguments are another command. Their own flags are skipped. */
const WRAPPERS = new Set(["env", "timeout", "nice", "xargs", "command", "exec", "time", "nohup"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const REDIRECT = /^(\d*|&)>>?(.*)$/;

/** Returns why `command` is rejected, or undefined if it may run. */
export function rejectReason(command: string, scratchDir: string): string | undefined {
	for (const words of splitCommands(command)) {
		const reason = checkCommand(words, scratchDir);
		if (reason) return reason;
	}
	return undefined;
}

function inScratch(path: string, scratchDir: string): boolean {
	if (path.split("/").includes("..")) return false;
	if (path === "/dev/null" || path === scratchDir || path.startsWith(`${scratchDir}/`)) return true;
	return /^(\/tmp|\$\{?(TMPDIR|HOME)\}?|~)(\/|$)/.test(path);
}

function checkCommand(raw: string[], scratchDir: string): string | undefined {
	const words: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const match = REDIRECT.exec(raw[i] as string);
		if (!match) {
			words.push(raw[i] as string);
			continue;
		}
		const target = match[2] || raw[++i] || "";
		if (!/^&\d+$/.test(target) && !inScratch(target, scratchDir)) {
			return `redirecting output to ${target || "a file"} is not allowed: only files in the scratch directory (${scratchDir}) may be written`;
		}
	}

	let i = 0;
	while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i] as string) || WRAPPERS.has(basename(words[i] as string)))) {
		i++;
		while (i < words.length && /^(-|\d+[smhd]?$)/.test(words[i] as string)) i++;
	}
	const name = basename(words[i] ?? "");
	const args = words.slice(i + 1);
	if (!name) return undefined;

	if (NETWORK.has(name)) return `${name} is not allowed: read-only agents have no network tools`;
	if (PRIVILEGE.has(name)) return `${name} is not allowed: privilege escalation is not allowed`;
	if (PACKAGE_RUNNERS.has(name)) return `${name} is not allowed: read-only agents don't install or download packages`;
	const verb = args.find((a) => !a.startsWith("-"));
	if (verb && INSTALL_VERBS[name]?.includes(verb)) return `${name} ${verb} is not allowed: read-only agents don't install packages`;
	if (name === "git") {
		if (args.some((a) => a === "-c" || a.startsWith("--config-env") || a.startsWith("--exec-path"))) {
			return "git config overrides are not allowed: they can run arbitrary commands";
		}
		let s = 0;
		while (s < args.length && (args[s] as string).startsWith("-")) s += args[s] === "-C" ? 2 : 1;
		const sub = args[s];
		if (sub && !READ_ONLY_GIT.has(sub)) return `git ${sub} is not allowed: this agent is read-only (allowed: ${[...READ_ONLY_GIT].join(", ")})`;
	}
	const inPlace = (name === "sed" || name === "perl") && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
	if (FILE_WRITERS.has(name) || inPlace) {
		const paths = args.filter((a) => !a.startsWith("-"));
		// A copy or link writes only its destination; a mode, owner, or sed script comes before the paths.
		const targets = name === "cp" || name === "ln" ? paths.slice(-1) : name === "chmod" || name === "chown" || inPlace ? paths.slice(1) : paths;
		const allowed = (name === "tee" && targets.length === 0) || (targets.length > 0 && targets.every((p) => inScratch(p, scratchDir)));
		if (!allowed) return `${name} is only allowed on files in the scratch directory (${scratchDir}): this agent is read-only`;
	}
	if (SHELLS.has(name) && args.includes("-c")) return rejectReason(args[args.indexOf("-c") + 1] ?? "", scratchDir);
	if (name === "eval") return rejectReason(args.join(" "), scratchDir);
	return undefined;
}

/**
 * Splits a shell command line into simple commands (lists of words with quotes removed). Command
 * substitutions and subshells become separate commands, so `echo $(curl x)` yields ["echo"], ["curl", "x"].
 */
function splitCommands(line: string): string[][] {
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
