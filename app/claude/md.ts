/** Tagged template that strips leading indentation from an inline prompt. */
export function md(strings: TemplateStringsArray, ...values: unknown[]): string {
	const lines = String.raw(strings, ...values).split("\n");
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

	const indents = lines
		.filter((line) => line.trim().length > 0)
		.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0);
	const indent = indents.length > 0 ? Math.min(...indents) : 0;

	return indent > 0
		? lines.map((line) => line.slice(indent)).join("\n")
		: lines.join("\n");
}
