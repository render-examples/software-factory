/** Quote a string for safe use as a single POSIX shell argument. */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
