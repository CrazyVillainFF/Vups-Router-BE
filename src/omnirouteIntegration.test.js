import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.PROVIDER_TIMEOUT_MS = "1000";
delete process.env.MONGODB_URI;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_BASE_URL;
delete process.env.OPENROUTER_MODEL;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_omniroute_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();
const { startFakeOllama, FAKE_OLLAMA_MODEL } = await import("./testUtils/fakeOllama.js");
const fakeOllama = await startFakeOllama();
const { startFakeOmniRoute, FAKE_OMNIROUTE_KEY, FAKE_OMNIROUTE_MODELS } = await import("./testUtils/fakeOmniRoute.js");
const fakeOmniRoute = await startFakeOmniRoute();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { resetOmniRouteCache } = await import("./omniroute.js");

delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_BASE_URL;
delete process.env.OPENROUTER_MODEL;
delete process.env.OPENROUTER_MODELS;
process.env.OLLAMA_BASE_URL = fakeOllama.baseUrl;
process.env.OLLAMA_MODEL = FAKE_OLLAMA_MODEL;
process.env.OMNIROUTE_BASE_URL = fakeOmniRoute.baseUrl;
process.env.OMNIROUTE_API_KEY = FAKE_OMNIROUTE_KEY;
process.env.OMNIROUTE_ENABLED = "true";

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

afterEach(() => {
  process.env.OMNIROUTE_BASE_URL = fakeOmniRoute.baseUrl;
  process.env.OMNIROUTE_API_KEY = FAKE_OMNIROUTE_KEY;
  process.env.OMNIROUTE_ENABLED = "true";
  fakeOmniRoute.reset();
  resetOmniRouteCache();
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await fakeOllama.close();
  await fakeOmniRoute.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let emailCounter = 0;
function uniqueEmail() {
  emailCounter += 1;
  return `omniroute-user${Date.now()}-${emailCounter}@example.com`;
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
    body: { name: "Gateway User", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return { email, cookie: sessionCookie(response) };
}

function parseSse(text) {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("data:"))
    .map(line => {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

test("OmniRoute models are listed with safe metadata and duplicate free IDs are not repeated", async () => {
  const { cookie } = await signupUser();
  fakeOmniRoute.reset();
  resetOmniRouteCache();

  const status = await api("/api/settings/omniroute/status", { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.omniroute.provider, "OmniRoute");
  assert.equal(status.body.omniroute.available, true);
  assert.equal(status.body.omniroute.modelCount, FAKE_OMNIROUTE_MODELS.length);
  assert.ok(!status.text.includes(FAKE_OMNIROUTE_KEY), "the status endpoint must never return the API key");
  assert.ok(!status.text.includes(fakeOmniRoute.baseUrl), "the status endpoint must never return the upstream base URL");

  const models = await api("/api/settings/models", { cookie });
  assert.equal(models.status, 200);
  const gatewayIds = models.body.models.filter(model => model.gateway).map(model => model.id);
  assert.deepEqual(gatewayIds, FAKE_OMNIROUTE_MODELS);
  assert.deepEqual(
    models.body.models.filter(model => model.shared).map(model => model.id),
    [FAKE_OLLAMA_MODEL]
  );
  const gatewayRow = models.body.models.find(model => model.gateway);
  assert.equal(gatewayRow.provider, "OmniRoute");
  assert.equal(gatewayRow.source, "omniroute");
  assert.equal(gatewayRow.saved, false);
  assert.ok(!gatewayRow.apiKeyMasked, "gateway rows must not carry a masked key");
  assert.ok(!models.text.includes(FAKE_OMNIROUTE_KEY));
  assert.equal(models.body.omniroute.available, true);

  fakeOmniRoute.state.models = [FAKE_OLLAMA_MODEL, "openai/gpt-5.2"];
  resetOmniRouteCache();
  const deduped = await api("/api/settings/models", { cookie });
  assert.deepEqual(
    deduped.body.models.filter(model => model.gateway).map(model => model.id),
    ["openai/gpt-5.2"],
    "a model already offered for free must not be repeated as a gateway row"
  );
  fakeOmniRoute.reset();
  resetOmniRouteCache();
});

test("existing personal providers keep working while OmniRoute is enabled", async () => {
  const { cookie } = await signupUser();
  const saved = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: { provider: "Fake OpenAI-compatible", baseUrl: fakeProvider.baseUrl, apiKey: FAKE_API_KEY, model: "fake-model-mini" }
  });
  assert.equal(saved.status, 200);

  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "personal please" }], model: "fake-model-mini", stream: false }
  });
  assert.equal(chat.status, 200);
  assert.match(chat.body.message.content, /Echo from fake-model-mini/);
  assert.equal(fakeProvider.state.chatRequests.length, 1);
  assert.equal(fakeOmniRoute.state.chatRequests.length, 0, "a saved provider must not be routed through OmniRoute");
});

test("non-streaming gateway chat uses the exact model and the server-side key", async () => {
  const { cookie } = await signupUser();
  fakeOmniRoute.reset();
  resetOmniRouteCache();

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      messages: [{ role: "user", content: "hello gateway" }],
      model: "openai/gpt-5.2",
      source: "omniroute",
      stream: false
    }
  });
  assert.equal(response.status, 200);
  assert.match(response.body.message.content, /OmniRoute echo from openai\/gpt-5\.2/);
  assert.ok(response.body.conversationId);

  const request = fakeOmniRoute.state.chatRequests.at(-1);
  assert.equal(request.url, "/v1/chat/completions");
  assert.equal(request.key, FAKE_OMNIROUTE_KEY);
  assert.equal(request.body.model, "openai/gpt-5.2");
  assert.equal(request.body.stream, false);
  assert.equal(request.body.messages[0].role, "system");
  assert.ok(!response.text.includes(FAKE_OMNIROUTE_KEY), "the key must never reach the client");
});

test("streaming gateway chat forwards deltas in order and finishes cleanly", async () => {
  const { cookie } = await signupUser();
  fakeOmniRoute.reset();
  resetOmniRouteCache();

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      messages: [{ role: "user", content: "stream please" }],
      model: "anthropic/claude-sonnet-4-6",
      source: "omniroute",
      stream: true
    }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = parseSse(response.text);
  const deltas = events.filter(event => event.type === "delta").map(event => event.content);
  assert.deepEqual(deltas, ["Omni", "Route ", "anthropic/claude-sonnet-4-6", " stream"]);
  assert.equal(deltas.join(""), "OmniRoute anthropic/claude-sonnet-4-6 stream");
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).finishReason, "stop");
  assert.ok(!response.text.includes(FAKE_OMNIROUTE_KEY));
});

test("gateway model and source input is validated before any upstream call", async () => {
  const { cookie } = await signupUser();
  fakeOmniRoute.reset();
  resetOmniRouteCache();
  const chatCount = fakeOmniRoute.state.chatRequests.length;

  const invalidModel = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "hi" }], model: "not/a-model", source: "omniroute", stream: false }
  });
  assert.equal(invalidModel.status, 400);
  assert.equal(invalidModel.body.code, "invalid_model");

  const invalidSource = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "hi" }], model: "openai/gpt-5.2", source: "https://evil.example.com", stream: false }
  });
  assert.equal(invalidSource.status, 400);
  assert.equal(invalidSource.body.code, "invalid_source");

  const mixed = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "hi" }], model: "openai/gpt-5.2", source: "omniroute", configId: "cfg-a", stream: false }
  });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.code, "invalid_source");

  assert.equal(fakeOmniRoute.state.chatRequests.length, chatCount, "invalid input must never reach OmniRoute");
});

test("upstream gateway HTTP failures map to distinct, sanitized errors", async () => {
  const { cookie } = await signupUser();
  fakeOmniRoute.reset();
  resetOmniRouteCache();

  const cases = [
    { status: 401, expectedStatus: 503, code: "omniroute_auth_failed" },
    { status: 403, expectedStatus: 503, code: "omniroute_auth_failed" },
    { status: 404, expectedStatus: 400, code: "omniroute_model_unavailable" },
    { status: 405, expectedStatus: 502, code: "omniroute_upstream_error" },
    { status: 429, expectedStatus: 429, code: "omniroute_rate_limited" },
    { status: 500, expectedStatus: 502, code: "omniroute_upstream_error" }
  ];
  for (const item of cases) {
    fakeOmniRoute.state.behavior.chatStatus = item.status;
    const response = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { messages: [{ role: "user", content: "fail" }], model: "openai/gpt-5.2", source: "omniroute", stream: false }
    });
    assert.equal(response.status, item.expectedStatus, `HTTP ${item.status} mapping`);
    assert.equal(response.body.code, item.code);
    assert.ok(!response.text.includes(FAKE_OMNIROUTE_KEY));
    assert.ok(!response.text.includes(fakeOmniRoute.baseUrl));
  }
  fakeOmniRoute.reset();
});

test("gateway discovery failures leave existing models visible and block only the gateway", async () => {
  const { cookie } = await signupUser();
  fakeOmniRoute.reset();
  fakeOmniRoute.state.behavior.invalidKey = true;
  resetOmniRouteCache();

  const status = await api("/api/settings/omniroute/status", { cookie });
  assert.equal(status.body.omniroute.available, false);
  assert.equal(status.body.omniroute.status, "unauthorized");

  const models = await api("/api/settings/models", { cookie });
  assert.equal(models.status, 200);
  assert.equal(models.body.models.filter(model => model.gateway).length, 0);
  assert.deepEqual(models.body.models.filter(model => model.shared).map(model => model.id), [FAKE_OLLAMA_MODEL]);

  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "hi" }], model: "openai/gpt-5.2", source: "omniroute", stream: false }
  });
  assert.equal(chat.status, 503);
  assert.equal(chat.body.code, "omniroute_auth_failed");
  assert.ok(!chat.text.includes(FAKE_OMNIROUTE_KEY));

  fakeOmniRoute.reset();
  resetOmniRouteCache();
});

test("disabling OmniRoute removes only gateway models and keeps other providers working", async () => {
  const { cookie } = await signupUser();
  const saved = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: { provider: "Fake OpenAI-compatible", baseUrl: fakeProvider.baseUrl, apiKey: FAKE_API_KEY, model: "fake-model-mini" }
  });
  assert.equal(saved.status, 200);

  process.env.OMNIROUTE_ENABLED = "false";
  resetOmniRouteCache();

  const status = await api("/api/settings/omniroute/status", { cookie });
  assert.equal(status.body.omniroute.enabled, false);
  assert.equal(status.body.omniroute.status, "disabled");

  const models = await api("/api/settings/models", { cookie });
  assert.equal(models.status, 200);
  assert.equal(models.body.models.filter(model => model.gateway).length, 0);
  assert.ok(models.body.models.some(model => model.shared), "free models stay visible");
  assert.ok(models.body.models.some(model => model.id === "fake-model-mini"), "saved models stay visible");

  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "hi" }], model: "openai/gpt-5.2", source: "omniroute", stream: false }
  });
  assert.equal(chat.status, 503);
  assert.equal(chat.body.code, "omniroute_disabled");

  const personal = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "still here" }], model: "fake-model-mini", stream: false }
  });
  assert.equal(personal.status, 200);

  process.env.OMNIROUTE_ENABLED = "true";
  resetOmniRouteCache();
});

test("an unreachable gateway is reported without breaking the rest of the app", async () => {
  const { cookie } = await signupUser();
  const previous = process.env.OMNIROUTE_BASE_URL;
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1";
  resetOmniRouteCache();

  const status = await api("/api/settings/omniroute/status", { cookie });
  assert.equal(status.body.omniroute.status, "unreachable");
  const models = await api("/api/settings/models", { cookie });
  assert.equal(models.status, 200);
  assert.ok(models.body.models.some(model => model.shared));
  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "hi" }], model: "openai/gpt-5.2", source: "omniroute", stream: false }
  });
  assert.equal(chat.status, 503);
  assert.equal(chat.body.code, "omniroute_unreachable");

  process.env.OMNIROUTE_BASE_URL = previous;
  resetOmniRouteCache();
});

test("a slow gateway surfaces a timeout without hanging the request", async () => {
  const { cookie } = await signupUser();
  fakeOmniRoute.reset();
  fakeOmniRoute.state.behavior.delayMs = 1500;
  resetOmniRouteCache();

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "slow" }], model: "openai/gpt-5.2", source: "omniroute", stream: false }
  });
  assert.equal(response.status, 504);
  assert.equal(response.body.code, "omniroute_timeout");
  assert.ok(!response.text.includes(FAKE_OMNIROUTE_KEY));

  fakeOmniRoute.reset();
  resetOmniRouteCache();
});
