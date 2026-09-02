export function clarificationComment(
	questions: string[],
	label: string,
): string {
	const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
	return `The factory needs more detail before it can proceed:\n\n${numbered}\n\nReply with the details, then reapply the \`${label}\` label.`;
}

export function noChangesComment(label: string): string {
	return `The factory produced no repository changes. Reapply the \`${label}\` label to retry.`;
}

export function verifyFailedComment(
	failures: string,
	rounds: number,
	label: string,
): string {
	return `The factory could not pass verification after ${rounds} fix rounds:\n\n\`\`\`\n${failures.slice(0, 3000)}\n\`\`\`\n\nReapply the \`${label}\` label to retry.`;
}

export function changesRequestedComment(
	summary: string,
	label: string,
): string {
	return `The factory stopped after its revision still needed changes:\n\n${summary}\n\nReapply the \`${label}\` label after updating the issue or repository.`;
}

export function draftPrComment(pullUrl: string): string {
	return `The factory opened a reviewed draft pull request: ${pullUrl}`;
}
