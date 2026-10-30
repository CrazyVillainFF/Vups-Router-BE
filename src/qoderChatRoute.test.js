import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.SETTINGS_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OLLAMA_BASE_URL;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_qoder_chat_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { startFakeQoder, FAKE_QODER_API_KEY, FAKE_QODER_SA_KEY, FAKE_QODER_MODEL } = await import("./testUtils/fakeQoder.js");

const fake = await startFakeQoder();
const businessUrl = fake.baseUrl;
const openapiUrl = new URL(fake.baseUrl).origin;

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fake.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `qoderchat${Date.now()}-${counter}@example.com`;
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
  return { status: response.status, body: json, text, headers: response.headers };
}

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function signupUser() {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Qoder Chat Tester", email: uniqueEmail(), password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return sessionCookie(response);
}

async function saveQoder(cookie, overrides = {}) {
  const response = await api("/api/settings/providers/qoder-cloud", {
    method: "PUT",
    cookie,
    body: {
      provider: "Qoder Cloud",
      providerId: "qoder-cloud",
      baseUrl: businessUrl,
      apiKey: FAKE_QODER_API_KEY,
      providerType: "qoder_cloud_agents",
      model: FAKE_QODER_MODEL,
      authMode: "pat",
      ...overrides
    }
  });
  assert.equal(response.status, 200);
  return response;
}

const createdSessions = () => fake.state.paths("POST", "/api/v1/cloud/sessions").filter(entry => entry.path === "/api/v1/cloud/sessions");
const postedBatches = () => fake.state.requests.filter(entry => entry.method === "POST" && /\/sessions\/[^/]+\/events$/.test(entry.path));

async function streamTurn(cookie, body) {
  const response = await fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ ...body, stream: true })
  });
  const text = await response.text();
  const events = text
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(Boolean)
    .map(raw => JSON.parse(raw));
  return { status: response.status, events };
}

test("a streamed conversation continues the session Qoder already has", async () => {
  const cookie = await signupUser();
  await saveQoder(cookie);
  fake.state.clearRequests();

  const first = await streamTurn(cookie, { messages: [{ role: "user", content: "Hello" }] });
  assert.equal(first.status, 200);
  const conversationId = first.events.find(event => event.type === "meta").conversationId;
  assert.equal(createdSessions().length, 1);
  const session = fake.state.sessions.at(-1);

  fake.state.clearRequests();
  const second = await streamTurn(cookie, {
    conversationId,
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Second" }
    ]
  });
  assert.equal(second.status, 200);

  assert.equal(createdSessions().length, 0, "streamed turns keep one Qoder session per conversation");
  assert.equal(postedBatches()[0].path, `/api/v1/cloud/sessions/${session.id}/events`, "the second turn posts into the session Qoder already holds");
  assert.deepEqual(postedBatches()[0].body.events[0].content, [{ type: "text", text: "[User]\nSecond" }]);
});

test("a saved service account authenticates its chat turns, not only the connection test", async () => {
  const cookie = await signupUser();
  await saveQoder(cookie, { apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: openapiUrl });
  fake.state.clearRequests();

  const turn = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Hello" }], stream: false }
  });

  assert.equal(turn.status, 200);
  assert.match(turn.body.message.content, /Hello world/);
  assert.equal(fake.state.paths("POST", "/api/v1/serviceToken/exchange").length, 1, "the key is exchanged once per credential");
  const exchange = fake.state.requests.find(entry => entry.path === "/api/v1/serviceToken/exchange");
  assert.equal(exchange.auth, "Bearer <sa-key>");
  const business = fake.state.requests.filter(entry => entry.path.startsWith("/api/v1/cloud/"));
  assert.ok(business.length > 0);
  for (const entry of business) assert.equal(entry.tokenKind, "sat", "the service account key never reaches the business API");
});

test("a saved personal access token goes straight to the business API", async () => {
  const cookie = await signupUser();
  await saveQoder(cookie);
  fake.state.clearRequests();

  const turn = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Hello" }], stream: false }
  });

  assert.equal(turn.status, 200);
  assert.equal(fake.state.paths("POST", "/api/v1/serviceToken/exchange").length, 0);
  assert.equal(fake.state.requests.every(entry => entry.tokenKind === "pat"), true);
});

test("the second message of a conversation continues the session Qoder already has", async () => {
  const cookie = await signupUser();
  await saveQoder(cookie);
  fake.state.clearRequests();

  const first = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Hello" }], stream: false }
  });
  assert.equal(first.status, 200);
  assert.equal(createdSessions().length, 1);
  assert.equal(postedBatches().length, 1);

  fake.state.clearRequests();
  const second = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      conversationId: first.body.conversationId,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Second" }
      ],
      stream: false
    }
  });

  assert.equal(second.status, 200);
  assert.equal(createdSessions().length, 0, "a conversation keeps one Qoder session");
  assert.deepEqual(postedBatches()[0].body.events[0].content, [{ type: "text", text: "[User]\nSecond" }]);
});

test("a streamed Qoder turn reaches the chat client as deltas and one terminal event", async () => {
  const cookie = await signupUser();
  await saveQoder(cookie);
  fake.state.clearRequests();
  fake.state.mode = "delta";

  const response = await fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }], stream: true })
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(Boolean)
    .map(raw => JSON.parse(raw));

  const deltas = events.filter(event => event.type === "delta").map(event => event.content);
  assert.deepEqual(deltas, ["Hello", " world"], "the reply streams in the order Qoder sent it");
  const done = events.filter(event => event.type === "done");
  assert.equal(done.length, 1, "the reply is reported to the client exactly once");
  assert.match(done[0].message.content, /Hello world/);
  assert.equal(events.some(event => event.type === "error"), false);
  fake.state.mode = "buffered";
});

test("a Qoder auth failure is actionable and never repeats the credential", async () => {
  const cookie = await signupUser();
  await saveQoder(cookie);
  fake.state.clearRequests();
  fake.state.unauthorized = true;

  const turn = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Hello" }], stream: false }
  });

  fake.state.unauthorized = false;
  assert.ok(turn.status >= 400, `expected a failure, got ${turn.status}`);
  assert.equal(turn.body.code, "invalid_api_key");
  assert.doesNotMatch(JSON.stringify(turn.body), new RegExp(FAKE_QODER_API_KEY));
  assert.match(turn.body.message, /personal access token/i);
});

test("a Qoder conversation never answers with another provider's reply", async () => {
  const cookie = await signupUser();
  await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: { provider: "Fake", baseUrl: `${openapiUrl}/unused-v1`, apiKey: "unused", model: "fake-model-mini" }
  });
  await saveQoder(cookie);
  fake.state.clearRequests();
  fake.state.unauthorized = true;

  const turn = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { providerId: "qoder-cloud", messages: [{ role: "user", content: "Hello" }], stream: false }
  });
  fake.state.unauthorized = false;

  assert.ok(turn.status >= 400, "a failing Qoder turn is a failure, not a silent substitution");
  assert.notEqual(turn.body.code, undefined);
  assert.equal(fake.state.requests.some(entry => entry.path.startsWith("/api/v1/cloud/")), true, "Qoder itself was asked");
});
