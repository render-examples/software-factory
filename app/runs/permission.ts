import { config } from "../config/index.js";
import { type GitHubClient, PERMISSIONS } from "../github/index.js";

export async function checkPermission(gh: Pick<GitHubClient, "getPermission">, actor: string): Promise<boolean> {
	const have = await gh.getPermission(actor);
	return PERMISSIONS.indexOf(have) >= PERMISSIONS.indexOf(config.minimumPermission);
}
