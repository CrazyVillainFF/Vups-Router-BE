import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_COOKIE, SESSION_TTL_MS, sessionCookieOptions } from "./middleware.js";

function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

test("production session cookie is HTTP-only, Secure, SameSite=None and Partitioned", () => {
  const options = withNodeEnv("production", () => sessionCookieOptions());
  assert.equal(SESSION_COOKIE, "vr_session");
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, "none");
  assert.equal(options.partitioned, true);
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, SESSION_TTL_MS);
});

test("development session cookie stays Lax so localhost refreshes keep the session", () => {
  const options = withNodeEnv("development", () => sessionCookieOptions());
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, false);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.partitioned, false);
});
