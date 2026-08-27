import { createSign } from "node:crypto";

/**
 * GitHub App installation token minting.
 *
 * Generates a short-lived JWT from the app's private key, then exchanges it
 * for an installation access token (1hr TTL). Tokens are cached and reused
 * until 5 minutes before expiry.
 */

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const TOKEN_CACHE = new Map<string, CachedToken>();
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export async function getInstallationToken(config: GitHubAppConfig): Promise<string> {
  const cacheKey = `${config.appId}:${config.installationId}`;
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()) {
    return cached.token;
  }

  const jwt = generateJwt(config.appId, config.privateKey);
  const token = await mintInstallationToken(jwt, config.installationId);

  TOKEN_CACHE.set(cacheKey, {
    token: token.token,
    expiresAt: new Date(token.expiresAt).getTime(),
  });

  return token.token;
}

function generateJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];
  const signingInput = segments.join(".");

  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

async function mintInstallationToken(
  jwt: string,
  installationId: string,
): Promise<{ token: string; expiresAt: string }> {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub App token mint failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

function base64url(str: string): string {
  return Buffer.from(str, "utf-8")
    .toString("base64url");
}
