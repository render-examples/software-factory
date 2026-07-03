import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import { jwtAuthResolver } from "../src/jwt-auth.js";

const ISSUER = "https://issuer.test";
const AUDIENCE = "render-agents";
const KID = "test-key";

let privateKey: CryptoKey;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
});

/** Mint a signed JWT with overridable issuer/audience/expiry. */
async function mint(
  claims: Record<string, unknown>,
  over: { iss?: string; aud?: string; expSec?: number; iatSec?: number } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt(over.iatSec)
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUDIENCE);
  jwt.setExpirationTime(over.expSec ?? "2m");
  return jwt.sign(privateKey);
}

function bearer(token: string): Request {
  return new Request("http://x/runs", { headers: { authorization: `Bearer ${token}` } });
}

describe("jwtAuthResolver", () => {
  it("verifies a valid token and maps sub -> userId (role: user)", async () => {
    const resolve = jwtAuthResolver({ issuer: ISSUER, audience: AUDIENCE, keySet });
    const token = await mint({ sub: "alice" });
    expect(await resolve(bearer(token))).toEqual({ userId: "alice", role: "user" });
  });

  it("maps a custom userId claim", async () => {
    const resolve = jwtAuthResolver({ issuer: ISSUER, audience: AUDIENCE, keySet, userIdClaim: "uid" });
    const token = await mint({ sub: "ignored", uid: "u-42" });
    expect(await resolve(bearer(token))).toEqual({ userId: "u-42", role: "user" });
  });

  it("elevates to operator via roleFrom", async () => {
    const resolve = jwtAuthResolver({
      issuer: ISSUER,
      audience: AUDIENCE,
      keySet,
      roleFrom: (c) => (c.admin === true ? "operator" : "user"),
    });
    expect(await resolve(bearer(await mint({ sub: "root", admin: true })))).toEqual({ userId: "root", role: "operator" });
    expect(await resolve(bearer(await mint({ sub: "joe", admin: false })))).toEqual({ userId: "joe", role: "user" });
  });

  it("rejects a wrong issuer, wrong audience, expired, tampered, or non-bearer (fail closed -> null)", async () => {
    const resolve = jwtAuthResolver({ issuer: ISSUER, audience: AUDIENCE, keySet });
    const nowSec = Math.floor(Date.now() / 1000);

    expect(await resolve(bearer(await mint({ sub: "a" }, { iss: "https://evil.test" })))).toBeNull();
    expect(await resolve(bearer(await mint({ sub: "a" }, { aud: "someone-else" })))).toBeNull();
    // Expired well beyond the default 5s clock tolerance.
    expect(await resolve(bearer(await mint({ sub: "a" }, { iatSec: nowSec - 120, expSec: nowSec - 60 })))).toBeNull();
    // Tampered signature.
    const good = await mint({ sub: "a" });
    expect(await resolve(bearer(good + "x"))).toBeNull();
    // Missing/!bearer header.
    expect(await resolve(new Request("http://x/runs"))).toBeNull();
    expect(await resolve(new Request("http://x/runs", { headers: { authorization: "Basic abc" } }))).toBeNull();
  });

  it("rejects a token with no usable id claim", async () => {
    const resolve = jwtAuthResolver({ issuer: ISSUER, audience: AUDIENCE, keySet });
    expect(await resolve(bearer(await mint({ foo: "bar" })))).toBeNull(); // no sub
  });

  it("throws when neither jwksUri nor keySet is configured", () => {
    expect(() => jwtAuthResolver({ issuer: ISSUER })).toThrow(/jwksUri|keySet/);
  });
});
