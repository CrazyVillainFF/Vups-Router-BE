import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { startFakeProvider, FAKE_API_KEY, FAKE_MODELS } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();
const { startFakeOllama, FAKE_OLLAMA_MODEL } = await import("./testUtils/fakeOllama.js");
const fakeOllama = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fakeOllama.baseUrl;
process.env.OLLAMA_MODEL = FAKE_OLLAMA_MODEL;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_BASE_URL;
delete process.env.OPENROUTER_MODEL;

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await fakeOllama.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let emailCounter = 0;
function uniqueEmail() {
  emailCounter += 1;
  return `user${Date.now()}-${emailCounter}@example.com`;
}

async function api(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
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
  return { status: response.status, body: json, headers: response.headers, text };
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
    body: { name: "Test User", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return { email, cookie: sessionCookie(response), body: response.body };
}

async function configureProvider(cookie, overrides = {}) {
  const response = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "Fake OpenAI-compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-mini",
      ...overrides
    }
  });
  return response;
}

// ─── Service basics ─────────────────────────────────────────────────────────

test("GET / returns the backend online response", async () => {
  const response = await api("/");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    success: true,
    message: "VupsRouter Backend API is running",
    service: "VupsRouter",
    status: "online"
  });
});

test("GET /api/health reports MongoDB as connected", async () => {
  const response = await api("/api/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.database, "connected");
});

test("unknown API routes return a JSON 404", async () => {
  const response = await api("/api/does-not-exist");
  assert.equal(response.status, 404);
  assert.match(response.body.message, /does not exist/);
});

test("CORS allows the Vite frontend with credentials", async () => {
  const response = await api("/", { headers: { Origin: "http://localhost:5173" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});

test("CORS rejects unknown origins", async () => {
  const response = await api("/", { headers: { Origin: "https://evil.example.com" } });
  assert.equal(response.status, 403);
});

test("state-changing requests from unknown origins are blocked", async () => {
  const response = await api("/api/auth/signin", {
    method: "POST",
    body: { email: "a@example.com", password: "correct-horse-battery" },
    headers: { Origin: "https://evil.example.com" }
  });
  assert.equal(response.status, 403);
});

// ─── Registration and login ─────────────────────────────────────────────────

test("registration succeeds, hashes the password, and sets an HTTP-only session cookie", async () => {
  const email = uniqueEmail();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Alex Router", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.email, email);
  assert.equal(response.body.user.name, "Alex Router");
  assert.equal(response.body.user.password, undefined);
  assert.equal(response.body.user.passwordHash, undefined);

  const setCookies = response.headers.getSetCookie();
  const session = setCookies.find(value => value.startsWith("vr_session="));
  assert.ok(session, "session cookie must be set");
  assert.match(session, /HttpOnly/i);

  const stored = await mongoose.connection.db.collection("users").findOne({ email });
  assert.ok(stored.passwordHash.startsWith("$2"), "password must be bcrypt hashed");
  assert.notEqual(stored.passwordHash, "correct-horse-battery");
});

test("registration rejects invalid input with clear messages", async () => {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "A", email: "not-an-email", password: "short" }
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /Name/);
});

test("duplicate registration is rejected", async () => {
  const { email } = await signupUser();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Second User", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 409);
  assert.match(response.body.message, /already exists/i);
});

test("login succeeds with the correct password and sets a session cookie", async () => {
  const { email } = await signupUser();
  const response = await api("/api/auth/signin", {
    method: "POST",
    body: { email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, email);
  assert.ok(sessionCookie(response));
});

test("login fails with the wrong password and does not set a cookie", async () => {
  const { email } = await signupUser();
  const response = await api("/api/auth/signin", {
    method: "POST",
    body: { email, password: "wrong-password-123" }
  });
  assert.equal(response.status, 401);
  assert.match(response.body.message, /incorrect/i);
  assert.equal(sessionCookie(response), null);
});

test("login fails for an unknown email with the same generic message", async () => {
  const response = await api("/api/auth/signin", {
    method: "POST",
    body: { email: `missing-${Date.now()}@example.com`, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 401);
  assert.match(response.body.message, /incorrect/i);
});

// ─── Sessions, /me, logout, protected routes ────────────────────────────────

test("/me returns the signed-in user, protected routes reject anonymous requests", async () => {
  const { cookie, email } = await signupUser();
  const me = await api("/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, email);

  const anonymous = await api("/api/auth/me");
  assert.equal(anonymous.status, 401);

  const anonymousConversations = await api("/api/conversations");
  assert.equal(anonymousConversations.status, 401);

  const anonymousChat = await api("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(anonymousChat.status, 401);
});

test("logout clears the session cookie and invalidates the session", async () => {
  const { cookie } = await signupUser();
  const logout = await api("/api/auth/logout", { method: "POST", cookie });
  assert.equal(logout.status, 200);
  const cleared = logout.headers.getSetCookie().find(value => value.startsWith("vr_session="));
  assert.ok(cleared);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);

  const me = await api("/api/auth/me", { cookie: "vr_session=" });
  assert.equal(me.status, 401);
});

// ─── Provider configuration ─────────────────────────────────────────────────

test("provider config starts empty and saves encrypted keys without echoing them", async () => {
  const { cookie } = await signupUser();

  const initial = await api("/api/settings/provider", { cookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.config.configured, false);

  const saved = await configureProvider(cookie);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.provider, "Fake OpenAI-compatible");
  assert.equal(saved.body.config.model, "fake-model-mini");
  assert.equal(saved.body.config.hasApiKey, true);
  assert.notEqual(saved.body.config.apiKeyMasked, FAKE_API_KEY);
  assert.match(saved.body.config.apiKeyMasked, /•/);

  const fetched = await api("/api/settings/provider", { cookie });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.config.apiKeyMasked, saved.body.config.apiKeyMasked);
  assert.doesNotMatch(JSON.stringify(fetched.body), new RegExp(FAKE_API_KEY));

  const stored = await mongoose.connection.db.collection("providerconfigs").findOne({});
  assert.ok(stored.encryptedApiKey.startsWith("v1:"));
  assert.doesNotMatch(stored.encryptedApiKey, new RegExp(FAKE_API_KEY));
});

test("provider config rejects invalid URLs and short keys", async () => {
  const { cookie } = await signupUser();
  const badUrl = await configureProvider(cookie, { baseUrl: "not-a-url" });
  assert.equal(badUrl.status, 400);
  assert.match(badUrl.body.message, /valid URL/i);

  const badKey = await configureProvider(cookie, { apiKey: "x" });
  assert.equal(badKey.status, 400);
  assert.match(badKey.body.message, /API key/i);
});

test("provider config can be updated and deleted", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  const updated = await configureProvider(cookie, { provider: "Updated", model: "fake-model-pro" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.config.provider, "Updated");
  assert.equal(updated.body.config.model, "fake-model-pro");

  const deleted = await api("/api/settings/provider", { method: "DELETE", cookie });
  assert.equal(deleted.status, 200);
  const afterDelete = await api("/api/settings/provider", { cookie });
  assert.equal(afterDelete.body.config.configured, false);
});

test("updating provider config without a new key keeps the saved key and it still works", async () => {
  const { cookie } = await signupUser();
  const saved = await configureProvider(cookie);
  const updated = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: { provider: "Renamed provider", baseUrl: fakeProvider.baseUrl, apiKey: "", model: "fake-model-pro" }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.config.provider, "Renamed provider");
  assert.equal(updated.body.config.model, "fake-model-pro");
  assert.equal(updated.body.config.apiKeyMasked, saved.body.config.apiKeyMasked);

  fakeProvider.state.reset();
  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "key kept?" }] }
  });
  assert.equal(chat.status, 200);
  assert.equal(fakeProvider.state.chatRequests[0].key, FAKE_API_KEY);
  assert.match(chat.body.message.content, /fake-model-pro/);
  fakeProvider.state.reset();
});

test("test connection succeeds against a compatible provider and lists models", async () => {
  const { cookie } = await signupUser();
  const response = await api("/api/settings/provider/test", {
    method: "POST",
    cookie,
    body: { provider: "Fake", baseUrl: fakeProvider.baseUrl, apiKey: FAKE_API_KEY, model: "fake-model-pro" }
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.modelChecked, true);
  assert.deepEqual(response.body.availableModels.map(model => model.id), FAKE_MODELS);
});

test("test connection reports an invalid API key clearly", async () => {
  const { cookie } = await signupUser();
  const response = await api("/api/settings/provider/test", {
    method: "POST",
    cookie,
    body: { provider: "Fake", baseUrl: fakeProvider.baseUrl, apiKey: "sk-wrong-key-000", model: "fake-model-mini" }
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.message, /API key/i);
});

test("test connection reports an unavailable model without substituting one", async () => {
  const { cookie } = await signupUser();
  const response = await api("/api/settings/provider/test", {
    method: "POST",
    cookie,
    body: { provider: "Fake", baseUrl: fakeProvider.baseUrl, apiKey: FAKE_API_KEY, model: "does-not-exist" }
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /does not list a model named "does-not-exist"/);
});

test("test connection reports unreachable endpoints and bad URLs", async () => {
  const { cookie } = await signupUser();
  const badUrl = await api("/api/settings/provider/test", {
    method: "POST",
    cookie,
    body: { provider: "Fake", baseUrl: "ftp://example.com/v1", apiKey: FAKE_API_KEY }
  });
  assert.equal(badUrl.status, 400);
  assert.match(badUrl.body.message, /http:\/\/ or https:\/\//);

  const unreachable = await api("/api/settings/provider/test", {
    method: "POST",
    cookie,
    body: { provider: "Fake", baseUrl: "http://127.0.0.1:9/v1", apiKey: FAKE_API_KEY }
  });
  assert.equal(unreachable.status, 400);
  assert.match(unreachable.body.message, /Could not reach|connect|fetch failed|ECONNREFUSED/i);
});

test("model listing offers the shared model to users with no provider configuration", async () => {
  const { cookie } = await signupUser();
  const response = await api("/api/settings/models", { cookie });
  assert.equal(response.status, 200);
  const shared = response.body.models.find(model => model.id === FAKE_OLLAMA_MODEL);
  assert.ok(shared, "expected the shared Ollama model in the list");
  assert.equal(shared.shared, true);
  assert.equal(response.body.shared.status, "available");
});

test("saved configuration lists provider models plus the shared model", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  const response = await api("/api/settings/models", { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.models.filter(model => !model.shared).map(model => model.id), FAKE_MODELS);
  assert.deepEqual(response.body.models.filter(model => model.shared).map(model => model.id), [FAKE_OLLAMA_MODEL]);
});

// ─── Chat proxy ─────────────────────────────────────────────────────────────

test("chat returns a real provider response (non-streaming), persists it, and never substitutes models", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      model: "fake-model-pro",
      messages: [{ role: "user", content: "Say hi in one line." }]
    }
  });
  assert.equal(response.status, 200);
  assert.match(response.body.message.content, /Echo from fake-model-pro/);
  assert.ok(response.body.conversationId);

  assert.equal(fakeProvider.state.chatRequests.length, 1);
  assert.equal(fakeProvider.state.chatRequests[0].body.model, "fake-model-pro");

  const conversation = await api(`/api/conversations/${response.body.conversationId}`, { cookie });
  assert.equal(conversation.status, 200);
  assert.equal(conversation.body.conversation.messages.length, 2);
  assert.equal(conversation.body.conversation.messages[0].role, "user");
  assert.equal(conversation.body.conversation.messages[1].role, "assistant");
  assert.match(conversation.body.conversation.messages[1].content, /Echo from fake-model-pro/);
});

test("chat requires a configured provider and a selected model", async () => {
  const { cookie } = await signupUser();
  const unconfigured = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(unconfigured.status, 200, "users without a provider fall back to the shared model");

  await configureProvider(cookie, { model: "" });
  const noModel = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(noModel.status, 400);
  assert.equal(noModel.body.code, "no_model");
});

test("chat validates the message payload", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  const empty = await api("/api/chat", { method: "POST", cookie, body: { messages: [] } });
  assert.equal(empty.status, 400);
  const badRole = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "system", content: "hi" }] }
  });
  assert.equal(badRole.status, 400);
  const lastAssistant = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "assistant", content: "hi" }] }
  });
  assert.equal(lastAssistant.status, 400);
});

test("chat surfaces provider errors clearly (invalid key, rate limit, unavailable model)", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);

  fakeProvider.state.set({ invalidKey: true });
  const badKey = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(badKey.status, 400);
  assert.match(badKey.body.message, /API key/i);

  fakeProvider.state.reset();
  fakeProvider.state.set({ chatStatus: 429 });
  const rateLimited = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(rateLimited.status, 400);
  assert.match(rateLimited.body.message, /Rate limit/i);

  fakeProvider.state.reset();
  const unavailable = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, model: "model-that-does-not-exist", messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(unavailable.status, 400);
  assert.match(unavailable.body.message, /model/i);
  assert.equal(fakeProvider.state.chatRequests.at(-1).body.model, "model-that-does-not-exist");

  fakeProvider.state.reset();
});

test("chat streams SSE deltas from the provider and persists the final text", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();

  const response = await fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Stream please" }] })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();

  const events = text
    .split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
  const meta = events.find(event => event.type === "meta");
  assert.ok(meta?.conversationId, "stream must start with a conversation id");
  const deltas = events.filter(event => event.type === "delta").map(event => event.content).join("");
  assert.equal(deltas, "Hello from fake-model-mini!");
  const done = events.find(event => event.type === "done");
  assert.ok(done, "stream must end with a done event");
  assert.equal(events.some(event => event.type === "error"), false);

  const conversation = await api(`/api/conversations/${meta.conversationId}`, { cookie });
  assert.equal(conversation.status, 200);
  assert.match(conversation.body.conversation.messages.at(-1).content, /Hello from fake-model-mini!/);
});

test("chat stream reports a mid-stream provider failure without faking success", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ failStreamMidway: true });

  const response = await fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Break please" }] })
  });
  const text = await response.text();
  const events = text
    .split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
  const errorEvent = events.find(event => event.type === "error");
  assert.ok(errorEvent, "mid-stream errors must be reported");
  assert.match(errorEvent.message, /error/i);

  fakeProvider.state.reset();
});

// ─── Conversation history and isolation ─────────────────────────────────────

test("conversation history can be listed and deleted, and is capped per user", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  const first = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "First conversation" }] }
  });
  const second = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "Second conversation" }] }
  });
  assert.ok(first.body.conversationId);
  assert.ok(second.body.conversationId);
  assert.notEqual(first.body.conversationId, second.body.conversationId);

  const list = await api("/api/conversations", { cookie });
  const ids = list.body.conversations.map(conversation => conversation.id);
  assert.ok(ids.includes(first.body.conversationId));
  assert.ok(ids.includes(second.body.conversationId));

  const removed = await api(`/api/conversations/${first.body.conversationId}`, { method: "DELETE", cookie });
  assert.equal(removed.status, 200);
  const missing = await api(`/api/conversations/${first.body.conversationId}`, { cookie });
  assert.equal(missing.status, 404);
});

test("users cannot read, delete, or continue each other's conversations or configs", async () => {
  const alice = await signupUser();
  const bob = await signupUser();
  await configureProvider(alice.cookie);
  await configureProvider(bob.cookie, { model: "fake-model-pro" });

  const aliceChat = await api("/api/chat", {
    method: "POST",
    cookie: alice.cookie,
    body: { stream: false, messages: [{ role: "user", content: "Alice secret" }] }
  });
  const aliceConversationId = aliceChat.body.conversationId;

  const bobRead = await api(`/api/conversations/${aliceConversationId}`, { cookie: bob.cookie });
  assert.equal(bobRead.status, 404);

  const bobDelete = await api(`/api/conversations/${aliceConversationId}`, { method: "DELETE", cookie: bob.cookie });
  assert.equal(bobDelete.status, 404);

  const bobContinue = await api("/api/chat", {
    method: "POST",
    cookie: bob.cookie,
    body: {
      stream: false,
      conversationId: aliceConversationId,
      messages: [{ role: "user", content: "Bob injects" }]
    }
  });
  assert.equal(bobContinue.status, 200);
  assert.notEqual(bobContinue.body.conversationId, aliceConversationId);

  const aliceStillThere = await api(`/api/conversations/${aliceConversationId}`, { cookie: alice.cookie });
  assert.equal(aliceStillThere.status, 200);
  assert.match(aliceStillThere.body.conversation.messages[0].content, /Alice secret/);

  const bobList = await api("/api/conversations", { cookie: bob.cookie });
  assert.equal(bobList.body.conversations.some(item => item.id === aliceConversationId), false);

  const bobConfig = await api("/api/settings/provider", { cookie: bob.cookie });
  assert.equal(bobConfig.body.config.model, "fake-model-pro");

  const aliceConfig = await api("/api/settings/provider", { cookie: alice.cookie });
  assert.equal(aliceConfig.body.config.model, "fake-model-mini");
});

// ─── DeepSeek-style provider error mapping, quotas, and administration ─────

test("chat reports insufficient balance (HTTP 402) with a stable code", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ chatStatus: 402 });
  try {
    const response = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "insufficient_credits");
    assert.match(response.body.message, /insufficient credits/i);
  } finally {
    fakeProvider.state.reset();
  }
});

test("chat surfaces provider timeouts and outages with stable codes", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ chatStatus: 503 });
  try {
    const response = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "provider_unavailable");
    assert.match(response.body.message, /temporarily unavailable/i);
  } finally {
    fakeProvider.state.reset();
  }
});

test("test connection records its status for the settings page without leaking the key", async () => {
  const { cookie } = await signupUser();
  await configureProvider(cookie);

  const ok = await api("/api/settings/provider/test", { method: "POST", cookie, body: {} });
  assert.equal(ok.status, 200);
  let config = await api("/api/settings/provider", { cookie });
  assert.equal(config.body.config.lastTest.status, "connected");
  assert.equal(JSON.stringify(config.body).includes(FAKE_API_KEY), false);

  fakeProvider.state.set({ listStatus: 401 });
  const bad = await api("/api/settings/provider/test", { method: "POST", cookie, body: {} });
  assert.equal(bad.status, 400);
  config = await api("/api/settings/provider", { cookie });
  assert.equal(config.body.config.lastTest.status, "invalid_key");
  fakeProvider.state.reset();
});

test("per-user daily quota is enforced and reported clearly", async () => {
  process.env.AI_DAILY_QUOTA = "2";
  try {
    const { cookie } = await signupUser();
    await configureProvider(cookie);
    const send = () =>
      api("/api/chat", {
        method: "POST",
        cookie,
        body: { stream: false, messages: [{ role: "user", content: "quota check" }] }
      });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const third = await send();
    assert.equal(third.status, 429);
    assert.equal(third.body.code, "quota_exceeded");
    assert.match(third.body.message, /Daily AI request limit/i);
  } finally {
    delete process.env.AI_DAILY_QUOTA;
  }
});

test("only administrators can manage AI access and disabled users cannot chat", async () => {
  const admin = await signupUser();
  const victim = await signupUser();
  await configureProvider(victim.cookie);
  process.env.ADMIN_EMAILS = admin.email;
  try {
    const forbidden = await api("/api/admin/ai-access", {
      method: "POST",
      cookie: victim.cookie,
      body: { email: victim.email, enabled: false }
    });
    assert.equal(forbidden.status, 403);

    const disabled = await api("/api/admin/ai-access", {
      method: "POST",
      cookie: admin.cookie,
      body: { email: victim.email, enabled: false }
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.user.aiEnabled, false);

    const blockedChat = await api("/api/chat", {
      method: "POST",
      cookie: victim.cookie,
      body: { stream: false, messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(blockedChat.status, 403);
    assert.equal(blockedChat.body.code, "ai_disabled");

    const reEnabled = await api("/api/admin/ai-access", {
      method: "POST",
      cookie: admin.cookie,
      body: { email: victim.email, enabled: true }
    });
    assert.equal(reEnabled.status, 200);
    const chatWorks = await api("/api/chat", {
      method: "POST",
      cookie: victim.cookie,
      body: { stream: false, messages: [{ role: "user", content: "hi again" }] }
    });
    assert.equal(chatWorks.status, 200);
  } finally {
    delete process.env.ADMIN_EMAILS;
  }
});

test("malformed JSON bodies are rejected with a clear 400", async () => {
  const response = await fetch(`${baseURL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{broken json"
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /valid JSON/i);
});

// ─── Shared Ollama model ────────────────────────────────────────────────────

const { setSharedModelEnabled } = await import("./ollama.js");

test("shared model status is visible to signed-in users and never leaks the private server URL", async () => {
  const { cookie } = await signupUser();
  const response = await api("/api/settings/shared-model", { cookie });
  assert.equal(response.status, 200);
  assert.equal(response.body.shared.model, FAKE_OLLAMA_MODEL);
  assert.equal(response.body.shared.enabled, true);
  assert.equal(response.body.shared.available, true);
  assert.equal(response.body.shared.status, "available");
  assert.ok(!JSON.stringify(response.body).includes(fakeOllama.baseUrl), "shared status must not include the Ollama base URL");
});

test("a brand-new user can chat through the shared model without configuring anything", async () => {
  const { cookie } = await signupUser();
  fakeOllama.state.chatRequests.length = 0;
  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "hello shared model" }] }
  });
  assert.equal(response.status, 200);
  assert.match(response.body.message.content, /Shared reply from gemma3:4b/);
  assert.equal(fakeOllama.state.chatRequests.length, 1);
  assert.equal(fakeOllama.state.chatRequests[0].body.model, FAKE_OLLAMA_MODEL);
  assert.equal(fakeOllama.state.chatRequests[0].body.max_tokens, 1024);
  const conversations = await api("/api/conversations", { cookie });
  assert.equal(conversations.body.conversations.length, 1);
});

test("new users can stream from the shared model", async () => {
  const { cookie } = await signupUser();
  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: true, model: FAKE_OLLAMA_MODEL, messages: [{ role: "user", content: "stream please" }] }
  });
  assert.equal(response.status, 200);
  assert.match(response.text, /"type":"delta"/);
  assert.match(response.text, /"type":"done"/);
  assert.match(response.text, /Shared /);
});

test("users with their own provider keep it, and shared requests never use personal credentials", async () => {
  const personal = await signupUser();
  await configureProvider(personal.cookie);
  fakeProvider.state.reset();
  const viaPersonal = await api("/api/chat", {
    method: "POST",
    cookie: personal.cookie,
    body: { stream: false, messages: [{ role: "user", content: "personal path" }] }
  });
  assert.equal(viaPersonal.status, 200);
  assert.equal(fakeProvider.state.chatRequests.length, 1);

  const fresh = await signupUser();
  fakeProvider.state.reset();
  fakeOllama.state.chatRequests.length = 0;
  const viaShared = await api("/api/chat", {
    method: "POST",
    cookie: fresh.cookie,
    body: { stream: false, model: FAKE_OLLAMA_MODEL, messages: [{ role: "user", content: "shared path" }] }
  });
  assert.equal(viaShared.status, 200);
  assert.equal(fakeProvider.state.chatRequests.length, 0, "shared requests must not reach the personal provider");
  assert.equal(fakeOllama.state.chatRequests.length, 1);
});

test("a user without a provider cannot borrow another user's personal model or credentials", async () => {
  const owner = await signupUser();
  await configureProvider(owner.cookie);
  const stranger = await signupUser();
  fakeProvider.state.reset();
  fakeOllama.state.chatRequests.length = 0;
  const response = await api("/api/chat", {
    method: "POST",
    cookie: stranger.cookie,
    body: { stream: false, model: "fake-model-mini", messages: [{ role: "user", content: "give me the personal model" }] }
  });
  assert.equal(response.status, 400);
  assert.equal(fakeProvider.state.chatRequests.length, 0, "stranger must not reach the owner's provider");
  assert.equal(fakeOllama.state.chatRequests.length, 1, "request must go to the shared server with the owner's key absent");
  assert.ok(!fakeOllama.state.chatRequests[0].authorization.includes(FAKE_API_KEY));
});

test("unauthorized requests cannot use the shared model", async () => {
  const models = await api("/api/settings/models");
  assert.equal(models.status, 401);
  const shared = await api("/api/settings/shared-model");
  assert.equal(shared.status, 401);
  const chat = await api("/api/chat", {
    method: "POST",
    body: { stream: false, messages: [{ role: "user", content: "no cookie" }] }
  });
  assert.equal(chat.status, 401);
});

test("missing Ollama configuration is reported honestly", async () => {
  const previous = process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_BASE_URL;
  try {
    const { cookie } = await signupUser();
    const status = await api("/api/settings/shared-model", { cookie });
    assert.equal(status.status, 200);
    assert.equal(status.body.shared.status, "not_configured");
    assert.equal(status.body.shared.available, false);
    const models = await api("/api/settings/models", { cookie });
    assert.equal(models.status, 400);
    assert.equal(models.body.code, "shared_unavailable");
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(chat.status, 503);
    assert.equal(chat.body.code, "shared_unavailable");
    assert.match(chat.body.message, /not configured/i);
  } finally {
    process.env.OLLAMA_BASE_URL = previous;
  }
});

test("an unreachable Ollama server is reported as unreachable", async () => {
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
  try {
    const { cookie } = await signupUser();
    const status = await api("/api/settings/shared-model", { cookie });
    assert.equal(status.body.shared.status, "unreachable");
    assert.equal(status.body.shared.available, false);
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(chat.status, 503);
    assert.equal(chat.body.code, "shared_unavailable");
    assert.match(chat.body.message, /unreachable/i);
  } finally {
    process.env.OLLAMA_BASE_URL = previous;
  }
});

test("a missing shared model is reported instead of pretending it is available", async () => {
  fakeOllama.state.installed = ["llama3:8b"];
  try {
    const { cookie } = await signupUser();
    const status = await api("/api/settings/shared-model", { cookie });
    assert.equal(status.body.shared.status, "missing_model");
    assert.equal(status.body.shared.available, false);
    const models = await api("/api/settings/models", { cookie });
    assert.equal(models.status, 400);
    assert.equal(models.body.code, "shared_unavailable");
    assert.equal(models.body.shared.status, "missing_model");
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(chat.status, 503);
    assert.match(chat.body.message, /not installed/i);
  } finally {
    fakeOllama.state.installed = [FAKE_OLLAMA_MODEL, "llama3:8b"];
  }
});

test("chat requests are rate limited and return a clear 429", async () => {
  const { spawn } = await import("node:child_process");
  const script = `
process.env.NODE_ENV = "test";
process.env.CHAT_RATE_LIMIT_MAX = "2";
const express = (await import("express")).default;
const { chatRateLimiter } = await import("./src/middleware.js");
const app = express();
app.post("/api/chat", chatRateLimiter, (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("rate-limit helper did not start in time")), 15000);
      child.stdout.on("data", chunk => {
        output += chunk;
        const match = output.match(/PORT (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("exit", code => {
        clearTimeout(timer);
        reject(new Error(`rate-limit helper exited with code ${code}`));
      });
    });
    const post = () => fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST" });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const blocked = await post();
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.match(body.message, /Too many chat requests/);
  } finally {
    child.kill();
  }
});

test("administrators can disable and re-enable the shared model for everyone", async () => {
  const admin = await signupUser();
  const user = await signupUser();
  process.env.ADMIN_EMAILS = admin.email;
  try {
    const forbidden = await api("/api/admin/shared-model", {
      method: "POST",
      cookie: user.cookie,
      body: { enabled: false }
    });
    assert.equal(forbidden.status, 403);

    const disabled = await api("/api/admin/shared-model", {
      method: "POST",
      cookie: admin.cookie,
      body: { enabled: false }
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.shared.status, "disabled");

    const status = await api("/api/settings/shared-model", { cookie: user.cookie });
    assert.equal(status.body.shared.status, "disabled");

    const models = await api("/api/settings/models", { cookie: user.cookie });
    assert.equal(models.status, 400);
    assert.equal(models.body.code, "shared_disabled");

    const chat = await api("/api/chat", {
      method: "POST",
      cookie: user.cookie,
      body: { stream: false, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(chat.status, 403);
    assert.equal(chat.body.code, "shared_disabled");

    const reEnabled = await api("/api/admin/shared-model", {
      method: "POST",
      cookie: admin.cookie,
      body: { enabled: true }
    });
    assert.equal(reEnabled.status, 200);
    assert.equal(reEnabled.body.shared.status, "available");
    const worksAgain = await api("/api/chat", {
      method: "POST",
      cookie: user.cookie,
      body: { stream: false, messages: [{ role: "user", content: "welcome back" }] }
    });
    assert.equal(worksAgain.status, 200);
  } finally {
    delete process.env.ADMIN_EMAILS;
    await setSharedModelEnabled(true);
  }
});

// ─── OpenRouter shared model ────────────────────────────────────────────────

async function withOpenRouterEnv(overrides, fn) {
  const previous = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL
  };
  const apply = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  apply("OPENROUTER_API_KEY", overrides.apiKey);
  apply("OPENROUTER_BASE_URL", overrides.baseUrl);
  apply("OPENROUTER_MODEL", overrides.model);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fakeProvider.state.reset();
  }
}

test("OpenRouter becomes the shared model when OPENROUTER_API_KEY is configured", async () => {
  await withOpenRouterEnv({ apiKey: FAKE_API_KEY, baseUrl: fakeProvider.baseUrl, model: "fake-model-pro" }, async () => {
    const { cookie } = await signupUser();

    const status = await api("/api/settings/shared-model", { cookie });
    assert.equal(status.status, 200);
    assert.equal(status.body.shared.provider, "openrouter");
    assert.equal(status.body.shared.model, "fake-model-pro");
    assert.equal(status.body.shared.available, true);
    assert.equal(status.body.shared.status, "available");
    assert.ok(!JSON.stringify(status.body).includes(fakeProvider.baseUrl), "shared status must not leak the provider base URL");

    const models = await api("/api/settings/models", { cookie });
    assert.equal(models.status, 200);
    const shared = models.body.models.find(model => model.shared);
    assert.equal(shared.id, "fake-model-pro");

    fakeProvider.state.reset();
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "openrouter hello" }] }
    });
    assert.equal(chat.status, 200);
    assert.match(chat.body.message.content, /Echo from fake-model-pro/);
    assert.equal(fakeProvider.state.chatRequests.length, 1);
    assert.equal(fakeProvider.state.chatRequests[0].body.model, "fake-model-pro");
    assert.equal(fakeProvider.state.chatRequests[0].body.max_tokens, 1024);
    assert.equal(fakeProvider.state.chatRequests[0].key, FAKE_API_KEY, "server-side key must be attached on the backend");
  });
});

test("OpenRouter quota exhaustion is handled safely with a clear 429", async () => {
  await withOpenRouterEnv({ apiKey: FAKE_API_KEY, baseUrl: fakeProvider.baseUrl, model: "fake-model-pro" }, async () => {
    const { cookie } = await signupUser();
    fakeProvider.state.set({ chatStatus: 429 });
    const rateLimited = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "quota?" }] }
    });
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.body.code, "shared_quota_exhausted");
    assert.match(rateLimited.body.message, /capacity/i);
    assert.ok(!/fake|rate limit reached/i.test(rateLimited.body.message), "raw provider quota text must not leak");

    fakeProvider.state.set({ chatStatus: 402 });
    const credits = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "credits?" }] }
    });
    assert.equal(credits.status, 429);
    assert.equal(credits.body.code, "shared_quota_exhausted");
  });
});

test("OpenRouter server-side key problems never leak details to users", async () => {
  await withOpenRouterEnv({ apiKey: FAKE_API_KEY, baseUrl: fakeProvider.baseUrl, model: "fake-model-pro" }, async () => {
    const { cookie } = await signupUser();
    fakeProvider.state.set({ invalidKey: true });
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "key issue" }] }
    });
    assert.equal(chat.status, 503);
    assert.equal(chat.body.code, "shared_unavailable");
    assert.ok(!/your api key|check the key/i.test(chat.body.message), "shared key failures must not tell users to check a nonexistent personal key");
  });
});

test("an unreachable OpenRouter server is reported as unreachable", async () => {
  await withOpenRouterEnv({ apiKey: FAKE_API_KEY, baseUrl: "http://127.0.0.1:9/v1", model: "fake-model-pro" }, async () => {
    const { cookie } = await signupUser();
    const status = await api("/api/settings/shared-model", { cookie });
    assert.equal(status.body.shared.provider, "openrouter");
    assert.equal(status.body.shared.status, "unreachable");
    assert.equal(status.body.shared.available, false);
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(chat.status, 503);
    assert.equal(chat.body.code, "shared_unavailable");
    assert.match(chat.body.message, /unreachable/i);
  });
});

test("a missing OpenRouter model is reported instead of pretending it is available", async () => {
  await withOpenRouterEnv({ apiKey: FAKE_API_KEY, baseUrl: fakeProvider.baseUrl, model: "fake-model-does-not-exist" }, async () => {
    const { cookie } = await signupUser();
    const status = await api("/api/settings/shared-model", { cookie });
    assert.equal(status.body.shared.status, "missing_model");
    assert.equal(status.body.shared.available, false);
    const models = await api("/api/settings/models", { cookie });
    assert.equal(models.status, 400);
    assert.equal(models.body.code, "shared_unavailable");
    assert.equal(models.body.shared.status, "missing_model");
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(chat.status, 503);
    assert.equal(chat.body.code, "shared_unavailable");
  });
});

test("OpenRouter without an API key falls back to the Ollama shared model", async () => {
  await withOpenRouterEnv({ apiKey: undefined, baseUrl: fakeProvider.baseUrl, model: "fake-model-pro" }, async () => {
    const { cookie } = await signupUser();
    const status = await api("/api/settings/shared-model", { cookie });
    assert.equal(status.body.shared.provider, "ollama");
    assert.equal(status.body.shared.status, "available");
  });
});

// ─── Frontend connectivity / CORS origins ───────────────────────────────────

test("GET /api returns an informative index instead of a bare 404", async () => {
  const response = await api("/api");
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.health, "/api/health");
  assert.ok(Array.isArray(response.body.routes) && response.body.routes.includes("/api/chat"));
});

test("CORS allows Vite preview origins and pattern-configured Vercel aliases", async () => {
  const preview = await api("/api/auth/me", { headers: { Origin: "http://localhost:4173" } });
  assert.equal(preview.headers.get("access-control-allow-origin"), "http://localhost:4173");
  assert.equal(preview.headers.get("access-control-allow-credentials"), "true");

  process.env.CLIENT_ORIGIN_PATTERNS = "https://vups-router-*-vishnu-4571.vercel.app";
  try {
    const branch = await api("/api/auth/me", { headers: { Origin: "https://vups-router-git-main-vishnu-4571.vercel.app" } });
    assert.equal(branch.status, 401);
    assert.equal(branch.headers.get("access-control-allow-origin"), "https://vups-router-git-main-vishnu-4571.vercel.app");

    const deployment = await api("/api/auth/me", { headers: { Origin: "https://vups-router-k0e1x6r4y-vishnu-4571.vercel.app" } });
    assert.equal(deployment.headers.get("access-control-allow-origin"), "https://vups-router-k0e1x6r4y-vishnu-4571.vercel.app");

    const nearMiss = await api("/", { headers: { Origin: "https://vups-router-evil.vercel.app" } });
    assert.equal(nearMiss.status, 403);
    assert.equal(nearMiss.headers.get("access-control-allow-origin"), null);

    const blockedPost = await api("/api/auth/signin", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
      body: { email: "a@example.com", password: "correct-horse-battery" }
    });
    assert.equal(blockedPost.status, 403);
  } finally {
    delete process.env.CLIENT_ORIGIN_PATTERNS;
  }
});
