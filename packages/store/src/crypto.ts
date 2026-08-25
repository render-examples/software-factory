import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * Derive a 32-byte AES key from a configured secret (e.g.
 * `RENDER_FACTORY_ENCRYPTION_KEY`). SHA-256 yields exactly 256 bits so any
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
  // Validate lengths so malformed input yields a stable error, not an opaque crypto exception.
  if (iv.length !== 12) throw new Error("Invalid encrypted token: IV must be 12 bytes");
  if (tag.length !== 16) throw new Error("Invalid encrypted token: auth tag must be 16 bytes");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

let warnedDevKey = false;

/**
 * The encryption key from the environment. In production a missing key is fatal
 * (fail closed — never silently encrypt secrets with a public constant, CR-03);
 * in dev/test it falls back to a clearly-flagged insecure key with one warning.
 */
export function encryptionKeyFromEnv(): Buffer {
  const secret = process.env.RENDER_FACTORY_ENCRYPTION_KEY;
  if (secret) return deriveKey(secret);

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "RENDER_FACTORY_ENCRYPTION_KEY is required in production. It encrypts OAuth " +
        "tokens at rest and signs OAuth state; set a strong 32+ char secret.",
    );
  }

  if (!warnedDevKey) {
    warnedDevKey = true;
    console.warn(
      "[render-factory] RENDER_FACTORY_ENCRYPTION_KEY is not set; using an INSECURE dev key " +
        "for OAuth token encryption. Set a strong 32+ char secret in production.",
    );
  }
  return deriveKey("render-factory-insecure-dev-key");
}
