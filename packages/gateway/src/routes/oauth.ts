import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { OAuthStore, OAuthConnection } from "@render-agents/store";
import { encrypt, decrypt, encryptionKeyFromEnv } from "@render-agents/store";
import { getPrincipal } from "../auth.js";

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}

/** Token-endpoint response (subset we consume). */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface OAuthRouteDeps {
  providers: Map<string, OAuthProviderConfig>;
  baseUrl: string;
  oauthStore: OAuthStore;
  /** Injectable fetch for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * OAuth routes: authorize → callback (real code→token exchange, encrypted at
 * rest) → revoke. State is HMAC-signed (with the encryption key) and verified
 * in constant time. Connections are per-user (the `userId` rides in the signed
 * state), satisfying multi-tenancy.
 */
export function oauthRoutes(deps: OAuthRouteDeps) {
  const app = new Hono();
  const { providers, baseUrl, oauthStore } = deps;
  const doFetch: typeof fetch = deps.fetchImpl ?? fetch;

  // GET /oauth/:provider/authorize — initiate the OAuth flow for the caller.
  // The userId comes from auth and is bound into the signed state, so a caller
  // can only connect a provider to their own account (CR-D1).
  app.get("/oauth/:provider/authorize", async (c) => {
    const provider = c.req.param("provider");
    const config = providers.get(provider);
    if (!config) {
      return c.json({ error: `OAuth provider "${provider}" not configured` }, 404);
    }
    const { userId } = getPrincipal(c);

    const state = signState({ provider, userId, nonce: randomBytes(8).toString("hex"), ts: Date.now() });
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

  // GET /oauth/:provider/callback — exchange code for tokens, persist encrypted
  app.get("/oauth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return c.json({ error: "Missing code or state parameter" }, 400);
    }
    const verified = verifyState(state, provider);
    if (!verified) {
      return c.json({ error: "Invalid or expired state" }, 403);
    }

    const config = providers.get(provider);
    if (!config) {
      return c.json({ error: `OAuth provider "${provider}" not configured` }, 404);
    }

    const redirectUri = `${baseUrl}/oauth/${provider}/callback`;
    let tokens: TokenResponse;
    try {
      tokens = await exchangeCode(doFetch, config, code, redirectUri);
    } catch (err) {
      return c.json({ error: `Token exchange failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }

    const now = new Date().toISOString();
    const conn: OAuthConnection = {
      id: `${verified.userId}:${provider}`,
      userId: verified.userId,
      provider,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
      scopes: tokens.scope ? tokens.scope.split(/\s+/) : config.scopes,
      createdAt: now,
      updatedAt: now,
    };
    await oauthStore.upsertConnection(conn);

    return c.json({ status: "connected", provider, userId: verified.userId });
  });

  // DELETE /oauth/:provider — revoke the caller's stored connection. userId is
  // from auth, so a caller can only revoke their own connection (CR-D1).
  app.delete("/oauth/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!providers.has(provider)) {
      return c.json({ error: `OAuth provider "${provider}" not configured` }, 404);
    }
    const { userId } = getPrincipal(c);
    await oauthStore.deleteConnection(userId, provider);
    return c.json({ status: "revoked", provider, userId });
  });

  return app;
}

/** Bound provider HTTP calls so a hung endpoint can't stall a run (or, for
 * refresh, hold the `SELECT … FOR UPDATE` row lock) indefinitely. */
const TOKEN_HTTP_TIMEOUT_MS = 10_000;

/**
 * Build a token refresher for a provider config: exchanges the stored refresh
 * token for fresh tokens at the provider's token endpoint. Registered into
 * `runtime.oauthRefreshers` so the loop can refresh expired tokens mid-run.
 *
 * Single-flight coordination is the store's job (`OAuthStore.refreshConnection`
 * uses `SELECT … FOR UPDATE`, holding the row lock across this call). The timeout
 * bounds how long that lock is held if the provider is slow/unresponsive.
 */
export function buildRefresher(config: OAuthProviderConfig, fetchImpl: typeof fetch = fetch) {
  return async (conn: OAuthConnection) => {
    if (!conn.refreshToken) throw new Error(`No refresh token for provider "${conn.provider}"`);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    const res = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
    const tokens = (await res.json()) as TokenResponse;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? conn.refreshToken,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
    };
  };
}

async function exchangeCode(
  fetchImpl: typeof fetch,
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) throw new Error("token endpoint did not return an access_token");
  return json;
}

// --- Token encryption helpers (re-exported AES-256-GCM from the store) ---

/** @deprecated import `encrypt` from `@render-agents/store`. Kept for back-compat. */
export const encryptToken = encrypt;
/** @deprecated import `decrypt` from `@render-agents/store`. Kept for back-compat. */
export const decryptToken = decrypt;

// --- HMAC-signed state (constant-time verification) ---

interface StatePayload {
  provider: string;
  userId: string;
  nonce: string;
  ts: number;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function stateSecret(): Buffer {
  return encryptionKeyFromEnv();
}

function signState(payload: StatePayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", stateSecret()).update(data).digest("hex");
  return `${data}.${mac}`;
}

function verifyState(state: string, expectedProvider: string): StatePayload | null {
  const [data, mac] = state.split(".");
  if (!data || !mac) return null;
  const expected = createHmac("sha256", stateSecret()).update(data).digest("hex");
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as StatePayload;
    if (payload.provider !== expectedProvider) return null;
    if (Date.now() - payload.ts > STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}
