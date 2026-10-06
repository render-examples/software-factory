import { factoryConfig } from "../../factory.config.js";

/** Comment body for when the triage agent asks clarifying questions. */
export function triageQuestionsComment(questions: string[]): string {
	const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
	return [
		"The factory needs more detail before it can write a specification:",
		"",
		numbered,
		"",
		"**Next step:** reply to this issue with the details above.",
	].join("\n");
}

/** Comment body for when triage declines the issue. */
export function triageDeclineComment(rationale: string): string {
	return [
		"The factory has declined this issue:",
		"",
		rationale,
		"",
		`To retry, reapply the \`${factoryConfig.labels.triage}\` or \`${factoryConfig.labels.fullRun}\` label.`,
	].join("\n");
}
