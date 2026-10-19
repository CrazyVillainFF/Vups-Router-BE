import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.PASSWORD_RESET_RATE_LIMIT_MAX = "10000";
process.env.VERIFY_CODE_RATE_LIMIT_MAX = "10000";
process.env.PASSWORD_RESET_ATTEMPT_LIMIT_MAX = "10000";
process.env.SENDER_EMAIL = "vupriseoffical@gmail.com";
delete process.env.MONGODB_URI;
delete process.env.BREVO_API_KEY;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_reset_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: User } = await import("./user.js");
const { startFakeBrevo, extractOtpCode, FAKE_BREVO_KEY } = await import("./testUtils/fakeBrevo.js");
const {
  RESET_AUTH_TTL_MS,
  RESET_CODE_TTL_MS,
  RESET_MAX_ATTEMPTS,
  formatOtp,
  generateOtp,
  generateResetAuthToken,
  hashResetAuthToken,
  isResetAuthTokenFormat,
  isSixDigitCode
} = await import("./resetCode.js");
const { passwordMatches } = await import("./auth.js");

const fakeBrevo = await startFakeBrevo();
process.env.BREVO_API_URL = fakeBrevo.baseUrl;
process.env.BREVO_API_KEY = FAKE_BREVO_KEY;

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeBrevo.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `reset${Date.now()}-${counter}@example.com`;
}

async function api(path, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json, headers: response.headers };
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function signupUser(password = "correct-horse-battery") {
  const email = uniqueEmail();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Reset Tester", email, password }
  });
  assert.equal(response.status, 201);
  return { email, cookie: sessionCookie(response), password };
}

const SENT_MESSAGE = "If that email exists, we sent a 6-digit code.";
const INVALID_MESSAGE = "That code is invalid or has expired.";

async function forgotAndGetCode(email) {
  fakeBrevo.state.reset();
  const response = await api("/api/forgot-password", { method: "POST", body: { email } });
  assert.equal(response.status, 200);
  assert.equal(response.body.message, SENT_MESSAGE);
  assert.equal(fakeBrevo.state.requests.length, 1);
  const code = extractOtpCode(fakeBrevo.state.requests[0]);
  assert.ok(code, "the email must contain a six-digit code");
  return code;
}

async function storedReset(email) {
  return User.findOne({ email }).select(
    "resetCodeHash resetCodeExpires resetAttempts resetAuthHash resetAuthExpires passwordChangedAt"
  );
}

async function captureConsoleError(run) {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return logs;
}

// ─── OTP + authorization helpers ────────────────────────────────────────────

test("generateOtp always produces six digits and preserves leading zeroes", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateOtp();
    assert.match(code, /^\d{6}$/, `unexpected code ${code}`);
    assert.equal(code.length, 6);
  }
  assert.equal(formatOtp(0), "000000");
  assert.equal(formatOtp(42), "000042");
  assert.equal(formatOtp(999999), "999999");
  assert.ok(isSixDigitCode("004213"));
  assert.ok(!isSixDigitCode(" 12345"));
  assert.ok(!isSixDigitCode("1234567"));
  assert.ok(!isSixDigitCode("12345a"));
  assert.ok(!isSixDigitCode(123456));
});

test("reset code and authorization TTLs are ten minutes and the attempt cap is five", () => {
  assert.equal(RESET_CODE_TTL_MS, 10 * 60 * 1000);
  assert.equal(RESET_AUTH_TTL_MS, 10 * 60 * 1000);
  assert.equal(RESET_MAX_ATTEMPTS, 5);
});

test("reset authorization tokens are unique, URL-safe, and only stored as sha256 digests", () => {
  const a = generateResetAuthToken();
  const b = generateResetAuthToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 43);
  assert.ok(isResetAuthTokenFormat(a));
  assert.ok(!isResetAuthTokenFormat("short"));
  assert.ok(!isResetAuthTokenFormat("has spaces and symbols !!!"));
  const digest = hashResetAuthToken(a);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, a);
  assert.equal(digest, hashResetAuthToken(a));
});

// ─── Step 1: forgot-password ────────────────────────────────────────────────

test("forgot-password emails a six-digit code and stores only its bcrypt hash", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);

  const request = fakeBrevo.state.requests[0];
  assert.equal(request.headers["api-key"], FAKE_BREVO_KEY);
  assert.deepEqual(request.body.sender, { name: "VupsRouter", email: "vupriseoffical@gmail.com" });
  assert.deepEqual(request.body.to, [{ email: user.email }]);
  assert.equal(request.body.subject, "Your password reset code");
  assert.match(request.body.htmlContent, /expires in 10 minutes/);
  assert.match(request.body.htmlContent, /never share this code/i);
  assert.ok(request.body.textContent.includes(code));

  const stored = await storedReset(user.email);
  assert.match(stored.resetCodeHash, /^\$2[aby]\$/, "the code must be stored as a bcrypt hash");
  assert.notEqual(stored.resetCodeHash, code, "the raw code must never be stored");
  assert.equal(stored.resetAttempts, 0);
  const remaining = stored.resetCodeExpires.getTime() - Date.now();
  assert.ok(remaining > 9 * 60 * 1000 && remaining <= 10 * 60 * 1000, `expiry ~10min, got ${remaining}ms`);
  assert.equal(await passwordMatches(code, stored.resetCodeHash), true);
});

test("email normalization: mixed-case and padded addresses reach the same account", async () => {
  const user = await signupUser();
  fakeBrevo.state.reset();
  const response = await api("/api/forgot-password", {
    method: "POST",
    body: { email: `  ${user.email.toUpperCase()}  ` }
  });
  assert.equal(response.status, 200);
  assert.equal(fakeBrevo.state.requests.length, 1, "the code must be sent for the normalized account");
  assert.equal(fakeBrevo.state.requests[0].body.to[0].email, user.email);

  const stored = await storedReset(user.email);
  assert.ok(stored.resetCodeHash, "the code must be stored on the normalized account");
});

test("nonexistent accounts receive the identical response and no email", async () => {
  fakeBrevo.state.reset();
  const response = await api("/api/forgot-password", { method: "POST", body: { email: uniqueEmail() } });
  assert.equal(response.status, 200);
  assert.equal(response.body.message, SENT_MESSAGE);
  assert.equal(fakeBrevo.state.requests.length, 0);

  const invalid = await api("/api/forgot-password", { method: "POST", body: { email: "not-an-email" } });
  assert.equal(invalid.status, 400);
});

test("missing Brevo configuration fails loudly and stores no code", async () => {
  const user = await signupUser();
  fakeBrevo.state.reset();
  const saved = process.env.BREVO_API_KEY;
  delete process.env.BREVO_API_KEY;
  let response;
  const logs = await captureConsoleError(async () => {
    response = await api("/api/forgot-password", { method: "POST", body: { email: user.email } });
  });
  process.env.BREVO_API_KEY = saved;

  assert.equal(response.status, 503);
  assert.match(response.body.message, /not configured/i);
  assert.ok(logs.some(line => /not configured/i.test(line)), "the configuration problem must be recorded server-side");
  assert.equal(fakeBrevo.state.requests.length, 0);
  const stored = await storedReset(user.email);
  assert.equal(stored.resetCodeHash ?? null, null);
  assert.equal(stored.resetCodeExpires ?? null, null);
});

test("Brevo 401, 429, and network failures invalidate the code, log the provider response, and never leak the code", async () => {
  const user = await signupUser();

  for (const scenario of [{ status: 401 }, { status: 429 }, { status: 400 }]) {
    fakeBrevo.state.reset();
    fakeBrevo.state.set(scenario);
    let response;
    const logs = await captureConsoleError(async () => {
      response = await api("/api/forgot-password", { method: "POST", body: { email: user.email } });
    });
    assert.equal(response.status, 200, "delivery failures must not reveal account existence");
    assert.equal(response.body.message, SENT_MESSAGE);
    assert.ok(
      logs.some(line => line.includes(`HTTP ${scenario.status}`) && line.includes("{")),
      `the HTTP ${scenario.status} provider body must be logged`
    );
    const code = extractOtpCode(fakeBrevo.state.requests[0]);
    assert.ok(code);
    for (const line of logs) {
      assert.ok(!line.includes(code), "the OTP must never appear in server logs");
    }
    const stored = await storedReset(user.email);
    assert.equal(stored.resetCodeHash ?? null, null, "undelivered codes must be invalidated");
  }

  fakeBrevo.state.reset();
  const savedUrl = process.env.BREVO_API_URL;
  process.env.BREVO_API_URL = "http://127.0.0.1:9";
  try {
    let response;
    const logs = await captureConsoleError(async () => {
      response = await api("/api/forgot-password", { method: "POST", body: { email: user.email } });
    });
    assert.equal(response.status, 200);
    assert.ok(logs.some(line => /network failure/i.test(line)));
    const stored = await storedReset(user.email);
    assert.equal(stored.resetCodeHash ?? null, null);
  } finally {
    process.env.BREVO_API_URL = savedUrl;
  }
  fakeBrevo.state.reset();
});

// ─── Step 2: verify-code ────────────────────────────────────────────────────

test("verify-code accepts the correct code and returns a single-use authorization", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);

  const verified = await api("/api/verify-code", { method: "POST", body: { email: user.email, code } });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.success, true);
  assert.equal(verified.body.message, "Code verified successfully.");
  assert.ok(isResetAuthTokenFormat(verified.body.resetAuthorization));

  const stored = await storedReset(user.email);
  assert.equal(stored.resetAuthHash, hashResetAuthToken(verified.body.resetAuthorization));
  assert.notEqual(stored.resetAuthHash, verified.body.resetAuthorization, "the authorization is never stored raw");
  assert.equal(stored.resetAttempts, 0);
  const remaining = stored.resetAuthExpires.getTime() - Date.now();
  assert.ok(remaining > 9 * 60 * 1000 && remaining <= 10 * 60 * 1000, `authorization ~10min, got ${remaining}ms`);
});

test("wrong codes are rejected, increment the attempt counter, and never leak account existence", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  const wrong = code === "000000" ? "111111" : "000000";

  const rejected = await api("/api/verify-code", { method: "POST", body: { email: user.email, code: wrong } });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.message, INVALID_MESSAGE);

  const stored = await storedReset(user.email);
  assert.equal(stored.resetAttempts, 1, "every wrong code must increment the counter");

  const unknown = await api("/api/verify-code", { method: "POST", body: { email: uniqueEmail(), code: wrong } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.message, INVALID_MESSAGE, "unknown accounts get the identical error");

  const malformed = await api("/api/verify-code", { method: "POST", body: { email: user.email, code: "12ab56" } });
  assert.equal(malformed.status, 400);
});

test("the five-attempt limit blocks further verification even with the correct code", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  const wrong = code === "000000" ? "111111" : "000000";

  for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) {
    const attempt = await api("/api/verify-code", { method: "POST", body: { email: user.email, code: wrong } });
    assert.equal(attempt.status, 400);
  }
  const stored = await storedReset(user.email);
  assert.equal(stored.resetAttempts, RESET_MAX_ATTEMPTS);

  const blocked = await api("/api/verify-code", { method: "POST", body: { email: user.email, code } });
  assert.equal(blocked.status, 400, "exhausted codes must not verify even when correct");
  assert.equal(blocked.body.message, INVALID_MESSAGE);

  // A fresh request resets the counter and works again.
  const freshCode = await forgotAndGetCode(user.email);
  const verified = await api("/api/verify-code", { method: "POST", body: { email: user.email, code: freshCode } });
  assert.equal(verified.status, 200);
});

test("expired codes cannot be verified", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  await User.updateOne({ email: user.email }, { $set: { resetCodeExpires: new Date(Date.now() - 1000) } });

  const verified = await api("/api/verify-code", { method: "POST", body: { email: user.email, code } });
  assert.equal(verified.status, 400);
  assert.equal(verified.body.message, INVALID_MESSAGE);
});

test("concurrent wrong verifications all count against the attempt limit", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  const wrong = code === "000000" ? "111111" : "000000";

  await Promise.all(
    Array.from({ length: 5 }, () => api("/api/verify-code", { method: "POST", body: { email: user.email, code: wrong } }))
  );
  const stored = await storedReset(user.email);
  assert.equal(stored.resetAttempts, 5, "atomic increments must not lose concurrent attempts");
});

// ─── Step 3: reset-password ─────────────────────────────────────────────────

test("authorized reset changes the password, consumes the authorization, and invalidates old sessions", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  const verified = await api("/api/verify-code", { method: "POST", body: { email: user.email, code } });
  const resetAuthorization = verified.body.resetAuthorization;

  const reset = await api("/api/reset-password", {
    method: "POST",
    body: {
      email: user.email,
      code,
      resetAuthorization,
      newPassword: "brand-new-password-1",
      confirmPassword: "brand-new-password-1"
    }
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.success, true);
  assert.equal(reset.body.message, "Password updated successfully.");

  const oldSignin = await api("/api/auth/signin", { method: "POST", body: { email: user.email, password: user.password } });
  assert.equal(oldSignin.status, 401);

  const newSignin = await api("/api/auth/signin", {
    method: "POST",
    body: { email: user.email, password: "brand-new-password-1" }
  });
  assert.equal(newSignin.status, 200);

  const oldSession = await api("/api/auth/me", { cookie: user.cookie });
  assert.equal(oldSession.status, 401, "sessions issued before the reset must be invalidated");

  const reuseAuth = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, resetAuthorization, newPassword: "another-password-2", confirmPassword: "another-password-2" }
  });
  assert.equal(reuseAuth.status, 400, "consumed authorizations must not be reusable");

  const reuseCode = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code, newPassword: "another-password-3", confirmPassword: "another-password-3" }
  });
  assert.equal(reuseCode.status, 400, "consumed codes must not be reusable");

  const stored = await storedReset(user.email);
  assert.equal(stored.resetCodeHash ?? null, null, "consumed codes must be cleared");
  assert.equal(stored.resetAuthHash ?? null, null, "consumed authorizations must be cleared");
  assert.ok(stored.passwordChangedAt instanceof Date);
});

test("reset-password also accepts email + code directly without a prior verify call", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);

  const reset = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code, newPassword: "code-path-password-1" }
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.message, "Password updated successfully.");

  const signin = await api("/api/auth/signin", { method: "POST", body: { email: user.email, password: "code-path-password-1" } });
  assert.equal(signin.status, 200);
});

test("an authorization is bound to its own account and cannot reset another account", async () => {
  const verifiedUser = await signupUser();
  const otherUser = await signupUser();
  const code = await forgotAndGetCode(verifiedUser.email);
  const verified = await api("/api/verify-code", { method: "POST", body: { email: verifiedUser.email, code } });

  const crossAccount = await api("/api/reset-password", {
    method: "POST",
    body: {
      email: otherUser.email,
      resetAuthorization: verified.body.resetAuthorization,
      newPassword: "cross-account-password-1",
      confirmPassword: "cross-account-password-1"
    }
  });
  assert.equal(crossAccount.status, 400);
  assert.equal(crossAccount.body.message, INVALID_MESSAGE);

  const otherSignin = await api("/api/auth/signin", { method: "POST", body: { email: otherUser.email, password: otherUser.password } });
  assert.equal(otherSignin.status, 200, "the other account's password must be untouched");
});

test("requesting a new code revokes previously issued authorizations", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  const verified = await api("/api/verify-code", { method: "POST", body: { email: user.email, code } });

  await forgotAndGetCode(user.email);

  const staleAuth = await api("/api/reset-password", {
    method: "POST",
    body: {
      email: user.email,
      resetAuthorization: verified.body.resetAuthorization,
      newPassword: "stale-auth-password-1",
      confirmPassword: "stale-auth-password-1"
    }
  });
  assert.equal(staleAuth.status, 400);
});

test("expired codes and expiry of authorizations are rejected", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  await User.updateOne({ email: user.email }, { $set: { resetCodeExpires: new Date(Date.now() - 1000) } });

  const expiredCode = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code, newPassword: "expired-path-password-1" }
  });
  assert.equal(expiredCode.status, 400);

  const freshCode = await forgotAndGetCode(user.email);
  const verified = await api("/api/verify-code", { method: "POST", body: { email: user.email, code: freshCode } });
  await User.updateOne({ email: user.email }, { $set: { resetAuthExpires: new Date(Date.now() - 1000) } });

  const expiredAuth = await api("/api/reset-password", {
    method: "POST",
    body: {
      email: user.email,
      resetAuthorization: verified.body.resetAuthorization,
      newPassword: "expired-auth-password-1",
      confirmPassword: "expired-auth-password-1"
    }
  });
  assert.equal(expiredAuth.status, 400);

  const signin = await api("/api/auth/signin", { method: "POST", body: { email: user.email, password: user.password } });
  assert.equal(signin.status, 200, "the original password must still work");
});

test("mismatched passwords and weak passwords are rejected without consuming the code", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);

  const mismatch = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code, newPassword: "mismatched-password-1", confirmPassword: "mismatched-password-2" }
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.message, /do not match/i);

  const weak = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code, newPassword: "short", confirmPassword: "short" }
  });
  assert.equal(weak.status, 400);

  const missingCode = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, newPassword: "missing-code-password-1" }
  });
  assert.equal(missingCode.status, 400);

  const stored = await storedReset(user.email);
  assert.ok(stored.resetCodeHash, "validation failures must not consume the code");

  const good = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code, newPassword: "fixed-password-123", confirmPassword: "fixed-password-123" }
  });
  assert.equal(good.status, 200);
});

test("the attempt limit also blocks reset-password with the correct code", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  const wrong = code === "000000" ? "111111" : "000000";

  for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) {
    const attempt = await api("/api/reset-password", {
      method: "POST",
      body: { email: user.email, code: wrong, newPassword: "attempted-password-1" }
    });
    assert.equal(attempt.status, 400);
  }
  const blocked = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code, newPassword: "attempted-password-2" }
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.message, INVALID_MESSAGE);
});

test("concurrent resets with the same authorization or code allow exactly one success", async () => {
  const user = await signupUser();
  const code = await forgotAndGetCode(user.email);
  const verified = await api("/api/verify-code", { method: "POST", body: { email: user.email, code } });

  const attemptAuth = () => api("/api/reset-password", {
    method: "POST",
    body: {
      email: user.email,
      resetAuthorization: verified.body.resetAuthorization,
      newPassword: "concurrent-password-1",
      confirmPassword: "concurrent-password-1"
    }
  });
  const [first, second] = await Promise.all([attemptAuth(), attemptAuth()]);
  assert.deepEqual([first.status, second.status].sort(), [200, 400], "only one request may consume the authorization");

  const otherUser = await signupUser();
  const otherCode = await forgotAndGetCode(otherUser.email);
  const attemptCode = () => api("/api/reset-password", {
    method: "POST",
    body: { email: otherUser.email, code: otherCode, newPassword: "concurrent-password-2" }
  });
  const [codeFirst, codeSecond] = await Promise.all([attemptCode(), attemptCode()]);
  assert.deepEqual([codeFirst.status, codeSecond.status].sort(), [200, 400], "only one request may consume the code");
});

test("a newer code replaces the previous one and only the newest authorizes a reset", async () => {
  const user = await signupUser();
  const firstCode = await forgotAndGetCode(user.email);
  const secondCode = await forgotAndGetCode(user.email);
  assert.notEqual(firstCode, secondCode, "a fresh request must generate a new code");

  const stale = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code: firstCode, newPassword: "stale-code-password-1" }
  });
  assert.equal(stale.status, 400);

  const fresh = await api("/api/reset-password", {
    method: "POST",
    body: { email: user.email, code: secondCode, newPassword: "fresh-code-password-1" }
  });
  assert.equal(fresh.status, 200);
});
