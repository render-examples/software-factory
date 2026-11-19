import { config } from "../config/index.js";
import { BODY_MAX_CHARS, codeSpan, fitAround, sanitize, sanitizeInline } from "./text.js";

export function triageQuestionsBody(questions: readonly string[]): string {
	const numbered = questions.map((q, i) => `${i + 1}. ${sanitizeInline(q)}`).join("\n");
	return fitAround(
		"The factory needs more detail before it can write a specification:\n\n",
		numbered,
		"\n\n**Next step:** reply to this issue with your answers, and the factory will continue.",
		BODY_MAX_CHARS,
	);
}

export function triageDeclineBody(rationale: string): string {
	return fitAround(
		"The factory declined this issue:\n\n",
		sanitize(rationale),
		`\n\nTo try again, apply the ${codeSpan(config.labels.triage)} label.`,
		BODY_MAX_CHARS,
	);
}
