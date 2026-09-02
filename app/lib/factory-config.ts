import { factoryConfig } from "../../factory.config.js";

const FACTORY_REPO_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export interface FactoryRepository {
  owner: string;
  repo: string;
  fullName: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The single repository this factory is allowed to read and modify. */
export function factoryRepository(): FactoryRepository {
  const fullName = requireEnv("FACTORY_REPO");
  if (!FACTORY_REPO_PATTERN.test(fullName)) {
    throw new Error("FACTORY_REPO must use owner/repo format");
  }
  const [owner, repo] = fullName.split("/");
  if (repo === "." || repo === "..") {
    throw new Error("FACTORY_REPO must use owner/repo format");
  }
  return { owner, repo, fullName };
}

/** The maintainer-applied label that starts an unattended factory run. */
export function factoryLabel(): string {
  return process.env.FACTORY_LABEL?.trim() || "factory";
}

/**
 * GitHub logins allowed to hand work to the demo factory.
 * Reads from factory.config.ts; FACTORY_GITHUB_ACTORS env var overrides.
 */
export function factoryActors(): Set<string> {
  const envValue = process.env.FACTORY_GITHUB_ACTORS?.trim();
  let raw: string[];
  if (envValue) {
    raw = envValue.split(",");
  } else if (
    Array.isArray(factoryConfig.actors) &&
    factoryConfig.actors.length > 0
  ) {
    raw = factoryConfig.actors;
  } else {
    throw new Error(
      "No allowed actors configured. Set FACTORY_GITHUB_ACTORS or add actors to factory.config.ts",
    );
  }
  const actors = new Set(
    raw.map((actor) => actor.trim().toLowerCase()).filter(Boolean),
  );
  if (actors.size === 0) {
    throw new Error("Allowed actors list resolved to empty");
  }
  return actors;
}

export function assertGatewayConfig(): void {
  factoryRepository();
  factoryActors();
  requireEnv("GITHUB_WEBHOOK_SECRET");
  requireEnv("DATABASE_URL");
  requireEnv("RENDER_WORKFLOW_SLUG");
}

export function assertWorkflowConfig(): void {
  factoryRepository();
  requireEnv("ANTHROPIC_API_KEY");
  requireEnv("GITHUB_TOKEN");
  requireEnv("DATABASE_URL");
  requireEnv("RENDER_API_KEY");
  requireEnv("RENDER_WORKSPACE_ID");
}
