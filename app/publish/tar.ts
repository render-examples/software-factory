/**
 * Minimal tar archive parser for git archive output.
 *
 * tar is a sequence of 512-byte blocks. Each file starts with a header
 * block followed by ceil(size/512) content blocks. The header has:
 *   offset 0:   filename (100 bytes, NUL-terminated)
 *   offset 100: mode (8 bytes, octal)
 *   offset 124: size (12 bytes, octal NUL-terminated)
 *   offset 156: type flag (1 byte: '0' or '\0' = regular file, '5' = dir)
 *   offset 345: filename prefix (155 bytes for POSIX ustar)
 *
 * No external dependency needed: git archive produces standard POSIX tar.
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

export interface TarEntry {
	path: string;
	data: Buffer;
}

/** Parse a tar archive buffer into file entries. Directories are skipped. */
export function parseTar(archive: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;

	while (offset + BLOCK_SIZE <= archive.length) {
		const header = archive.subarray(offset, offset + BLOCK_SIZE);

		// Two consecutive zero blocks signal the end of the archive
		if (header.every((b) => b === 0)) break;

		const name = readString(header, 0, 100);
		const size = readOctal(header, 124, 12);
		const typeFlag = header[156];
		const prefix = readString(header, 345, 155);

		const fullPath = prefix ? `${prefix}/${name}` : name;

		offset += BLOCK_SIZE;

		// Only extract regular files (type '0' or NUL)
		if (typeFlag === 0x30 || typeFlag === 0x00) {
			if (size > 0 && offset + size <= archive.length) {
				entries.push({
					path: fullPath,
					data: Buffer.from(archive.subarray(offset, offset + size)),
				});
			} else if (size === 0) {
				entries.push({
					path: fullPath,
					data: Buffer.alloc(0),
				});
			}
		}

		// Advance past the content blocks
		const contentBlocks = Math.ceil(size / BLOCK_SIZE);
		offset += contentBlocks * BLOCK_SIZE;
	}

	return entries;
}
