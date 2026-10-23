/** GitHub rejects an issue comment, PR body, or review body longer than this. */
export const COMMENT_MAX_CHARS = 65_536;
/** Default budget for a rendered body, leaving room for the hidden markers the caller appends. */
export const BODY_MAX_CHARS = 60_000;

const ZERO_WIDTH_SPACE = "\u200B";
const ZERO_WIDTH_JOINER = "\u200D";
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Breaks every `<!--` so model text can't open an HTML comment that hides content or looks like a factory
 * marker. Applies inside code too: marker lookups scan the raw body.
 */
export function neutralizeMarkers(text: string): string {
	return text.replaceAll("<!--", `<${ZERO_WIDTH_SPACE}!--`);
}

/** An @ GitHub would read as a mention: not inside a word, an email address, a path, or a URL, and followed by a handle. */
const MENTION = /(?<![A-Za-z0-9_.\-/@])@(?=[A-Za-z0-9])/g;

/**
 * Inserts a zero-width joiner after each @ that would mention a user or team, so model text never pings
 * anyone. Fenced code blocks are left alone (GitHub doesn't mention from them, and code is copied from them);
 * inline code is neutralized too, since a stray backtick elsewhere can change where a span ends.
 */
export function neutralizeMentions(text: string): string {
	return mapOutsideFences(text, (prose) => prose.replace(MENTION, `@${ZERO_WIDTH_JOINER}`));
}

/** Model-written Markdown, made safe to place in a factory comment as a block: fences closed, markers and mentions neutralized. */
export function sanitize(text: string): string {
	return neutralizeMentions(neutralizeMarkers(closeFences(text.trim())));
}

/** Model-written text for one line (a list item, a title, a table cell): whitespace collapsed, markers and mentions neutralized. */
export function sanitizeInline(text: string): string {
	return neutralizeMarkers(text.replace(/\s+/g, " ").trim()).replace(MENTION, `@${ZERO_WIDTH_JOINER}`);
}

/** `text` as an inline code span, with a delimiter longer than any backtick run inside it. Markers and mentions neutralized. */
export function codeSpan(text: string): string {
	const inner = sanitizeInline(text);
	const longest = Math.max(0, ...(inner.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return longest > 0 || inner.startsWith(" ") ? `${fence} ${inner} ${fence}` : `${fence}${inner}${fence}`;
}

/** `text` verbatim in a fenced block whose fence is longer than any backtick run inside it, so it can't close early. */
export function fenced(text: string, lang = ""): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${lang}\n${text}\n${fence}`;
}

/** Splits `text` into fenced code blocks and the prose between them, and maps only the prose. */
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
		const open = FENCE_OPEN.exec(line);
		if (open && !(open[1]?.startsWith("`") && line.slice(open[0].length).includes("`"))) {
			flush();
			fence = open[1];
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flush();
	return out.join("\n");
}

function closesFence(line: string, fence: string): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
	return !!match?.[1] && match[1][0] === fence[0] && match[1].length >= fence.length;
}

/** The fence a block of Markdown leaves open at its end, if any. */
function openFence(text: string): string | undefined {
	let fence: string | undefined;
	for (const line of text.split("\n")) {
		if (fence) {
			if (closesFence(line, fence)) fence = undefined;
			continue;
		}
		const open = FENCE_OPEN.exec(line);
		if (open && !(open[1]?.startsWith("`") && line.slice(open[0].length).includes("`"))) fence = open[1];
	}
	return fence;
}

/** Closes a fenced code block left open at the end, so it can't swallow what follows. */
export function closeFences(text: string): string {
	const fence = openFence(text);
	return fence ? `${text}\n${fence}` : text;
}

/**
 * Cuts `text` to at most `max` characters, at a line break when one is near, closing any fence the cut leaves
 * open and appending `notice`. Never splits a surrogate pair.
 */
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

/** Joins a fixed head and tail around a variable middle, truncating only the middle so the whole fits in `max`. */
export function fitAround(head: string, middle: string, tail: string, max: number): string {
	const room = max - head.length - tail.length;
	return `${head}${truncate(middle, Math.max(0, room))}${tail}`;
}

/** A Markdown bullet list of inline-sanitized items. */
export function bullets(items: readonly string[]): string {
	return items.map((item) => `- ${sanitizeInline(item)}`).join("\n");
}
