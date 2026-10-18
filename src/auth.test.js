import test from "node:test";
import assert from "node:assert/strict";
import { validateSignup, validateSignin } from "./auth.js";

test("signup validation accepts valid account data", () => {
  assert.equal(validateSignup({ name: "Alex Router", email: "alex@example.com", password: "correct-horse" }), null);
});

test("signup validation rejects short names, invalid email and short passwords", () => {
  assert.match(validateSignup({ name: "A", email: "alex@example.com", password: "correct-horse" }), /Name/);
  assert.match(validateSignup({ name: "Alex", email: "not-an-email", password: "correct-horse" }), /email/);
  assert.match(validateSignup({ name: "Alex", email: "alex@example.com", password: "short" }), /Password/);
});

test("signin validation rejects malformed credentials", () => {
  assert.match(validateSignin({ email: "bad", password: "12345678" }), /email/);
  assert.match(validateSignin({ email: "alex@example.com", password: "x" }), /password/i);
});

test("signup validation enforces the maximum input lengths", () => {
  assert.match(validateSignup({ name: "a".repeat(81), email: "alex@example.com", password: "correct-horse" }), /Name/);
  assert.match(validateSignup({ name: "Alex", email: "alex@example.com", password: "p".repeat(129) }), /Password/);
});