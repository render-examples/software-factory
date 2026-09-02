import { factoryConfig } from "../../factory.config.js";

const REPO_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export interface Repository {
	owner: string;
	repo: string;
	fullName: string;
}

export function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

export function repository(): Repository {
	const fullName = requireEnv("FACTORY_REPO");
	if (!REPO_PATTERN.test(fullName)) {
		throw new Error("FACTORY_REPO must use owner/repo format");
	}
	const [owner, repo] = fullName.split("/");
	if (repo === "." || repo === "..") {
		throw new Error("FACTORY_REPO must use owner/repo format");
	}
	return { owner, repo, fullName };
}

export function triggerLabel(): string {
	return process.env.FACTORY_LABEL?.trim() || "factory";
}

/** FACTORY_GITHUB_ACTORS overrides the checked-in list in factory.config.ts. */
export function allowedActors(): Set<string> {
	const override = process.env.FACTORY_GITHUB_ACTORS?.trim();
	const raw = override ? override.split(",") : factoryConfig.actors;
	const actors = new Set(
		raw.map((actor) => actor.trim().toLowerCase()).filter(Boolean),
	);
	if (actors.size === 0) {
		throw new Error(
			"No allowed actors. Set FACTORY_GITHUB_ACTORS or add actors to factory.config.ts",
		);
	}
	return actors;
}
