import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.SETTINGS_RATE_LIMIT_MAX = "10000";
process.env.VUPS_RETRY_BASE_MS = "1";
process.env.VUPS_RETRY_MAX_MS = "2";
delete process.env.MONGODB_URI;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_openrouter_stream_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
// dotenv runs inside index.js and would otherwise load the real shared-model
// credentials from the local .env into these tests.
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_BASE_URL;
delete process.env.OPENROUTER_MODEL;
delete process.env.OLLAMA_BASE_URL;
delete process.env.VUPS_BASE_URL;
delete process.env.VUPS_API_KEY;
delete process.env.VUPS_UNDERLYING_MODEL;
const { resetOpenRouterCache } = await import("./openrouter.js");
const { default: mongoose } = await import("mongoose");

const sharedFake = await startFakeProvider();
const SHARED_KEY = "sk-shared-openrouter-key-777777";

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await sharedFake.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `orstream${Date.now()}-${counter}@example.com`;
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
  const session = response.headers.getSetCookie().find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function signupUser(label = "stream") {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: `OpenRouter ${label}`, email: uniqueEmail(), password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return sessionCookie(response);
}

async function configureProvider(cookie, model = "fake-model-mini") {
  const response = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "OpenRouter",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model
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

function answerText(events) {
  return events.filter(event => event.type === "delta").map(event => event.content).join("");
}

const UPSTREAM_429 = {
  error: {
    message: "recursive/flint-v1.0:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits.",
    code: "429"
  }
};

test("a streamed answer forwards the provider's final usage metadata", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ usageChunk: true });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: true,
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Hello" }
      ]
    }
  });

  assert.equal(response.status, 200);
  const events = sseEvents(response.body.raw || "");
  const done = events.find(event => event.type === "done");
  assert.ok(done, "expected a done event");
  assert.equal(done.finishReason, "stop");
  assert.equal(done.usage.total_tokens, 14);
  assert.equal(done.usage.completion_tokens, 9);
  assert.equal(answerText(events), "Hello from fake-model-mini!");
  const upstream = fakeProvider.state.chatRequests[0].body;
  assert.equal(upstream.messages[0].role, "system", "the chat-mode system prompt reaches the provider");
  assert.equal(upstream.messages.length, 4, "the whole conversation history reaches the provider");
  assert.equal(upstream.messages[1].content, "First question");
  assert.equal(upstream.messages.at(-1).content, "Hello");
});

test("reasoning text becomes its own step and never enters the answer", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ streamReasoning: true, usageChunk: true });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: true, messages: [{ role: "user", content: "Hello" }] }
  });

  assert.equal(response.status, 200);
  const events = sseEvents(response.body.raw || "");
  assert.equal(answerText(events), "Hello from fake-model-mini!", "reasoning must not be appended to the answer");
  const thinking = events.find(event => event.type === "progress" && event.phase === "reasoning");
  assert.ok(thinking, "the reasoning phase must reach the client as a progress step");
  assert.equal(
    events.filter(event => event.type === "progress" && event.phase === "reasoning").length,
    1,
    "the reasoning step is announced once, not per chunk"
  );
  assert.equal(events.some(event => event.type === "error"), false);
  assert.ok(events.find(event => event.type === "done"));
});

test("a model that reasons past its output budget reports the output limit", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ reasoningOnly: true, finishReason: "length" });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: true, messages: [{ role: "user", content: "Hello" }] }
  });

  assert.equal(response.status, 200);
  const events = sseEvents(response.body.raw || "");
  const failure = events.find(event => event.type === "error");
  assert.ok(failure, "a reasoning-only stream must not report success");
  assert.equal(failure.code, "output_limit");
  assert.match(failure.message, /reasoning/i);
  assert.equal(answerText(events), "");
  assert.equal(events.some(event => event.type === "done"), false);
});

test("a transient upstream rate limit is retried and the answer still streams", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ chatStatus: 429, chatFailuresRemaining: 1, usageChunk: true });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: true, messages: [{ role: "user", content: "Hello" }] }
  });

  assert.equal(response.status, 200);
  const events = sseEvents(response.body.raw || "");
  assert.equal(events.some(event => event.type === "done"), true);
  assert.equal(fakeProvider.state.chatRequests.length, 2, "the first 429 must be retried once");
});

test("a persistent rate limit surfaces honestly without swapping the model", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie, "fake-model-pro");
  fakeProvider.state.set({ chatStatus: 429, chatErrorPayload: UPSTREAM_429 });

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: true, model: "fake-model-pro", messages: [{ role: "user", content: "Hello" }] }
  });

  assert.equal(response.body.code, "rate_limited");
  assert.match(response.body.message, /rate limit|retry/i);
  assert.equal(fakeProvider.state.chatRequests.length, 3, "two bounded retries, then the honest error");
  assert.deepEqual(
    [...new Set(fakeProvider.state.chatRequests.map(request => request.body.model))],
    ["fake-model-pro"],
    "the selected model must never be replaced silently"
  );
});

test("an account without its own credential never borrows another account's key", async () => {
  fakeProvider.state.reset();
  const owner = await signupUser("owner");
  await configureProvider(owner);
  const stranger = await signupUser("stranger");
  const callsBefore = fakeProvider.state.chatRequests.length;

  const response = await api("/api/chat", {
    method: "POST",
    cookie: stranger,
    body: { stream: true, messages: [{ role: "user", content: "Hello" }] }
  });

  assert.ok([400, 404, 503].includes(response.status), `expected a clean refusal, got ${response.status}`);
  assert.equal(typeof response.body.code, "string");
  assert.ok(response.body.code.length > 0, "the refusal must carry a machine-readable code");
  assert.doesNotMatch(JSON.stringify(response.body), /api key|sk-/i, "the refusal must not leak credential details");
  assert.equal(fakeProvider.state.chatRequests.length, callsBefore, "no provider call may reuse another account's key");
  assert.equal(fakeProvider.state.chatRequests.every(request => request.key === FAKE_API_KEY), true);
});

test("cancelling the client mid-stream ends the turn without a provider error", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.set({ chatResponseText: "alpha beta gamma delta epsilon zeta", streamChunkDelayMs: 60 });

  const controller = new AbortController();
  const response = await fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Hello" }] }),
    signal: controller.signal
  });
  assert.equal(response.status, 200);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (!raw.includes('"type":"delta"')) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  assert.match(raw, /"type":"delta"/, "expected at least one answer chunk before cancelling");
  controller.abort();

  let settled = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      settled += decoder.decode(value, { stream: true });
    }
  } catch {
    /* the aborted request closes the reader */
  }
  const events = sseEvents(settled);
  assert.equal(events.some(event => event.type === "error"), false, "a user cancellation is not a provider failure");
  assert.equal(events.some(event => event.type === "done"), false, "a cancelled turn does not claim completion");
});

test("a saved OpenRouter key is never swapped for the server's global key", async () => {
  fakeProvider.state.reset();
  sharedFake.state.reset();
  sharedFake.state.set({ acceptedKeys: [SHARED_KEY] });
  const cookie = await signupUser("global-key");
  const saved = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: { provider: "OpenRouter", baseUrl: fakeProvider.baseUrl, apiKey: FAKE_API_KEY, model: "fake-model-mini" }
  });
  assert.equal(saved.status, 200);
  const configId = saved.body.config.configId;

  const previous = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL
  };
  process.env.OPENROUTER_API_KEY = SHARED_KEY;
  process.env.OPENROUTER_BASE_URL = sharedFake.baseUrl;
  process.env.OPENROUTER_MODEL = "fake-model-mini";
  resetOpenRouterCache();
  try {
    // The same model id is now offered by the user's own provider and by the
    // shared free catalogue, so the selection reference decides whose key pays.
    const own = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, configId, model: "fake-model-mini", messages: [{ role: "user", content: "mine" }] }
    });
    assert.equal(own.status, 200);
    assert.equal(fakeProvider.state.chatRequests.length, 1);
    assert.equal(fakeProvider.state.chatRequests[0].key, FAKE_API_KEY);
    assert.equal(sharedFake.state.chatRequests.length, 0, "an explicit saved configuration must not spend the global key");

    const shared = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, model: "fake-model-mini", messages: [{ role: "user", content: "shared tier" }] }
    });
    assert.equal(shared.status, 200);
    assert.equal(sharedFake.state.chatRequests.length, 1);
    assert.equal(sharedFake.state.chatRequests[0].key, SHARED_KEY);
    assert.equal(fakeProvider.state.chatRequests.length, 1, "a shared-tier selection must not spend the user's key");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetOpenRouterCache();
    fakeProvider.state.reset();
    sharedFake.state.reset();
  }
});
