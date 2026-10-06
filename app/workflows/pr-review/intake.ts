import type { GitHub, RepoRef } from "../../github/index.js";
import { getPull, getPullDiff, type PullDetail } from "../../github/index.js";
import type { GitHubHttp } from "../../github/request.js";

export interface IntakeResult {
	pull: PullDetail;
	diff: string;
	specContext: string | null;
}

/**
 * Load the PR, its diff, and any spec context from the PR body marker.
 * The spec marker format: <!-- render-factory:pr run=... spec=<id> v=<n> -->
 */
export async function intake(
	_gh: GitHub,
	http: GitHubHttp,
	ref: RepoRef,
	prNumber: number,
): Promise<IntakeResult> {
	const pull = await getPull(http, ref, prNumber);
	const diff = await getPullDiff(http, ref, prNumber);

	let specContext: string | null = null;
	const markerMatch = pull.body.match(
		/<!-- render-factory:pr run=\S+ spec=(\S+) v=(\d+) -->/,
	);
	if (markerMatch) {
		specContext = `Spec ID: ${markerMatch[1]}, version: ${markerMatch[2]}`;
	}
	if (!specContext && pull.body.length > 0) {
		specContext = pull.body.slice(0, 5000);
	}

	return { pull, diff, specContext };
}
