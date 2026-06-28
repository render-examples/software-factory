import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * Derive a 32-byte AES key from a configured secret (e.g.
 * `RENDER_AGENTS_ENCRYPTION_KEY`). SHA-256 yields exactly 256 bits so any
 * secret length works.
 */
export function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM encrypt → `iv:tag:ciphertext` (hex). */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** AES-256-GCM decrypt of an `iv:tag:ciphertext` (hex) blob. */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted token format");
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = Buffer.from(parts[2], "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** The encryption key from the environment, with a clearly-flagged dev fallback. */
export function encryptionKeyFromEnv(): Buffer {
  const secret = process.env.RENDER_AGENTS_ENCRYPTION_KEY;
  if (!secret) {
    return deriveKey("render-agents-insecure-dev-key");
  }
  return deriveKey(secret);
}
