import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";

const { REDACTED, redactSecrets, secretValues } = await import("./redact.js");
const { PluginError } = await import("./errors.js");
const { safeErrorMessage } = await import("./service.js");

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

test("known credential values never survive a message", () => {
  const message = `Bad credentials: ${TOKEN} was rejected.`;
  const output = redactSecrets(message, [TOKEN]);
  assert.ok(!output.includes(TOKEN));
  assert.match(output, /Bad credentials: \[redacted\] was rejected\./);
});

test("token shaped strings are redacted even when the value is unknown", () => {
  for (const token of [
    "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "sk-proj-1234567890abcdefghijklmnop",
    "AIzaSyA1234567890abcdefghijklmnopq"
  ]) {
    const output = redactSecrets(`Rejected ${token} by the provider`);
    assert.ok(!output.includes(token), token);
    assert.ok(output.includes(REDACTED), token);
  }
});

test("authorization headers keep their scheme and lose the secret", () => {
  const output = redactSecrets("Upstream said: Authorization: Bearer abcdefgh12345678 is expired");
  assert.match(output, /Authorization: Bearer \[redacted\] is expired/);
  assert.ok(!output.includes("abcdefgh12345678"));
});

test("credential query parameters and bodies are redacted", () => {
  const query = redactSecrets("https://api.example.com/photos?client_id=abcdef123456&page=2 failed");
  assert.ok(!query.includes("abcdef123456"));
  assert.match(query, /client_id=\[redacted\]&page=2/);

  const body = redactSecrets('{"api_key":"super-secret-value","mode":"fast"}');
  assert.ok(!body.includes("super-secret-value"));
  assert.match(body, /"api_key":"\[redacted\]"/);

  const pair = redactSecrets("token=abcdef123456 was invalid");
  assert.ok(!pair.includes("abcdef123456"));
});

test("secretValues only collects values long enough to be credentials", () => {
  const values = secretValues({ apiKey: "short", token: TOKEN }, { token: TOKEN }, null, { tier: "pro" });
  assert.deepEqual(values, [TOKEN]);
});

test("safeErrorMessage redacts a provider error before it leaves the service", () => {
  const error = new PluginError(`GitHub rejected ${TOKEN}`, 422, "connection_failed");
  const message = safeErrorMessage(error, [TOKEN]);
  assert.ok(!message.includes(TOKEN));
  assert.match(message, /\[redacted\]/);
});

test("safeErrorMessage keeps a generic message for unknown failures", () => {
  const error = new Error(`socket hang up while using ${TOKEN}`);
  const message = safeErrorMessage(error, [TOKEN]);
  assert.equal(message, "The plugin service could not be reached.");
  assert.ok(!message.includes(TOKEN));
});

test("short values are not scanned as secrets", () => {
  // A one-word value would otherwise mangle ordinary sentences.
  assert.equal(redactSecrets("The key was rejected", ["key"]), "The key was rejected");
});
