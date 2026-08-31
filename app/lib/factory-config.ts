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
 * A fixed actor list avoids carrying a general authorization model.
 */
export function factoryActors(): Set<string> {
  const actors = new Set(
    requireEnv("FACTORY_GITHUB_ACTORS")
      .split(",")
      .map((actor) => actor.trim().toLowerCase())
      .filter(Boolean),
  );
  if (actors.size === 0) throw new Error("FACTORY_GITHUB_ACTORS is empty");
  return actors;
}

export function assertGatewayConfig(): void {
  factoryRepository();
  factoryActors();
  requireEnv("GITHUB_WEBHOOK_SECRET");
  requireEnv("REDIS_URL");
  requireEnv("RENDER_WORKFLOW_SLUG");
}

export function assertWorkflowConfig(): void {
  factoryRepository();
  requireEnv("ANTHROPIC_API_KEY");
  requireEnv("GITHUB_TOKEN");
  requireEnv("REDIS_URL");
  requireEnv("RENDER_API_KEY");
  requireEnv("RENDER_WORKSPACE_ID");
}
