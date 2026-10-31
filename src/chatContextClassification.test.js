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
delete process.env.VUPS_BASE_URL;
delete process.env.VUPS_API_KEY;
delete process.env.VUPS_UNDERLYING_MODEL;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_context_classification_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `context${Date.now()}-${counter}@example.com`;
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

async function signupUser() {
  const email = uniqueEmail();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Context Tester", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return sessionCookie(response);
}

async function configureProvider(cookie) {
  const response = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "Fake OpenAI-compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-mini"
    }
  });
  assert.equal(response.status, 200);
}

function sseEvents(text) {
  return text
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(Boolean)
    .map(raw => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const CONTEXT_PAYLOAD = {
  error: {
    message:
      "This model's maximum context length is 131072 tokens. However, your messages resulted in 160000 tokens.",
    code: "context_length_exceeded"
  }
};

test("a 403 context-window response is serialized as a safe context limit, not Access denied", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ chatStatus: 403, chatErrorPayload: CONTEXT_PAYLOAD });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Continue the migration plan." }], stream: false }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "context_limit");
  assert.match(response.body.message, /Continue in a new chat/);
  assert.doesNotMatch(response.body.message, /denied|permission|api key|131072|maximum context/i);
  assert.equal(response.body.diagnostic.category, "context_limit");
});

test("a 401 context-window response is not mislabeled as an invalid key", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({
    chatStatus: 401,
    chatErrorPayload: {
      error: { error: { message: "input length exceeds the context length", code: "prompt_too_long" } }
    }
  });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Summarize the whole project." }], stream: false }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "context_limit");
  assert.doesNotMatch(response.body.message, /api key|denied|invalid/i);
  assert.equal(response.body.diagnostic.category, "context_limit");
});

test("a genuine 403 still keeps the access-denied classification", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({
    chatStatus: 403,
    chatErrorPayload: { error: { message: "Access denied for this model." } }
  });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Hello" }], stream: false }
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, "forbidden");
  assert.match(response.body.message, /denied access/i);
  assert.notEqual(response.body.code, "context_limit");
  assert.equal(response.body.diagnostic.category, "forbidden");
});

test("a context error delivered inside an open stream is still a context limit", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({
    chatStatus: 200,
    failStreamMidway: true,
    streamErrorPayload: CONTEXT_PAYLOAD
  });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Keep going with the dashboard." }], stream: true }
  });

  assert.equal(response.status, 200);
  const events = sseEvents(response.body.raw || "");
  const failure = events.find(event => event.type === "error");
  assert.ok(failure, "expected an SSE error event");
  assert.equal(failure.code, "context_limit");
  assert.match(failure.message, /Continue in a new chat/);
  assert.doesNotMatch(failure.message, /maximum context|denied|api key/i);
  assert.equal(failure.diagnostic.category, "context_limit");
});

test("an oversized conversation is rejected before the provider call as a context limit", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  // Three 1.4M-character user turns exceed the 4M total while each stays under
  // the 2M single-message cap, so the total-conversation guard is what rejects it.
  const large = "x".repeat(1_400_000);
  const messages = [
    { role: "user", content: large },
    { role: "assistant", content: "ok" },
    { role: "user", content: large },
    { role: "assistant", content: "ok" },
    { role: "user", content: large }
  ];

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages, stream: false }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "context_limit");
  assert.match(response.body.message, /conversation is too large/i);
  assert.equal(fakeProvider.state.chatRequests.length, 0);
});

test("ordinary server failures keep their existing provider-unavailable handling", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ chatStatus: 500, chatErrorPayload: { error: { message: "Internal failure" } } });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Hello" }], stream: false }
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.code, "provider_unavailable");
  assert.notEqual(response.body.code, "context_limit");
});
