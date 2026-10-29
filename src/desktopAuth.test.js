import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.DESKTOP_AUTH_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_desktop_auth_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: DesktopAuthRequest, hashToken } = await import("./desktopAuth.js");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `handoff-${Date.now()}-${counter}@example.com`;
}

function verifier() {
  return randomBytes(32).toString("base64url");
}

function challengeOf(value) {
  return createHash("sha256").update(value).digest("base64url");
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
  return { status: response.status, json, cookie: response.headers.get("set-cookie") || "" };
}

async function signedInUser() {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Handoff Tester", email: uniqueEmail(), password: "handoff-pass-123" }
  });
  assert.equal(response.status, 201);
  const cookie = response.cookie.split(";")[0];
  assert.match(cookie, /^vr_session=/);
  return { cookie, user: response.json.user };
}

async function begin() {
  const secret = verifier();
  const started = await api("/api/auth/desktop/start", {
    method: "POST",
    body: { challenge: challengeOf(secret), client: "windows" }
  });
  assert.equal(started.status, 201);
  assert.match(started.json.ticket, /^[A-Za-z0-9_-]{43}$/);
  return { ticket: started.json.ticket, verifier: secret };
}

test("a pending sign-in stays pending until the browser approves it", async () => {
  const { ticket, verifier: secret } = await begin();
  const poll = await api("/api/auth/desktop/poll", {
    method: "POST",
    body: { ticket, verifier: secret }
  });
  assert.equal(poll.status, 202);
  assert.equal(poll.json.status, "pending");
  assert.equal(poll.cookie, "");
});

test("approval requires a signed-in browser session", async () => {
  const { ticket } = await begin();
  const approve = await api("/api/auth/desktop/approve", {
    method: "POST",
    body: { ticket }
  });
  assert.equal(approve.status, 401);
});

test("approval then poll hands the session to the app exactly once", async () => {
  const { ticket, verifier: secret } = await begin();
  const { cookie, user } = await signedInUser();

  const approve = await api("/api/auth/desktop/approve", {
    method: "POST",
    body: { ticket },
    cookie
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.json.status, "approved");

  const poll = await api("/api/auth/desktop/poll", {
    method: "POST",
    body: { ticket, verifier: secret }
  });
  assert.equal(poll.status, 200);
  assert.equal(poll.json.status, "approved");
  assert.equal(poll.json.user.email, user.email);
  assert.match(poll.cookie, /vr_session=/);
  assert.equal(poll.json.token, undefined, "no long-lived token is returned in a body");

  const session = await api("/api/auth/me", { cookie: poll.cookie.split(";")[0] });
  assert.equal(session.status, 200);
  assert.equal(session.json.user.email, user.email);

  const replay = await api("/api/auth/desktop/poll", {
    method: "POST",
    body: { ticket, verifier: secret }
  });
  assert.equal(replay.status, 410);
  assert.equal(replay.cookie, "");
});

test("a wrong verifier cannot redeem an approved ticket", async () => {
  const { ticket } = await begin();
  const { cookie } = await signedInUser();
  await api("/api/auth/desktop/approve", { method: "POST", body: { ticket }, cookie });

  const poll = await api("/api/auth/desktop/poll", {
    method: "POST",
    body: { ticket, verifier: verifier() }
  });
  assert.equal(poll.status, 400);
  assert.equal(poll.json.status, "invalid");
  assert.equal(poll.cookie, "");

  const stillPending = await api("/api/auth/desktop/poll", {
    method: "POST",
    body: { ticket, verifier: verifier() }
  });
  assert.equal(stillPending.status, 400);
});

test("expired tickets are rejected by approve and poll", async () => {
  const { ticket, verifier: secret } = await begin();
  const { cookie } = await signedInUser();
  await DesktopAuthRequest.updateOne(
    { ticketHash: hashToken(ticket) },
    { expiresAt: new Date(Date.now() - 1000) }
  );

  const approve = await api("/api/auth/desktop/approve", { method: "POST", body: { ticket }, cookie });
  assert.equal(approve.status, 410);

  const poll = await api("/api/auth/desktop/poll", {
    method: "POST",
    body: { ticket, verifier: secret }
  });
  assert.equal(poll.status, 410);
  assert.equal(poll.cookie, "");
});

test("a second account cannot take over an approved ticket", async () => {
  const { ticket } = await begin();
  const first = await signedInUser();
  const second = await signedInUser();
  const approve = await api("/api/auth/desktop/approve", { method: "POST", body: { ticket }, cookie: first.cookie });
  assert.equal(approve.status, 200);

  const hijack = await api("/api/auth/desktop/approve", { method: "POST", body: { ticket }, cookie: second.cookie });
  assert.equal(hijack.status, 409);
});

test("malformed tickets and challenges are rejected before touching the database", async () => {
  const short = await api("/api/auth/desktop/start", {
    method: "POST",
    body: { challenge: "not-a-challenge" }
  });
  assert.equal(short.status, 400);

  const poll = await api("/api/auth/desktop/poll", {
    method: "POST",
    body: { ticket: "x", verifier: "y" }
  });
  assert.equal(poll.status, 400);

  const approve = await api("/api/auth/desktop/approve", {
    method: "POST",
    body: { ticket: "x" }
  });
  assert.equal(approve.status, 401);
});
