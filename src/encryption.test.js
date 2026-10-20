import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";

const { decryptSecret, encryptSecret, maskApiKey } = await import("./encryption.js");

test("encryptSecret round-trips the exact plaintext", () => {
  const key = "sk-test-1234567890-abcdef";
  const encrypted = encryptSecret(key);
  assert.notEqual(encrypted, key);
  assert.ok(encrypted.startsWith("v2:"));
  assert.equal(decryptSecret(encrypted), key);
});

test("encryptSecret produces different ciphertexts for the same input", () => {
  const first = encryptSecret("same-key");
  const second = encryptSecret("same-key");
  assert.notEqual(first, second);
  assert.equal(decryptSecret(first), "same-key");
  assert.equal(decryptSecret(second), "same-key");
});

test("decryptSecret rejects tampered ciphertext", () => {
  const encrypted = encryptSecret("sk-original-key");
  const parts = encrypted.split(":");
  const tamperedPayload = Buffer.from("attacker payload").toString("base64");
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${tamperedPayload}`;
  assert.throws(() => decryptSecret(tampered));
});

test("decryptSecret rejects malformed and plaintext values", () => {
  assert.throws(() => decryptSecret("sk-plaintext-key"));
  assert.throws(() => decryptSecret("v1:only:two"));
  assert.throws(() => decryptSecret(null));
});

test("legacy v1 ciphertext remains readable with the current secret", () => {
  const secret = process.env.ENCRYPTION_SECRET;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(secret, "vupsrouter-provider-key", 32), iv);
  const ciphertext = Buffer.concat([cipher.update("sk-legacy-record", "utf8"), cipher.final()]);
  const legacy = ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
  assert.equal(decryptSecret(legacy), "sk-legacy-record");
});

test("key rotation keeps previous ciphertext readable and new payloads use the new key", () => {
  const original = process.env.ENCRYPTION_SECRET;
  const previous = "previous-encryption-secret-with-at-least-32-chars";
  const current = "current-encryption-secret-with-at-least-32-chars";
  try {
    process.env.ENCRYPTION_SECRET = previous;
    delete process.env.ENCRYPTION_SECRET_PREVIOUS;
    const oldPayload = encryptSecret("sk-rotation-test");

    process.env.ENCRYPTION_SECRET = current;
    process.env.ENCRYPTION_SECRET_PREVIOUS = previous;
    assert.equal(decryptSecret(oldPayload), "sk-rotation-test");

    const newPayload = encryptSecret("sk-rotation-test");
    assert.notEqual(newPayload.split(":")[1], oldPayload.split(":")[1]);
    assert.equal(decryptSecret(newPayload), "sk-rotation-test");

    delete process.env.ENCRYPTION_SECRET_PREVIOUS;
    assert.throws(() => decryptSecret(oldPayload), /unknown encryption key version/);
    assert.equal(decryptSecret(newPayload), "sk-rotation-test");
  } finally {
    process.env.ENCRYPTION_SECRET = original;
    delete process.env.ENCRYPTION_SECRET_PREVIOUS;
  }
});

test("maskApiKey never reveals the full key", () => {
  assert.equal(maskApiKey("sk-1234567890abcdef").includes("567890"), false);
  assert.match(maskApiKey("sk-1234567890abcdef"), /^sk-1/);
  assert.match(maskApiKey("sk-1234567890abcdef"), /cdef$/);
  assert.equal(maskApiKey(""), "");
});
