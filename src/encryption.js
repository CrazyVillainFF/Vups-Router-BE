import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const VERSION = "v1";
const SALT = "vupsrouter-provider-key";

let cachedSecret;
let cachedKey;

function encryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ENCRYPTION_SECRET must be set to a random value of at least 32 characters.");
  }
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedSecret = secret;
  cachedKey = scryptSync(secret, SALT, 32);
  return cachedKey;
}

export function encryptSecret(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Cannot encrypt an empty secret.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(payload) {
  if (typeof payload !== "string" || !payload.startsWith(`${VERSION}:`)) {
    throw new Error("Stored secret is not in the expected encrypted format.");
  }
  const [, ivPart, tagPart, dataPart] = payload.split(":");
  if (!ivPart || !tagPart || !dataPart) throw new Error("Stored secret is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

export function maskApiKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return "";
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}${"•".repeat(Math.max(4, apiKey.length - 2))}`;
  return `${apiKey.slice(0, 4)}${"•".repeat(8)}${apiKey.slice(-4)}`;
}
