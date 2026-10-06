/** Issue comment templates for spec-to-pr outcomes. */

export function noSpecComment(): string {
	return "No specification was found for this issue. Apply `factory:triage` first to generate one, then approve it with `factory:spec-approved`.";
}

export function approvalRefusedComment(detail: string): string {
	return `The spec version could not be approved: ${detail}\n\nApply \`factory:triage\` to update the spec, then reapply \`factory:spec-approved\`.`;
}

export function noChangesComment(): string {
	return "The factory produced no repository changes. Reapply `factory:spec-approved` to retry.";
}

export function verifyFailedComment(failures: string, rounds: number): string {
	const redacted = failures.slice(0, 3000);
	return `The factory could not pass verification after ${rounds} fix rounds:\n\n\`\`\`\n${redacted}\n\`\`\`\n\nReapply \`factory:spec-approved\` to retry.`;
}

export function publishRefusedComment(detail: string): string {
	return `Publishing was refused: ${detail}\n\nReapply \`factory:spec-approved\` after addressing the issue.`;
}

export function draftPrComment(pullUrl: string): string {
	return `The factory opened a draft pull request: ${pullUrl}`;
}
