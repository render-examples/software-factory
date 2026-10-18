import { config } from "../config/index.js";
import { BODY_MAX_CHARS, codeSpan, fitAround, sanitize, sanitizeInline } from "./text.js";

/** The comment body when triage asks the maintainer questions. */
export function triageQuestionsBody(questions: readonly string[], maxChars = BODY_MAX_CHARS): string {
	const numbered = questions.map((q, i) => `${i + 1}. ${sanitizeInline(q)}`).join("\n");
	return fitAround(
		"The factory needs more detail before it can write a specification:\n\n",
		numbered,
		"\n\n**Next step:** reply to this issue with your answers, and the factory will continue.",
		maxChars,
	);
}

/** The comment body when triage declines the issue. */
export function triageDeclineBody(rationale: string, maxChars = BODY_MAX_CHARS): string {
	return fitAround(
		"The factory declined this issue:\n\n",
		sanitize(rationale),
		`\n\nTo try again, remove and reapply the ${codeSpan(config.labels.triage)} label.`,
		maxChars,
	);
}
