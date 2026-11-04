import test from "node:test";
import assert from "node:assert/strict";
import { consentPolicyVersion, validateSignup, validateSignin } from "./auth.js";

test("signup validation accepts valid account data", () => {
  assert.equal(validateSignup({ name: "Alex Router", email: "alex@example.com", password: "correct-horse", acceptTerms: true }), null);
});

test("signup validation rejects short names, invalid email and short passwords", () => {
  assert.match(validateSignup({ name: "A", email: "alex@example.com", password: "correct-horse", acceptTerms: true }), /Name/);
  assert.match(validateSignup({ name: "Alex", email: "not-an-email", password: "correct-horse", acceptTerms: true }), /email/);
  assert.match(validateSignup({ name: "Alex", email: "alex@example.com", password: "short", acceptTerms: true }), /Password/);
});

test("signup validation rejects every acceptance value that is not the literal true", () => {
  const valid = { name: "Alex", email: "alex@example.com", password: "correct-horse" };
  assert.match(validateSignup(valid), /Terms of Service and Privacy Policy/);
  for (const acceptTerms of [undefined, null, false, "", "true", "1", 1, 0, {}]) {
    assert.match(validateSignup({ ...valid, acceptTerms }), /Terms of Service and Privacy Policy/);
  }
  assert.equal(validateSignup({ ...valid, acceptTerms: true }), null);
});

test("field errors keep priority over the missing consent error", () => {
  assert.match(validateSignup({ name: "A", email: "alex@example.com", password: "correct-horse" }), /Name/);
  assert.match(validateSignup({ name: "Alex", email: "not-an-email", password: "correct-horse" }), /email/);
  assert.match(validateSignup({ name: "Alex", email: "alex@example.com", password: "short" }), /Password/);
});

test("the recorded policy version is only an ISO date", () => {
  assert.equal(consentPolicyVersion("2026-10-19"), "2026-10-19");
  assert.equal(consentPolicyVersion("  2026-10-19  "), "2026-10-19");
  for (const value of [undefined, null, "", "v1", "terms-2026", "2026-10-19 OR DROP", "19/10/2026"]) {
    assert.equal(consentPolicyVersion(value), null);
  }
});

test("signin validation rejects malformed credentials", () => {
  assert.match(validateSignin({ email: "bad", password: "12345678" }), /email/);
  assert.match(validateSignin({ email: "alex@example.com", password: "x" }), /password/i);
});

test("signup validation enforces the maximum input lengths", () => {
  assert.match(validateSignup({ name: "a".repeat(81), email: "alex@example.com", password: "correct-horse" }), /Name/);
  assert.match(validateSignup({ name: "Alex", email: "alex@example.com", password: "p".repeat(129) }), /Password/);
});