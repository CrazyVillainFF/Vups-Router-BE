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
process.env.PASSWORD_RESET_SEND_LIMIT_MAX = "4";
process.env.SENDER_EMAIL = "vupriseoffical@gmail.com";
delete process.env.MONGODB_URI;
delete process.env.BREVO_API_KEY;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_reset_send_limit_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: ResetSendLog } = await import("./resetSendLog.js");
const { RESET_SEND_LIMIT, RESET_SEND_WINDOW_MS, hashResetEmail } = await import("./resetThrottle.js");
const { startFakeBrevo, FAKE_BREVO_KEY } = await import("./testUtils/fakeBrevo.js");

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
  return `send-limit-${Date.now()}-${counter}@example.com`;
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
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

function forgot(email) {
  return api("/api/forgot-password", { method: "POST", body: { email } });
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function signupUser() {
  const email = uniqueEmail();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Send Limit Tester", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return { email, cookie: sessionCookie(response) };
}

test("the limit honors PASSWORD_RESET_SEND_LIMIT_MAX", () => {
  assert.equal(RESET_SEND_LIMIT, 4);
  assert.equal(RESET_SEND_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test("four code requests are allowed per 24 hours and the fifth is rejected with a clear 429", async () => {
  const { email } = await signupUser();
  fakeBrevo.state.reset();

  const remaining = [];
  for (let i = 0; i < 4; i += 1) {
    const response = await forgot(email);
    assert.equal(response.status, 200, `send ${i + 1} must be allowed`);
    assert.equal(response.body.limit, 4);
    remaining.push(response.body.remaining);
  }
  assert.deepEqual(remaining, [3, 2, 1, 0], "remaining must count down with each send");
  assert.equal(fakeBrevo.state.requests.length, 4);

  const fifth = await forgot(email);
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.code, "reset_send_limit");
  assert.match(fifth.body.message, /at most 4 codes per 24 hours/);
  assert.match(fifth.body.message, /try again in about \d+ minutes?/i);
  assert.ok(Number(fifth.headers.get("retry-after")) > 0, "a Retry-After header must be present");
  assert.doesNotMatch(JSON.stringify(fifth.body), /brevo|api-key|stack/i);
  assert.equal(fakeBrevo.state.requests.length, 4, "the rejected request must not attempt email delivery");
});

test("unknown addresses share the identical counter and 429 behavior (no account enumeration)", async () => {
  const unknownEmail = uniqueEmail();
  const knownEmail = (await signupUser()).email;

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await forgot(unknownEmail)).status, 200);
  }
  const unknownRejected = await forgot(unknownEmail);
  assert.equal(unknownRejected.status, 429);
  assert.equal(unknownRejected.body.code, "reset_send_limit");

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await forgot(knownEmail)).status, 200);
  }
  const knownRejected = await forgot(knownEmail);
  assert.equal(knownRejected.status, 429);
  assert.equal(knownRejected.body.code, "reset_send_limit");

  assert.equal(unknownRejected.body.message.replace(/\d+ minutes?/i, "N minutes"), knownRejected.body.message.replace(/\d+ minutes?/i, "N minutes"));
  assert.ok(Number(unknownRejected.headers.get("retry-after")) > 0);
  assert.ok(Number(knownRejected.headers.get("retry-after")) > 0);

  const stored = await ResetSendLog.findOne({ emailHash: hashResetEmail(unknownEmail) }).lean();
  assert.equal(stored.sends.length, 4, "even unknown addresses are tracked so the limit cannot be reset by typos");
});

test("the rolling window forgets sends once they are older than 24 hours", async () => {
  const email = uniqueEmail();
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await forgot(email)).status, 200);
  }
  assert.equal((await forgot(email)).status, 429);

  const staleDate = new Date(Date.now() - RESET_SEND_WINDOW_MS - 60 * 60 * 1000);
  await ResetSendLog.updateOne(
    { emailHash: hashResetEmail(email) },
    { $set: { sends: [staleDate, staleDate, staleDate, staleDate] } }
  );

  const afterWindow = await forgot(email);
  assert.equal(afterWindow.status, 200, "sends older than 24 hours must no longer count");
  assert.equal(afterWindow.body.remaining, 3);

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await forgot(email)).status, 200);
  }
  assert.equal((await forgot(email)).status, 429, "the limit applies again after the window rolls");
});

test("concurrent requests cannot bypass the limit", async () => {
  const { email } = await signupUser();
  fakeBrevo.state.reset();

  const responses = await Promise.all(Array.from({ length: 6 }, () => forgot(email)));
  const allowed = responses.filter(response => response.status === 200);
  const rejected = responses.filter(response => response.status === 429);

  assert.equal(allowed.length, 4, "exactly four concurrent requests must be allowed");
  assert.equal(rejected.length, 2, "the rest must be rejected");
  assert.equal(fakeBrevo.state.requests.length, 4, "only allowed requests may trigger email delivery");
  for (const response of rejected) {
    assert.equal(response.body.code, "reset_send_limit");
  }
});

test("failed email deliveries still count against the limit", async () => {
  const { email } = await signupUser();
  fakeBrevo.state.reset();
  fakeBrevo.state.set({ status: 500 });

  for (let i = 0; i < 4; i += 1) {
    const response = await forgot(email);
    assert.equal(response.status, 200, "the API keeps its enumeration-safe response even when delivery fails");
  }
  assert.equal(fakeBrevo.state.requests.length, 4, "all four attempts reached the email provider");

  fakeBrevo.state.set({ status: 201 });
  const fifth = await forgot(email);
  assert.equal(fifth.status, 429, "a failed delivery must not reset the counter");
});
