import test from "node:test";
import assert from "node:assert/strict";

process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";

const { decryptSecret, encryptSecret, maskApiKey } = await import("./encryption.js");

test("encryptSecret round-trips the exact plaintext", () => {
  const key = "sk-test-1234567890-abcdef";
  const encrypted = encryptSecret(key);
  assert.notEqual(encrypted, key);
  assert.ok(encrypted.startsWith("v1:"));
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
  const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedPayload}`;
  assert.throws(() => decryptSecret(tampered));
});

test("decryptSecret rejects malformed and plaintext values", () => {
  assert.throws(() => decryptSecret("sk-plaintext-key"));
  assert.throws(() => decryptSecret("v1:only:two"));
  assert.throws(() => decryptSecret(null));
});

test("maskApiKey never reveals the full key", () => {
  assert.equal(maskApiKey("sk-1234567890abcdef").includes("567890"), false);
  assert.match(maskApiKey("sk-1234567890abcdef"), /^sk-1/);
  assert.match(maskApiKey("sk-1234567890abcdef"), /cdef$/);
  assert.equal(maskApiKey(""), "");
});
