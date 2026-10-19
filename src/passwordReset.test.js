import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.PASSWORD_RESET_RATE_LIMIT_MAX = "10000";
process.env.PASSWORD_RESET_ATTEMPT_LIMIT_MAX = "10000";
process.env.PASSWORD_RESET_PEPPER = "test-password-reset-pepper-with-32-plus-characters";
process.env.SENDER_EMAIL = "vupriseoffical@gmail.com";
process.env.CLIENT_URL = "https://app.example.test";
delete process.env.MONGODB_URI;
delete process.env.BREVO_API_KEY;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_reset_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: User } = await import("./user.js");
const { startFakeBrevo, extractRawToken, extractResetLink, FAKE_BREVO_KEY } = await import("./testUtils/fakeBrevo.js");
const { RESET_TOKEN_TTL_MS, generateResetToken, hashResetToken, isValidResetTokenFormat } = await import("./resetToken.js");

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

async function forgotAndGetToken(email) {
  fakeBrevo.state.reset();
  const response = await api("/api/forgot-password", { method: "POST", body: { email } });
  assert.equal(response.status, 200);
  assert.equal(response.body.message, "If that email exists, we sent a reset link.");
  assert.equal(fakeBrevo.state.requests.length, 1);
  return extractRawToken(fakeBrevo.state.requests[0]);
}

async function storedToken(email) {
  const user = await User.findOne({ email }).select("passwordResetTokenHash passwordResetExpiresAt passwordChangedAt");
  return user;
}

test("generateResetToken produces unique URL-safe tokens and hashResetToken is deterministic", () => {
  const a = generateResetToken();
  const b = generateResetToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 43);
  assert.ok(isValidResetTokenFormat(a));
  assert.ok(!isValidResetTokenFormat("short"));
  assert.ok(!isValidResetTokenFormat("has spaces and symbols !!!"));
  assert.notEqual(hashResetToken(a), a);
  assert.match(hashResetToken(a), /^[a-f0-9]{64}$/);
  assert.equal(hashResetToken(a), hashResetToken(a));
});

test("reset tokens expire after exactly 30 minutes", () => {
  assert.equal(RESET_TOKEN_TTL_MS, 30 * 60 * 1000);
});

test("forgot-password emails a reset link to an existing account and stores only a token hash", async () => {
  const user = await signupUser();
  const rawToken = await forgotAndGetToken(user.email);
  assert.ok(rawToken, "the email must contain a reset link");

  const request = fakeBrevo.state.requests[0];
  assert.equal(request.headers["api-key"], FAKE_BREVO_KEY);
  assert.deepEqual(request.body.sender, { name: "Vups", email: "vupriseoffical@gmail.com" });
  assert.deepEqual(request.body.to, [{ email: user.email }]);
  assert.equal(request.body.subject, "Reset your password");
  assert.match(request.body.htmlContent, /Reset Password/);
  assert.match(request.body.htmlContent, /expires in 30 minutes/);
  assert.match(request.body.htmlContent, /If you did not request a password reset/);
  assert.ok(typeof request.body.textContent === "string" && request.body.textContent.includes("reset-password?token="));
  assert.ok(extractResetLink(request).startsWith("https://app.example.test/reset-password?token="));

  const stored = await storedToken(user.email);
  assert.match(stored.passwordResetTokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.passwordResetTokenHash, rawToken, "the raw token must never be stored");
  const remaining = stored.passwordResetExpiresAt.getTime() - Date.now();
  assert.ok(remaining > 29 * 60 * 1000 && remaining <= 30 * 60 * 1000, `expiry ~30min, got ${remaining}ms`);
});

test("nonexistent accounts receive the identical response and no email", async () => {
  fakeBrevo.state.reset();
  const response = await api("/api/forgot-password", { method: "POST", body: { email: uniqueEmail() } });
  assert.equal(response.status, 200);
  assert.equal(response.body.message, "If that email exists, we sent a reset link.");
  assert.equal(fakeBrevo.state.requests.length, 0);

  const invalid = await api("/api/forgot-password", { method: "POST", body: { email: "not-an-email" } });
  assert.equal(invalid.status, 400);
});

test("missing Brevo configuration fails safely and stores no token", async () => {
  const user = await signupUser();
  fakeBrevo.state.reset();
  const saved = process.env.BREVO_API_KEY;
  delete process.env.BREVO_API_KEY;
  try {
    const response = await api("/api/forgot-password", { method: "POST", body: { email: user.email } });
    assert.equal(response.status, 503);
    assert.match(response.body.message, /not configured/i);
    assert.equal(fakeBrevo.state.requests.length, 0);
    const stored = await storedToken(user.email);
    assert.equal(stored.passwordResetTokenHash ?? null, null);
    assert.equal(stored.passwordResetExpiresAt ?? null, null);
  } finally {
    process.env.BREVO_API_KEY = saved;
  }
});

test("Brevo authentication failures and rate limits invalidate the pending token", async () => {
  const user = await signupUser();

  fakeBrevo.state.reset();
  fakeBrevo.state.set({ status: 401 });
  const rejected = await api("/api/forgot-password", { method: "POST", body: { email: user.email } });
  assert.equal(rejected.status, 200, "delivery failures must not reveal account existence");
  assert.equal(rejected.body.message, "If that email exists, we sent a reset link.");
  let stored = await storedToken(user.email);
  assert.equal(stored.passwordResetTokenHash ?? null, null, "undelivered tokens must be invalidated");

  fakeBrevo.state.reset();
  fakeBrevo.state.set({ status: 429 });
  const throttled = await api("/api/forgot-password", { method: "POST", body: { email: user.email } });
  assert.equal(throttled.status, 200);
  stored = await storedToken(user.email);
  assert.equal(stored.passwordResetTokenHash ?? null, null);

  fakeBrevo.state.reset();
  const savedUrl = process.env.BREVO_API_URL;
  process.env.BREVO_API_URL = "http://127.0.0.1:9";
  try {
    const unreachable = await api("/api/forgot-password", { method: "POST", body: { email: user.email } });
    assert.equal(unreachable.status, 200);
    stored = await storedToken(user.email);
    assert.equal(stored.passwordResetTokenHash ?? null, null);
  } finally {
    process.env.BREVO_API_URL = savedUrl;
  }
  fakeBrevo.state.reset();
});

test("a full reset changes the password, consumes the token, and invalidates old sessions", async () => {
  const user = await signupUser();
  const rawToken = await forgotAndGetToken(user.email);

  const reset = await api("/api/reset-password", {
    method: "POST",
    body: { token: rawToken, newPassword: "brand-new-password-1", confirmPassword: "brand-new-password-1" }
  });
  assert.equal(reset.status, 200);
  assert.match(reset.body.message, /password has been reset/i);

  const oldSignin = await api("/api/auth/signin", { method: "POST", body: { email: user.email, password: user.password } });
  assert.equal(oldSignin.status, 401);

  const newSignin = await api("/api/auth/signin", {
    method: "POST",
    body: { email: user.email, password: "brand-new-password-1" }
  });
  assert.equal(newSignin.status, 200);

  const oldSession = await api("/api/auth/me", { cookie: user.cookie });
  assert.equal(oldSession.status, 401, "sessions issued before the reset must be invalidated");

  const reuse = await api("/api/reset-password", {
    method: "POST",
    body: { token: rawToken, newPassword: "another-password-2", confirmPassword: "another-password-2" }
  });
  assert.equal(reuse.status, 400);
  assert.match(reuse.body.message, /invalid or has expired/i);

  const stored = await storedToken(user.email);
  assert.equal(stored.passwordResetTokenHash ?? null, null, "consumed tokens must be cleared");
  assert.ok(stored.passwordChangedAt instanceof Date);
});

test("expired tokens are rejected and leave the password unchanged", async () => {
  const user = await signupUser();
  const rawToken = await forgotAndGetToken(user.email);
  await User.updateOne({ email: user.email }, { $set: { passwordResetExpiresAt: new Date(Date.now() - 1000) } });

  const reset = await api("/api/reset-password", {
    method: "POST",
    body: { token: rawToken, newPassword: "expired-path-password-1", confirmPassword: "expired-path-password-1" }
  });
  assert.equal(reset.status, 400);
  assert.match(reset.body.message, /invalid or has expired/i);

  const signin = await api("/api/auth/signin", { method: "POST", body: { email: user.email, password: user.password } });
  assert.equal(signin.status, 200, "the original password must still work");
});

test("invalid token formats are rejected without touching accounts", async () => {
  const weird = await api("/api/reset-password", {
    method: "POST",
    body: { token: "<script>alert(1)</script>", newPassword: "whatever-password-1", confirmPassword: "whatever-password-1" }
  });
  assert.equal(weird.status, 400);

  const validFormatButUnknown = await api("/api/reset-password", {
    method: "POST",
    body: { token: generateResetToken(), newPassword: "whatever-password-1", confirmPassword: "whatever-password-1" }
  });
  assert.equal(validFormatButUnknown.status, 400);
  assert.match(validFormatButUnknown.body.message, /invalid or has expired/i);
});

test("password mismatch and weak passwords are rejected without consuming the token", async () => {
  const user = await signupUser();
  const rawToken = await forgotAndGetToken(user.email);

  const mismatch = await api("/api/reset-password", {
    method: "POST",
    body: { token: rawToken, newPassword: "mismatched-password-1", confirmPassword: "mismatched-password-2" }
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.message, /do not match/i);

  const weak = await api("/api/reset-password", {
    method: "POST",
    body: { token: rawToken, newPassword: "short", confirmPassword: "short" }
  });
  assert.equal(weak.status, 400);

  const stored = await storedToken(user.email);
  assert.ok(stored.passwordResetTokenHash, "validation failures must not consume the token");

  const good = await api("/api/reset-password", {
    method: "POST",
    body: { token: rawToken, newPassword: "fixed-password-123", confirmPassword: "fixed-password-123" }
  });
  assert.equal(good.status, 200);
});

test("concurrent reset attempts allow exactly one success", async () => {
  const user = await signupUser();
  const rawToken = await forgotAndGetToken(user.email);

  const attempt = () => api("/api/reset-password", {
    method: "POST",
    body: { token: rawToken, newPassword: "concurrent-password-1", confirmPassword: "concurrent-password-1" }
  });
  const [first, second] = await Promise.all([attempt(), attempt()]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 400], "only one concurrent request may consume the token");
});

test("a newer reset request replaces the previous token", async () => {
  const user = await signupUser();
  const firstToken = await forgotAndGetToken(user.email);
  const secondToken = await forgotAndGetToken(user.email);
  assert.notEqual(firstToken, secondToken);

  const stale = await api("/api/reset-password", {
    method: "POST",
    body: { token: firstToken, newPassword: "stale-token-password-1", confirmPassword: "stale-token-password-1" }
  });
  assert.equal(stale.status, 400);

  const fresh = await api("/api/reset-password", {
    method: "POST",
    body: { token: secondToken, newPassword: "fresh-token-password-1", confirmPassword: "fresh-token-password-1" }
  });
  assert.equal(fresh.status, 200);
});
