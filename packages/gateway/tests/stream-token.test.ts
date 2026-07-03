import { describe, it, expect } from "vitest";
import { issueStreamToken, verifyStreamToken } from "../src/stream-token.js";

const SECRET = "a-signing-secret";

describe("stream tokens", () => {
  it("round-trips a user principal", () => {
    const { token, expiresInMs } = issueStreamToken({ userId: "alice", role: "user" }, SECRET);
    expect(expiresInMs).toBeGreaterThan(0);
    expect(verifyStreamToken(token, SECRET)).toEqual({ userId: "alice", role: "user" });
  });

  it("preserves the operator role", () => {
    const { token } = issueStreamToken({ userId: "op", role: "operator" }, SECRET);
    expect(verifyStreamToken(token, SECRET)).toEqual({ userId: "op", role: "operator" });
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = issueStreamToken({ userId: "alice", role: "user" }, SECRET);
    expect(verifyStreamToken(token, "other-secret")).toBeNull();
  });

  it("rejects a tampered payload or signature", () => {
    const { token } = issueStreamToken({ userId: "alice", role: "user" }, SECRET);
    const [payload, sig] = token.split(".");
    // Swap the payload for a forged one, keep the old signature.
    const forged = Buffer.from("bob|operator|" + (Date.now() + 60_000), "utf8").toString("base64url");
    expect(verifyStreamToken(`${forged}.${sig}`, SECRET)).toBeNull();
    // Mangle the signature.
    expect(verifyStreamToken(`${payload}.${sig}x`, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const { token } = issueStreamToken({ userId: "alice", role: "user" }, SECRET, 1_000);
    expect(verifyStreamToken(token, SECRET, Date.now() + 2_000)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyStreamToken(undefined, SECRET)).toBeNull();
    expect(verifyStreamToken("", SECRET)).toBeNull();
    expect(verifyStreamToken("no-dot", SECRET)).toBeNull();
    expect(verifyStreamToken(".sig", SECRET)).toBeNull();
  });
});
