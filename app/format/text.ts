export const COMMENT_MAX_CHARS = 65_536;
export const BODY_MAX_CHARS = 60_000;

const ZERO_WIDTH_SPACE = "\u200B";
const ZERO_WIDTH_JOINER = "\u200D";
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function neutralizeMarkers(text: string): string {
	return text.replaceAll("<!--", `<${ZERO_WIDTH_SPACE}!--`);
}

const MENTION = /(?<![A-Za-z0-9_.\-/@])@(?=[A-Za-z0-9])/g;

function neutralizeMentions(text: string): string {
	return mapOutsideFences(text, (prose) => prose.replace(MENTION, `@${ZERO_WIDTH_JOINER}`));
}

export function sanitize(text: string): string {
	return neutralizeMentions(neutralizeMarkers(closeFences(text.trim())));
}

export function sanitizeInline(text: string): string {
	return neutralizeMarkers(text.replace(/\s+/g, " ").trim()).replace(MENTION, `@${ZERO_WIDTH_JOINER}`);
}

export function verbatimCodeSpan(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return longest > 0 || text.startsWith(" ") ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

export function codeSpan(text: string): string {
	return verbatimCodeSpan(sanitizeInline(text));
}

export function fenced(text: string, lang = ""): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${lang}\n${text}\n${fence}`;
}

function mapOutsideFences(text: string, fn: (prose: string) => string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let prose: string[] = [];
	let fence: string | undefined;
	const flush = () => {
		if (prose.length > 0) out.push(fn(prose.join("\n")));
		prose = [];
	};
	for (const line of lines) {
		if (fence) {
			out.push(line);
			if (closesFence(line, fence)) fence = undefined;
			continue;
		}
		fence = opensFence(line);
		if (fence) {
			flush();
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flush();
	return out.join("\n");
}

function opensFence(line: string): string | undefined {
	const open = FENCE_OPEN.exec(line);
	if (!open?.[1] || (open[1].startsWith("`") && line.slice(open[0].length).includes("`"))) return undefined;
	return open[1];
}

function closesFence(line: string, fence: string): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
	return !!match?.[1] && match[1][0] === fence[0] && match[1].length >= fence.length;
}

function openFence(text: string): string | undefined {
	let fence: string | undefined;
	for (const line of text.split("\n")) {
		if (!fence) fence = opensFence(line);
		else if (closesFence(line, fence)) fence = undefined;
	}
	return fence;
}

function closeFences(text: string): string {
	const fence = openFence(text);
	return fence ? `${text}\n${fence}` : text;
}

export function truncate(text: string, max: number, notice = "\n\n_(truncated)_"): string {
	if (text.length <= max) return text;
	const budget = max - notice.length - 8;
	if (budget <= 0) return text.slice(0, Math.max(0, max));
	let cut = budget;
	const newline = text.lastIndexOf("\n", cut);
	if (newline > budget * 0.8) cut = newline;
	if (/[\uD800-\uDBFF]/.test(text.charAt(cut - 1))) cut--;
	let kept = text.slice(0, cut).trimEnd();
	const fence = openFence(kept);
	if (fence) kept = `${kept}\n${fence}`;
	const result = `${kept}${notice}`;
	return result.length <= max ? result : result.slice(0, max);
}

export function fitAround(head: string, middle: string, tail: string, max: number): string {
	const room = max - head.length - tail.length;
	return `${head}${truncate(middle, Math.max(0, room))}${tail}`;
}

export function bullets(items: readonly string[]): string {
	return items.map((item) => `- ${sanitizeInline(item)}`).join("\n");
}
