import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const VERSION = "v2";
const LEGACY_VERSION = "v1";
const SALT = "vupsrouter-provider-key";
const MASK_CHARACTER = "\u2022";

let cachedSignature;
let cachedKeyring;

function keyIdFor(secret) {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function deriveKey(secret) {
  return scryptSync(secret, SALT, 32);
}

function encryptionSecrets() {
  const primary = process.env.ENCRYPTION_SECRET;
  if (!primary || primary.length < 32) {
    throw new Error("ENCRYPTION_SECRET must be set to a random value of at least 32 characters.");
  }
  const previous = (process.env.ENCRYPTION_SECRET_PREVIOUS || "")
    .split(",")
    .map(value => value.trim())
    .filter(value => value.length >= 32 && value !== primary);
  return [primary, ...new Set(previous)];
}

function encryptionKeyring() {
  const secrets = encryptionSecrets();
  const signature = secrets.join("\u0000");
  if (cachedKeyring && cachedSignature === signature) return cachedKeyring;
  const keys = new Map();
  for (const secret of secrets) {
    const id = keyIdFor(secret);
    if (!keys.has(id)) keys.set(id, deriveKey(secret));
  }
  cachedSignature = signature;
  cachedKeyring = { id: keyIdFor(secrets[0]), keys };
  return cachedKeyring;
}

function decryptWithKey(key, ivPart, tagPart, dataPart) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

export function encryptSecret(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Cannot encrypt an empty secret.");
  }
  const keyring = encryptionKeyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyring.keys.get(keyring.id), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyring.id, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(payload) {
  if (typeof payload !== "string") {
    throw new Error("Stored secret is not in the expected encrypted format.");
  }
  const parts = payload.split(":");
  const keyring = encryptionKeyring();
  if (parts[0] === VERSION) {
    const [, keyId, ivPart, tagPart, dataPart] = parts;
    if (!keyId || !ivPart || !tagPart || !dataPart) throw new Error("Stored secret is malformed.");
    const key = keyring.keys.get(keyId);
    if (!key) throw new Error("Stored secret uses an unknown encryption key version.");
    return decryptWithKey(key, ivPart, tagPart, dataPart);
  }
  if (parts[0] === LEGACY_VERSION) {
    const [, ivPart, tagPart, dataPart] = parts;
    if (!ivPart || !tagPart || !dataPart) throw new Error("Stored secret is malformed.");
    for (const key of keyring.keys.values()) {
      try {
        return decryptWithKey(key, ivPart, tagPart, dataPart);
      } catch {
        continue;
      }
    }
    throw new Error("Stored secret could not be decrypted with the configured keys.");
  }
  throw new Error("Stored secret is not in the expected encrypted format.");
}

export function encryptionKeyId() {
  return encryptionKeyring().id;
}

export function secretNeedsRotation(payload) {
  return typeof payload !== "string" || !payload.startsWith(`${VERSION}:${encryptionKeyId()}:`);
}

export function maskApiKey(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return "";
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}${MASK_CHARACTER.repeat(Math.max(4, apiKey.length - 2))}`;
  return `${apiKey.slice(0, 4)}${MASK_CHARACTER.repeat(8)}${apiKey.slice(-4)}`;
}
