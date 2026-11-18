import { type Review, type ReviewComment, SEVERITIES, type Severity } from "../schemas/index.js";
import { type VerifyResult, verificationTable } from "./pull-request.js";
import { BODY_MAX_CHARS, codeSpan, fitAround, sanitize, sanitizeInline } from "./text.js";

const MAX_INLINE_COMMENTS = 50;
const INLINE_BODY_MAX_CHARS = 8_000;

const REVIEW_EVENT = "COMMENT";

export interface InlineComment {
	path: string;
	line: number;
	side: "RIGHT";
	body: string;
}

export interface ReviewPayload {
	event: typeof REVIEW_EVENT;
	body: string;
	comments: InlineComment[];
}

export interface RenderReviewOptions {
	verification?: readonly VerifyResult[];
	isCommentable?: (file: string, line: number) => boolean;
}

const rank = (severity: Severity) => SEVERITIES.indexOf(severity);
const label = (severity: Severity) => severity.charAt(0).toUpperCase() + severity.slice(1);

export function renderReview(review: Review, opts: RenderReviewOptions = {}): ReviewPayload {
	const sorted = review.comments
		.map((comment, index) => ({ comment, index }))
		.sort((a, b) => rank(a.comment.severity) - rank(b.comment.severity) || a.index - b.index);

	const inline: ReviewComment[] = [];
	const overflow: ReviewComment[] = [];
	for (const { comment } of sorted) {
		const placeable = opts.isCommentable ? opts.isCommentable(comment.file, comment.line) : true;
		if (placeable && inline.length < MAX_INLINE_COMMENTS) inline.push(comment);
		else overflow.push(comment);
	}

	const counts = SEVERITIES.map((s) => [s, review.comments.filter((c) => c.severity === s).length] as const)
		.filter(([, n]) => n > 0)
		.map(([s, n]) => `${n} ${s}`);
	const findings = counts.length > 0 ? counts.join(", ") : "none";
	const head = `## Factory review\n\n**Risk:** ${review.riskTier} · **Findings:** ${findings} · **Inline comments:** ${inline.length}\n\n`;

	const sections: string[] = [sanitize(review.summary)];
	if (opts.verification) sections.push(`### Verification\n\n${verificationTable(opts.verification)}`);
	if (overflow.length > 0) {
		const items = overflow.map((c) => `- **${label(c.severity)}** ${codeSpan(`${c.file}:${c.line}`)}: ${sanitizeInline(c.title)}`);
		sections.push(`### More findings\n\nThese couldn't be placed as inline comments.\n\n${items.join("\n")}`);
	}

	const tail = "\n\n---\n\n_The factory reviews by comment only. It never approves or requests changes; a person decides._";
	return {
		event: REVIEW_EVENT,
		body: fitAround(head, sections.join("\n\n"), tail, BODY_MAX_CHARS),
		comments: inline.map((c) => ({ path: c.file, line: c.line, side: "RIGHT", body: inlineBody(c) })),
	};
}

function inlineBody(comment: ReviewComment): string {
	return fitAround(`**${label(comment.severity)}**: ${sanitizeInline(comment.title)}\n\n`, sanitize(comment.body), "", INLINE_BODY_MAX_CHARS);
}
