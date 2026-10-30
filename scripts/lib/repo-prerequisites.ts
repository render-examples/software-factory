import { z } from "zod";
import type { GitHubApp } from "./github.js";
import type { Reporter } from "./output.js";

const metadataSchema = z.object({ full_name: z.string().min(1), has_issues: z.boolean(), archived: z.boolean() });
const branchSchema = z.object({ name: z.string().min(1), commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }) });

/** Read-only repository capabilities, shared by preflight and the deployed-value doctor. */
export async function checkRepositoryPrerequisites(
	repo: ReturnType<GitHubApp["repo"]>,
	fullName: string,
	baseBranch: string | undefined,
	out: Reporter,
): Promise<void> {
	try {
		const metadata = metadataSchema.safeParse(await repo.metadata());
		if (!metadata.success || metadata.data.full_name.toLowerCase() !== fullName.toLowerCase()) {
			out.fail(`${fullName}: repository metadata is invalid; Issues availability is unverified`, "Check repository access and retry preflight");
			return;
		}
		if (metadata.data.has_issues) out.pass(`${fullName}: Issues is enabled`);
		else out.fail(`${fullName}: Issues is disabled`, "A repository admin must enable Settings > General > Features > Issues before deployment");
		if (metadata.data.archived) out.fail(`${fullName}: repository is archived`, "Choose an active repository or ask its owner to unarchive it");
	} catch {
		out.fail(`${fullName}: repository capabilities could not be verified`, "Check the App installation's repository access and retry");
		return;
	}
	if (baseBranch === undefined) return;
	if (!baseBranch.trim()) {
		out.fail(`${fullName}: baseBranch is empty`, "Set an existing baseBranch in factory.config.ts");
		return;
	}
	try {
		const branch = branchSchema.safeParse(await repo.branch(baseBranch));
		if (!branch.success || branch.data.name !== baseBranch) {
			out.fail(`${fullName}: base branch ${baseBranch} could not be verified`, "Check baseBranch in factory.config.ts and repository access");
		} else out.pass(`${fullName}: base branch ${baseBranch} is accessible`);
	} catch {
		out.fail(
			`${fullName}: base branch ${baseBranch} is missing or inaccessible`,
			"Check baseBranch in factory.config.ts and the App's Contents access",
		);
	}
}
