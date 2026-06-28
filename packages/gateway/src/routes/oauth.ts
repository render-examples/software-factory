import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Hono } from "hono";

const ALGORITHM = "aes-256-gcm";

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * OAuth routes: authorize, callback, revoke.
 * Tokens are encrypted at rest with AES-256-GCM.
 */
export function oauthRoutes(deps: {
  providers: Map<string, OAuthProviderConfig>;
  baseUrl: string;
}) {
  const app = new Hono();
  const { providers, baseUrl } = deps;

  // GET /oauth/:provider/authorize — initiate OAuth flow
  app.get("/oauth/:provider/authorize", async (c) => {
    const provider = c.req.param("provider");
    const config = providers.get(provider);
    if (!config) {
      return c.json({ error: `OAuth provider "${provider}" not configured` }, 404);
    }

    const state = signState({ provider, ts: Date.now() });
    const redirectUri = `${baseUrl}/oauth/${provider}/callback`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scopes.join(" "),
      state,
    });

    return c.redirect(`${config.authorizeUrl}?${params.toString()}`);
  });

  // GET /oauth/:provider/callback — exchange code for tokens
  app.get("/oauth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return c.json({ error: "Missing code or state parameter" }, 400);
    }

    if (!verifyState(state, provider)) {
      return c.json({ error: "Invalid or expired state" }, 403);
    }

    const config = providers.get(provider);
    if (!config) {
      return c.json({ error: `OAuth provider "${provider}" not configured` }, 404);
    }

    // Token exchange would happen here in production
    return c.json({ status: "connected", provider });
  });

  // DELETE /oauth/:provider — revoke connection
  app.delete("/oauth/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!providers.has(provider)) {
      return c.json({ error: `OAuth provider "${provider}" not configured` }, 404);
    }
    return c.json({ status: "revoked", provider });
  });

  return app;
}

// --- Encryption helpers ---

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptToken(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted token format");
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = Buffer.from(parts[2], "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function signState(payload: Record<string, unknown>): string {
  const secret = process.env.RENDER_AGENTS_ENCRYPTION_KEY ?? "default-dev-key";
  const data = JSON.stringify(payload);
  const hmac = createHash("sha256").update(`${secret}:${data}`).digest("hex");
  return `${Buffer.from(data).toString("base64url")}.${hmac}`;
}

function verifyState(state: string, expectedProvider: string): boolean {
  const secret = process.env.RENDER_AGENTS_ENCRYPTION_KEY ?? "default-dev-key";
  const [dataB64, hmac] = state.split(".");
  if (!dataB64 || !hmac) return false;
  const data = Buffer.from(dataB64, "base64url").toString("utf8");
  const expectedHmac = createHash("sha256").update(`${secret}:${data}`).digest("hex");
  if (hmac !== expectedHmac) return false;
  try {
    const payload = JSON.parse(data);
    return payload.provider === expectedProvider;
  } catch {
    return false;
  }
}
