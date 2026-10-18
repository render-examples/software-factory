import { type GitHubClient, GitHubError, type PullFile } from "../../github/index.js";

/** For each file in the new version, the lines a unified diff shows on its RIGHT side: added and context lines. */
export type DiffLines = Map<string, Set<number>>;

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a `git diff`-style unified diff (GitHub's `application/vnd.github.diff`). Hunk line counts decide
 * where a hunk ends, so a removed line that reads `-- x` (shown as `--- x`) is never taken for a file header.
 * Deleted files have no right side; renames are keyed by their new path.
 */
export function parseDiffLines(diff: string): DiffLines {
	const files: DiffLines = new Map();
	let lines: Set<number> | undefined;
	let oldLeft = 0;
	let newLeft = 0;
	let next = 0;
	for (const line of diff.split("\n")) {
		if (oldLeft > 0 || newLeft > 0) {
			const kind = line[0];
			if (kind === "\\") continue;
			if (kind === "-") {
				oldLeft--;
				continue;
			}
			if (kind === "+" || kind === " " || line === "") {
				lines?.add(next++);
				newLeft--;
				if (kind !== "+") oldLeft--;
				continue;
			}
			oldLeft = newLeft = 0;
		}
		if (line.startsWith("diff --git ")) {
			lines = undefined;
		} else if (line.startsWith("+++ ")) {
			const path = newPath(line.slice(4));
			lines = path === null ? undefined : (files.get(path) ?? new Set());
			if (path !== null && lines) files.set(path, lines);
		} else {
			const hunk = HUNK.exec(line);
			if (hunk) {
				oldLeft = Number(hunk[1] ?? 1);
				newLeft = Number(hunk[3] ?? 1);
				next = Number(hunk[2]);
			}
		}
	}
	return files;
}

/** The same, from the per-file patches of the list-files API (hunks without file headers), for diffs too large to fetch whole. */
export function patchLines(files: readonly PullFile[]): DiffLines {
	const lines: DiffLines = new Map();
	for (const file of files) {
		if (file.patch === undefined || file.status === "removed") continue;
		const parsed = parseDiffLines(`+++ b/${file.filename}\n${file.patch}`).get(file.filename);
		if (parsed) lines.set(file.filename, parsed);
	}
	return lines;
}

/** The PR's commentable lines from its unified diff, or from the per-file patches when GitHub won't serve a diff that large. */
export async function pullDiffLines(gh: Pick<GitHubClient, "getPullDiff">, pr: number, files: readonly PullFile[]): Promise<DiffLines> {
	try {
		return parseDiffLines(await gh.getPullDiff(pr));
	} catch (error) {
		if (error instanceof GitHubError && (error.status === 406 || error.status === 422)) return patchLines(files);
		throw error;
	}
}

export function commentable(lines: DiffLines): (path: string, line: number) => boolean {
	return (path, line) => lines.get(path)?.has(line) ?? false;
}

/** `b/path` from a `+++` header, or null for `/dev/null`. Git quotes unusual names C-style and ends names with spaces in a tab. */
function newPath(raw: string): string | null {
	const name = raw.replace(/\t$/, "");
	if (name === "/dev/null") return null;
	const unquoted = name.startsWith('"') && name.endsWith('"') ? unquote(name.slice(1, -1)) : name;
	return unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
}

const ESCAPES: Record<string, number> = {
	a: 7,
	b: 8,
	t: 9,
	n: 10,
	v: 11,
	f: 12,
	r: 13,
	'"': 34,
	"\\": 92,
};

/** Undoes git's C-style path quoting; octal escapes are UTF-8 bytes. */
function unquote(quoted: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < quoted.length; i++) {
		if (quoted[i] !== "\\") {
			const ch = String.fromCodePoint(quoted.codePointAt(i) as number);
			bytes.push(...Buffer.from(ch, "utf8"));
			i += ch.length - 1;
			continue;
		}
		const octal = /^[0-7]{3}/.exec(quoted.slice(i + 1));
		if (octal) {
			bytes.push(Number.parseInt(octal[0], 8));
			i += 3;
		} else {
			const next = quoted[i + 1] ?? "";
			bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
			i++;
		}
	}
	return Buffer.from(bytes).toString("utf8");
}
