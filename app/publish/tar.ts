/**
 * Tar archive parser for git archive output.
 *
 * Supports POSIX ustar, pax extended headers (type 'x' — at least
 * `path` and `size`), pax global headers (type 'g' — skipped), and
 * GNU long names (type 'L'). No external dependency needed.
 *
 * tar is a sequence of 512-byte blocks. Each file starts with a header
 * block followed by ceil(size/512) content blocks.
 */

const BLOCK_SIZE = 512;

function readOctal(buf: Buffer, offset: number, length: number): number {
	const raw = buf.subarray(offset, offset + length);
	const str = raw.toString("ascii").replace(/\0.*$/, "").trim();
	return str.length > 0 ? Number.parseInt(str, 8) : 0;
}

function readString(buf: Buffer, offset: number, length: number): string {
	const end = buf.indexOf(0, offset);
	const actualEnd =
		end >= offset && end < offset + length ? end : offset + length;
	return buf.subarray(offset, actualEnd).toString("utf8");
}

/**
 * Parse pax extended header data. The format is:
 *   "<length> <key>=<value>\n"
 * where <length> is the decimal byte count of the entire record
 * including the length field, the space, and the trailing newline.
 */
export function parsePaxData(data: Buffer): Map<string, string> {
	const result = new Map<string, string>();
	const text = data.toString("utf8");
	let pos = 0;

	while (pos < text.length) {
		const spaceIdx = text.indexOf(" ", pos);
		if (spaceIdx === -1) break;

		const len = Number.parseInt(text.slice(pos, spaceIdx), 10);
		if (!Number.isFinite(len) || len <= 0) break;

		const record = text.slice(pos, pos + len);
		const eqIdx = record.indexOf("=");
		if (eqIdx !== -1) {
			const key = record.slice(spaceIdx - pos + 1, eqIdx);
			// Value excludes the trailing newline
			let value = record.slice(eqIdx + 1);
			if (value.endsWith("\n")) value = value.slice(0, -1);
			result.set(key, value);
		}

		pos += len;
	}

	return result;
}

export interface TarEntry {
	path: string;
	data: Buffer;
}

/** Parse a tar archive buffer into file entries. Directories are skipped. */
export function parseTar(archive: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;

	// State carried from a pax or GNU long-name header to the next entry
	let pendingPaxPath: string | undefined;
	let pendingPaxSize: number | undefined;
	let pendingGnuLongName: string | undefined;

	while (offset + BLOCK_SIZE <= archive.length) {
		const header = archive.subarray(offset, offset + BLOCK_SIZE);

		// Two consecutive zero blocks signal the end of the archive
		if (header.every((b) => b === 0)) break;

		const name = readString(header, 0, 100);
		const size = readOctal(header, 124, 12);
		const typeFlag = header[156];
		const prefix = readString(header, 345, 155);

		const headerPath = prefix ? `${prefix}/${name}` : name;

		offset += BLOCK_SIZE;
		const contentBlocks = Math.ceil(size / BLOCK_SIZE);

		// ── Pax extended header (type 'x', 0x78) ───────────────────
		if (typeFlag === 0x78) {
			if (size > 0 && offset + size <= archive.length) {
				const paxData = archive.subarray(offset, offset + size);
				const attrs = parsePaxData(paxData);
				if (attrs.has("path")) pendingPaxPath = attrs.get("path");
				if (attrs.has("size")) {
					pendingPaxSize = Number.parseInt(attrs.get("size") as string, 10);
				}
			}
			offset += contentBlocks * BLOCK_SIZE;
			continue;
		}

		// ── Pax global header (type 'g', 0x67) — skip ──────────────
		if (typeFlag === 0x67) {
			offset += contentBlocks * BLOCK_SIZE;
			continue;
		}

		// ── GNU long name (type 'L', 0x4c) ─────────────────────────
		if (typeFlag === 0x4c) {
			if (size > 0 && offset + size <= archive.length) {
				const raw = archive.subarray(offset, offset + size);
				// Strip trailing NUL
				const end = raw.indexOf(0);
				pendingGnuLongName =
					end >= 0
						? raw.subarray(0, end).toString("utf8")
						: raw.toString("utf8");
			}
			offset += contentBlocks * BLOCK_SIZE;
			continue;
		}

		// Resolve the effective path: pax > GNU long name > header
		const effectivePath = pendingPaxPath ?? pendingGnuLongName ?? headerPath;
		const effectiveSize = pendingPaxSize !== undefined ? pendingPaxSize : size;

		// Reset pending state — they apply only to the immediately next entry
		pendingPaxPath = undefined;
		pendingPaxSize = undefined;
		pendingGnuLongName = undefined;

		// Only extract regular files (type '0' or NUL)
		if (typeFlag === 0x30 || typeFlag === 0x00) {
			if (effectiveSize > 0 && offset + effectiveSize <= archive.length) {
				entries.push({
					path: effectivePath,
					data: Buffer.from(archive.subarray(offset, offset + effectiveSize)),
				});
			} else if (effectiveSize === 0) {
				entries.push({
					path: effectivePath,
					data: Buffer.alloc(0),
				});
			}
		}

		// Advance past the content blocks (using header size for block alignment)
		offset += contentBlocks * BLOCK_SIZE;
	}

	return entries;
}
