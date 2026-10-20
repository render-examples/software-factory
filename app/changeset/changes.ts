import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const RAW_HEADER = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/;
const MAGIC = "software-factory-changes 1";
const WORKFLOWS_DIR = ".github/workflows/";

export type ChangeStatus = "A" | "M" | "D" | "T";

export interface ChangedFile {
	status: ChangeStatus;
	path: string;
	/** The new mode; "000000" for a deletion. */
	mode: string;
	/** The new blob SHA; null for a deletion. */
	sha: string | null;
}

export type RefusalReason =
	| { kind: "no_changes"; detail: string }
	| { kind: "too_many_files"; detail: string; count: number; limit: number }
	| {
			kind: "file_too_large";
			detail: string;
			path: string;
			bytes: number;
			limit: number;
	  }
	| {
			kind: "symlink" | "gitlink" | "workflow_file" | "unsafe_path";
			detail: string;
			path: string;
	  };

export interface PublishLimits {
	maxChangedFiles: number;
	maxFileBytes: number;
}

/** The sections of the file `collect-changes.sh` writes, split but not yet trusted. */
export interface ChangesFile {
	/** The sandbox's `git write-tree` of the staged working tree. */
	treeSha: string;
	count: number;
	diff: Buffer;
	sizes: Buffer;
	blobs: Buffer;
}

export type CheckedChanges =
	| { refused: RefusalReason[] }
	| { treeSha: string; files: ChangedFile[]; blobs: Map<string, Buffer> };

/** Git's object ID for a blob: sha1("blob <size>\0<content>"). */
export function blobSha(content: Buffer): string {
	return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Splits the output file into its sections. Throws on anything but the exact layout. */
export function parseChangesFile(buf: Buffer): ChangesFile {
	let pos = 0;
	const line = (): string => {
		const end = buf.indexOf(0x0a, pos);
		if (end < 0) throw new Error("Changes file is truncated");
		const text = buf.subarray(pos, end).toString("latin1");
		pos = end + 1;
		return text;
	};
	const field = (name: string): string => {
		const text = line();
		if (!text.startsWith(`${name} `)) throw new Error(`Changes file: expected "${name}", got "${text.slice(0, 60)}"`);
		return text.slice(name.length + 1);
	};
	const count = (name: string): number => {
		const text = field(name);
		if (!/^\d{1,15}$/.test(text)) throw new Error(`Changes file: invalid ${name} "${text.slice(0, 60)}"`);
		return Number(text);
	};
	const section = (name: string): Buffer => {
		const length = count(name);
		if (pos + length + 1 > buf.length || buf[pos + length] !== 0x0a)
			throw new Error(`Changes file: ${name} is truncated`);
		const data = buf.subarray(pos, pos + length);
		pos += length + 1;
		return data;
	};

	if (line() !== MAGIC) throw new Error("Changes file has an unknown format");
	const treeSha = field("tree");
	if (!SHA.test(treeSha)) throw new Error(`Changes file: invalid tree SHA "${treeSha.slice(0, 60)}"`);
	const file = {
		treeSha,
		count: count("count"),
		diff: section("diff"),
		sizes: section("sizes"),
		blobs: section("blobs"),
	};
	if (pos !== buf.length) throw new Error("Changes file has trailing data");
	return file;
}

/** Parses `git diff-tree -r -z --no-renames --no-abbrev` output strictly, keeping each path's raw bytes. */
function parseRawDiff(diff: Buffer): Array<ChangedFile & { rawPath: Buffer }> {
	const files: Array<ChangedFile & { rawPath: Buffer }> = [];
	let pos = 0;
	const field = (): Buffer => {
		const end = diff.indexOf(0, pos);
		if (end < 0) throw new Error("Diff ends in a partial record");
		const data = diff.subarray(pos, end);
		pos = end + 1;
		return data;
	};
	while (pos < diff.length) {
		const header = field().toString("latin1");
		const rawPath = field();
		const match = RAW_HEADER.exec(header);
		if (!match) throw new Error(`Malformed diff header "${header.slice(0, 120)}"`);
		const [, oldMode, newMode, oldSha, newSha, status] = match as unknown as [
			string,
			string,
			string,
			string,
			string,
			ChangeStatus,
		];
		if (rawPath.length === 0) throw new Error("Diff record with an empty path");
		if (status === "D") {
			if (newMode !== "000000" || newSha !== ZERO_SHA) throw new Error(`Malformed deletion "${header}"`);
		} else {
			if (!["100644", "100755", "120000", "160000"].includes(newMode) || newSha === ZERO_SHA) {
				throw new Error(`Malformed diff record "${header}"`);
			}
			if (status === "A" && (oldMode !== "000000" || oldSha !== ZERO_SHA))
				throw new Error(`Malformed addition "${header}"`);
		}
		files.push({
			status,
			path: rawPath.toString("utf8"),
			rawPath,
			mode: newMode,
			sha: status === "D" ? null : newSha,
		});
	}
	return files;
}

/** Parses "<sha> <size>\n" lines. */
function parseSizes(sizes: Buffer): Map<string, number> {
	const result = new Map<string, number>();
	const text = sizes.toString("latin1");
	if (text === "") return result;
	if (!text.endsWith("\n")) throw new Error("Sizes section is truncated");
	for (const line of text.slice(0, -1).split("\n")) {
		const match = /^([0-9a-f]{40}) (\d{1,15})$/.exec(line);
		if (!match?.[1] || !match[2] || result.has(match[1])) throw new Error(`Malformed size line "${line.slice(0, 80)}"`);
		result.set(match[1], Number(match[2]));
	}
	return result;
}

/** Parses `git cat-file --batch` output and checks every object's bytes against its SHA. */
function parseBlobs(blobs: Buffer, expected: ReadonlyMap<string, number>): Map<string, Buffer> {
	const result = new Map<string, Buffer>();
	let pos = 0;
	while (pos < blobs.length) {
		const end = blobs.indexOf(0x0a, pos);
		if (end < 0) throw new Error("Blob section is truncated");
		const header = blobs.subarray(pos, end).toString("latin1");
		const match = /^([0-9a-f]{40}) blob (\d{1,15})$/.exec(header);
		if (!match?.[1] || !match[2]) throw new Error(`Malformed blob header "${header.slice(0, 80)}"`);
		const sha = match[1];
		const size = Number(match[2]);
		if (expected.get(sha) !== size) throw new Error(`Unexpected blob ${sha} (${size} bytes)`);
		if (result.has(sha)) throw new Error(`Blob ${sha} appears twice`);
		const start = end + 1;
		if (start + size + 1 > blobs.length || blobs[start + size] !== 0x0a) throw new Error(`Blob ${sha} is truncated`);
		const content = blobs.subarray(start, start + size);
		if (blobSha(content) !== sha) throw new Error(`Blob hash mismatch for ${sha}`);
		result.set(sha, content);
		pos = start + size + 1;
	}
	for (const sha of expected.keys()) if (!result.has(sha)) throw new Error(`Blob ${sha} is missing`);
	return result;
}

/** Why a path can't be published, or null. Paths come from git, but the sandbox could forge them. */
function unsafePath(path: string, rawPath: Buffer): string | null {
	if (!Buffer.from(path, "utf8").equals(rawPath)) return "is not valid UTF-8";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(path)) return "contains a control character";
	if (path.startsWith("/")) return "is absolute";
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") return "has an empty, '.', or '..' segment";
		if (segment.toLowerCase() === ".git") return "is inside .git";
	}
	return null;
}

/**
 * Applies every publishing rule to the parsed file. Rules are re-derived here from the diff and sizes rather
 * than trusted from the sandbox; blob bytes are checked only when nothing is refused.
 */
export function checkChanges(file: ChangesFile, limits: PublishLimits): CheckedChanges {
	if (file.count > limits.maxChangedFiles) {
		const detail = `${file.count} files changed; the limit is ${limits.maxChangedFiles}`;
		return {
			refused: [
				{
					kind: "too_many_files",
					detail,
					count: file.count,
					limit: limits.maxChangedFiles,
				},
			],
		};
	}
	const files = parseRawDiff(file.diff);
	if (files.length !== file.count)
		throw new Error(`Diff has ${files.length} records but the sandbox counted ${file.count}`);
	if (files.length === 0)
		return {
			refused: [
				{
					kind: "no_changes",
					detail: "Nothing changed against the base commit",
				},
			],
		};

	const sizes = parseSizes(file.sizes);
	const needed = new Map<string, number>();
	const refused: RefusalReason[] = [];
	const seen = new Set<string>();
	for (const f of files) {
		if (seen.has(f.path)) throw new Error(`Diff lists ${f.path} twice`);
		seen.add(f.path);
		const unsafe = unsafePath(f.path, f.rawPath);
		if (unsafe) {
			refused.push({
				kind: "unsafe_path",
				detail: `Path ${JSON.stringify(f.path)} ${unsafe}`,
				path: f.path,
			});
			continue;
		}
		if (f.path.startsWith(WORKFLOWS_DIR)) {
			refused.push({
				kind: "workflow_file",
				detail: `Changes to ${f.path} are not published`,
				path: f.path,
			});
		}
		if (f.sha === null) continue;
		if (f.mode === "120000")
			refused.push({
				kind: "symlink",
				detail: `${f.path} is a symlink`,
				path: f.path,
			});
		if (f.mode === "160000")
			refused.push({
				kind: "gitlink",
				detail: `${f.path} is a submodule`,
				path: f.path,
			});
		if (f.mode !== "100644" && f.mode !== "100755") continue;
		const size = sizes.get(f.sha);
		if (size === undefined) throw new Error(`Sandbox reported no size for ${f.path}`);
		if (size > limits.maxFileBytes) {
			const detail = `${f.path} is ${size} bytes; the limit is ${limits.maxFileBytes}`;
			refused.push({
				kind: "file_too_large",
				detail,
				path: f.path,
				bytes: size,
				limit: limits.maxFileBytes,
			});
		}
		needed.set(f.sha, size);
	}
	if (refused.length > 0) return { refused };
	if (sizes.size !== needed.size) throw new Error("Sandbox reported sizes for blobs the diff doesn't use");
	if (needed.size > 0 && file.blobs.length === 0) throw new Error("Sandbox withheld blob contents without a refusal");

	return {
		treeSha: file.treeSha,
		files: files.map(({ rawPath: _, ...rest }) => rest),
		blobs: parseBlobs(file.blobs, needed),
	};
}
