import { config } from "../config/index.js";
import { type GitHubClient, PERMISSIONS, type Permission } from "../github/index.js";

export function permissionAtLeast(have: Permission, need: Permission): boolean {
	return PERMISSIONS.indexOf(have) >= PERMISSIONS.indexOf(need);
}

/** Whether the actor's live repository permission meets `need` (default: config.minimumPermission). */
export async function checkPermission(
	gh: Pick<GitHubClient, "getPermission">,
	actor: string,
	need: Permission = config.minimumPermission,
): Promise<boolean> {
	return permissionAtLeast(await gh.getPermission(actor), need);
}
