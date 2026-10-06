import type { SynthesisComment } from "../../contracts/index.js";

interface DiffHunk {
	path: string;
	/** Right-side (new file) start line. */
	newStart: number;
	/** Number of lines on the right side. */
	newCount: number;
}

/** Parse unified diff into hunks with right-side line ranges. */
export function parseDiffHunks(diff: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let currentPath = "";

	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ b/")) {
			currentPath = line.slice(6);
		} else if (line.startsWith("@@ ")) {
			const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
			if (match && currentPath) {
				hunks.push({
					path: currentPath,
					newStart: Number(match[1]),
					newCount: Number(match[2] ?? 1),
				});
			}
		}
	}
	return hunks;
}

/** Check if a line falls inside a hunk on the right (new) side. */
function isLineInHunk(path: string, line: number, hunks: DiffHunk[]): boolean {
	return hunks.some(
		(h) =>
			h.path === path && line >= h.newStart && line < h.newStart + h.newCount,
	);
}

export interface ValidatedComments {
	valid: SynthesisComment[];
	invalid: SynthesisComment[];
}

/**
 * Validate inline comment positions against the diff hunks.
 * Comments outside any hunk on the right side are moved to invalid.
 */
export function validateCommentPositions(
	comments: readonly SynthesisComment[],
	diff: string,
): ValidatedComments {
	const hunks = parseDiffHunks(diff);
	const valid: SynthesisComment[] = [];
	const invalid: SynthesisComment[] = [];

	for (const comment of comments) {
		if (isLineInHunk(comment.path, comment.line, hunks)) {
			valid.push(comment);
		} else {
			invalid.push(comment);
		}
	}

	return { valid, invalid };
}
