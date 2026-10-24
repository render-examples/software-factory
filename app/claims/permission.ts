import { config } from "../config/index.js";
import { type GitHubClient, PERMISSIONS } from "../github/index.js";

/** Whether the actor's live repository permission meets `config.minimumPermission`. */
export async function checkPermission(gh: Pick<GitHubClient, "getPermission">, actor: string): Promise<boolean> {
	const have = await gh.getPermission(actor);
	return PERMISSIONS.indexOf(have) >= PERMISSIONS.indexOf(config.minimumPermission);
}
