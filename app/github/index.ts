/**
 * GitHub REST client, authenticated with a fine-grained PAT in GITHUB_TOKEN
 * scoped to the one repository in FACTORY_REPO.
 */
export { GitHub, githubFromEnv } from "./client.js";
export { GitHubHttp } from "./request.js";
export {
	GitHubError,
	type Issue,
	type IssueComment,
	type PullRequest,
	type RepoRef,
} from "./types.js";
