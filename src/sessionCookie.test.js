import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { createToken } from "./auth.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearSessionCookie,
  sessionCookieOptions,
  setSessionCookie
} from "./middleware.js";
import { SESSION_TTL_SECONDS } from "./session.js";

function withNodeEnv(value, fn) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    process.env.NODE_ENV = previous;
  }
}

test("production session cookie is HTTP-only, Secure, SameSite=Lax and persistent", () => {
  const options = withNodeEnv("production", () => sessionCookieOptions());
  assert.equal(SESSION_COOKIE, "vr_session");
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.partitioned, undefined);
  assert.equal(options.path, "/");
  assert.equal(options.maxAge, SESSION_TTL_MS);
  assert.equal(options.maxAge, 7 * 24 * 60 * 60 * 1000);
});

test("development session cookie stays Lax without Secure", () => {
  const options = withNodeEnv("development", () => sessionCookieOptions());
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, false);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.partitioned, undefined);
  assert.equal(options.maxAge, SESSION_TTL_MS);
});

test("the JWT lifetime exactly matches the session cookie lifetime", () => {
  const token = createToken({ _id: "507f1f77bcf86cd799439011", email: "alex@example.com" }, "test-jwt-secret-with-at-least-32-characters");
  const payload = jwt.decode(token);
  assert.equal(payload.exp - payload.iat, SESSION_TTL_SECONDS);
  assert.equal(SESSION_TTL_SECONDS * 1000, SESSION_TTL_MS);
});

test("production login sets only the first-party cookie, and logout clears both variants", () => {
  const calls = [];
  const res = {
    cookie: (...args) => calls.push(["set", ...args]),
    clearCookie: (...args) => calls.push(["clear", ...args])
  };

  withNodeEnv("production", () => setSessionCookie(res, "signed-token"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "set");
  assert.equal(calls[0][1], SESSION_COOKIE);
  assert.equal(calls[0][2], "signed-token");
  assert.equal(calls[0][3].sameSite, "lax");
  assert.equal(calls[0][3].partitioned, undefined);
  assert.equal(calls[0][3].maxAge, SESSION_TTL_MS);

  calls.length = 0;
  withNodeEnv("production", () => clearSessionCookie(res));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2].sameSite, "lax");
  assert.equal(calls[0][2].partitioned, undefined);
  assert.equal(calls[1][2].sameSite, "none");
  assert.equal(calls[1][2].partitioned, true);
  assert.equal(calls[0][2].path, calls[1][2].path);
});
