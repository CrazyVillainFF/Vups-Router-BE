import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.SETTINGS_RATE_LIMIT_MAX = "10000";
process.env.SENDER_EMAIL = "vupriseoffical@gmail.com";
delete process.env.MONGODB_URI;
delete process.env.BREVO_API_KEY;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_provider_picker_test");

const { default: app } = await import("./index.js");
// dotenv runs inside index.js and would otherwise load the real shared-model
// credentials from the local .env — these tests use the fake Ollama server.
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_BASE_URL;
delete process.env.OPENROUTER_MODEL;
const { default: mongoose } = await import("mongoose");
const { default: ProviderConfig } = await import("./providerConfig.js");
const { encryptSecret } = await import("./encryption.js");
const { startFakeProvider, FAKE_API_KEY, FAKE_MODELS } = await import("./testUtils/fakeProvider.js");
const fakeA = await startFakeProvider();
const fakeB = await startFakeProvider();
const { startFakeOllama, FAKE_OLLAMA_MODEL } = await import("./testUtils/fakeOllama.js");
const fakeOllama = await startFakeOllama();
process.env.OLLAMA_BASE_URL = fakeOllama.baseUrl;
process.env.OLLAMA_MODEL = FAKE_OLLAMA_MODEL;

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeA.close();
  await fakeB.close();
  await fakeOllama.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `picker${Date.now()}-${counter}@example.com`;
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
    body: { name: "Picker Tester", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return { email, cookie: sessionCookie(response) };
}

async function createConfig(cookie, { provider, baseUrl, apiKey, model, providerId }) {
  return api("/api/settings/providers", {
    method: "POST",
    cookie,
    body: { provider, baseUrl, apiKey, model, providerId }
  });
}

async function saveModels(cookie, configId, models, defaultModel) {
  return api(`/api/settings/providers/${configId}/models`, {
    method: "PUT",
    cookie,
    body: { models, defaultModel }
  });
}

test("with no saved keys the catalogue contains only free/shared models", async () => {
  const { cookie } = await signupUser();
  const listing = await api("/api/settings/models", { cookie });
  assert.equal(listing.status, 200);
  const ids = listing.body.models.map(model => model.id);
  assert.ok(ids.includes(FAKE_OLLAMA_MODEL), "the free model must be listed");
  assert.ok(listing.body.models.every(model => model.shared === true), "no personal rows without saved keys");
});

test("two configurations for the same provider coexist with distinct stable configIds", async () => {
  const { cookie } = await signupUser();
  const first = await createConfig(cookie, {
    provider: "DeepSeek",
    providerId: "deepseek",
    baseUrl: fakeA.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });
  assert.equal(first.status, 201);
  const second = await createConfig(cookie, {
    provider: "DeepSeek",
    providerId: "deepseek",
    baseUrl: fakeB.baseUrl,
    apiKey: "sk-second-key-abcdef",
    model: "fake-model-mini"
  });
  assert.equal(second.status, 201);

  assert.notEqual(first.body.config.configId, second.body.config.configId);
  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.providers.length, 2);
  assert.equal(list.body.providers.filter(entry => entry.providerId === "deepseek").length, 2);
  assert.equal(list.body.activeConfigId, second.body.config.configId);
});

test("saved rows from every configuration appear in the catalogue, duplicates included", async () => {
  const { cookie } = await signupUser();
  const first = await createConfig(cookie, {
    provider: "DeepSeek",
    providerId: "deepseek",
    baseUrl: fakeA.baseUrl,
    apiKey: "sk-first-secret-111111",
    model: "fake-model-mini"
  });
  const second = await createConfig(cookie, {
    provider: "DeepSeek",
    providerId: "deepseek",
    baseUrl: fakeB.baseUrl,
    apiKey: "sk-second-secret-222222",
    model: "fake-model-mini"
  });
  await saveModels(cookie, first.body.config.configId, ["fake-model-mini", "fake-model-pro"], "fake-model-pro");
  await saveModels(cookie, second.body.config.configId, ["fake-model-mini"], "fake-model-mini");

  const listing = await api("/api/settings/models", { cookie });
  assert.equal(listing.status, 200);
  const rows = listing.body.models.filter(model => !model.shared && model.id === "fake-model-mini");
  assert.equal(rows.length, 2, "the same model in two configurations must produce two rows");
  const configIds = new Set(rows.map(row => row.configId));
  assert.equal(configIds.size, 2);
  assert.ok(rows.every(row => typeof row.apiKeyMasked === "string" && row.apiKeyMasked.length > 0));
  assert.notEqual(rows[0].apiKeyMasked, rows[1].apiKeyMasked);
  assert.ok(listing.body.models.some(model => model.shared && model.id === FAKE_OLLAMA_MODEL), "free models stay visible");

  assert.doesNotMatch(JSON.stringify(listing.body), /sk-first-secret-111111|sk-second-secret-222222/);
  const providers = await api("/api/settings/providers", { cookie });
  assert.doesNotMatch(JSON.stringify(providers.body), /sk-first-secret-111111|sk-second-secret-222222/);
});

test("chat with a configId uses exactly that configuration's credentials", async () => {
  const { cookie } = await signupUser();
  const first = await createConfig(cookie, {
    provider: "Provider A",
    providerId: "provider-a",
    baseUrl: fakeA.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });
  const second = await createConfig(cookie, {
    provider: "Provider B",
    providerId: "provider-b",
    baseUrl: fakeB.baseUrl,
    apiKey: "sk-provider-b-key-333333",
    model: "fake-model-mini"
  });
  await api(`/api/settings/providers/${first.body.config.configId}/activate`, { method: "POST", cookie });

  fakeA.state.reset();
  fakeB.state.reset();

  const chosen = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      configId: second.body.config.configId,
      model: "fake-model-mini",
      messages: [{ role: "user", content: "route me to B" }]
    }
  });
  assert.equal(chosen.status, 401, "B only accepts its own configured key");
  assert.equal(fakeB.state.chatRequests.length, 1);
  assert.equal(fakeB.state.chatRequests[0].key, "sk-provider-b-key-333333");
  assert.equal(fakeA.state.chatRequests.length, 0, "the active provider must not receive an explicit B request");

  fakeB.state.reset();
  const fallback = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, model: "fake-model-mini", messages: [{ role: "user", content: "active route" }] }
  });
  assert.equal(fallback.status, 200);
  assert.equal(fakeA.state.chatRequests.length, 1, "without configId the active provider is used");
  assert.equal(fakeB.state.chatRequests.length, 0);
});

test("provider identity cannot cross saved configurations", async () => {
  const { cookie } = await signupUser();
  const first = await createConfig(cookie, {
    provider: "Provider A",
    providerId: "provider-a",
    baseUrl: fakeA.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });
  const second = await createConfig(cookie, {
    provider: "Provider B",
    providerId: "provider-b",
    baseUrl: fakeB.baseUrl,
    apiKey: "sk-provider-b-key-333333",
    model: "fake-model-mini"
  });
  await api(`/api/settings/providers/${first.body.config.configId}/activate`, { method: "POST", cookie });
  fakeA.state.reset();
  fakeB.state.reset();

  const mismatch = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      configId: second.body.config.configId,
      providerId: "provider-a",
      model: "fake-model-mini",
      messages: [{ role: "user", content: "must not cross providers" }]
    }
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, "provider_mismatch");
  assert.equal(fakeA.state.chatRequests.length, 0);
  assert.equal(fakeB.state.chatRequests.length, 0);

  const selectedByProvider = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      providerId: "provider-b",
      model: "fake-model-mini",
      messages: [{ role: "user", content: "route by provider identity" }]
    }
  });
  assert.equal(selectedByProvider.status, 401, "provider B only accepts its own key");
  assert.equal(fakeB.state.chatRequests.length, 1);
  assert.equal(fakeB.state.chatRequests[0].key, "sk-provider-b-key-333333");
  assert.equal(fakeA.state.chatRequests.length, 0, "the active provider must not receive a provider-B request");
});

test("a deleted configuration reference fails clearly instead of switching keys", async () => {
  const { cookie } = await signupUser();
  const created = await createConfig(cookie, {
    provider: "Ephemeral",
    providerId: "ephemeral",
    baseUrl: fakeA.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });
  const configId = created.body.config.configId;
  await api(`/api/settings/providers/${configId}`, { method: "DELETE", cookie });

  fakeA.state.reset();
  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      configId,
      model: "fake-model-mini",
      messages: [{ role: "user", content: "gone" }]
    }
  });
  assert.equal(chat.status, 404);
  assert.equal(chat.body.code, "config_not_found");
  assert.equal(fakeA.state.chatRequests.length, 0);
});

test("deleting one configuration preserves the other and its models", async () => {
  const { cookie } = await signupUser();
  const keep = await createConfig(cookie, {
    provider: "DeepSeek",
    providerId: "deepseek",
    baseUrl: fakeA.baseUrl,
    apiKey: "sk-keep-key-444444",
    model: "fake-model-mini"
  });
  const drop = await createConfig(cookie, {
    provider: "DeepSeek",
    providerId: "deepseek",
    baseUrl: fakeB.baseUrl,
    apiKey: "sk-drop-key-555555",
    model: "fake-model-pro"
  });
  await saveModels(cookie, keep.body.config.configId, ["fake-model-mini", "fake-model-pro"], "fake-model-mini");
  await saveModels(cookie, drop.body.config.configId, ["fake-model-pro"], "fake-model-pro");

  const deleted = await api(`/api/settings/providers/${drop.body.config.configId}`, { method: "DELETE", cookie });
  assert.equal(deleted.status, 200);

  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.providers.length, 1);
  assert.equal(list.body.providers[0].configId, keep.body.config.configId);
  assert.deepEqual(list.body.providers[0].models, ["fake-model-mini", "fake-model-pro"]);
  assert.equal(list.body.providers[0].defaultModel, "fake-model-mini");
  assert.equal(list.body.providers[0].apiKeyMasked.includes("444444"), false, "full key never returned");
});

test("saving and editing a configuration never changes another configuration", async () => {
  const { cookie } = await signupUser();
  const stable = await createConfig(cookie, {
    provider: "Stable",
    providerId: "stable",
    baseUrl: fakeA.baseUrl,
    apiKey: "sk-stable-key-666666",
    model: "fake-model-mini"
  });
  await saveModels(cookie, stable.body.config.configId, ["fake-model-mini", "fake-model-pro"], "fake-model-pro");

  const snapshot = (await api("/api/settings/providers", { cookie })).body.providers.find(
    entry => entry.configId === stable.body.config.configId
  );

  const other = await createConfig(cookie, {
    provider: "Other",
    providerId: "other",
    baseUrl: fakeB.baseUrl,
    apiKey: "sk-other-key-777777",
    model: "fake-model-pro"
  });
  await api(`/api/settings/providers/${other.body.config.configId}`, {
    method: "PUT",
    cookie,
    body: { provider: "Other renamed", baseUrl: fakeB.baseUrl, model: "fake-model-pro" }
  });

  const after = (await api("/api/settings/providers", { cookie })).body.providers.find(
    entry => entry.configId === stable.body.config.configId
  );
  assert.equal(after.provider, snapshot.provider);
  assert.equal(after.baseUrl, snapshot.baseUrl);
  assert.equal(after.apiKeyMasked, snapshot.apiKeyMasked);
  assert.deepEqual(after.models, snapshot.models);
  assert.equal(after.defaultModel, snapshot.defaultModel);
});

test("a failed discovery keeps saved rows and the free list visible", async () => {
  const { cookie } = await signupUser();
  const created = await createConfig(cookie, {
    provider: "Outage",
    providerId: "outage",
    baseUrl: fakeA.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });
  await saveModels(cookie, created.body.config.configId, ["fake-model-mini", "fake-model-pro"], "fake-model-pro");

  fakeA.state.set({ listStatus: 500 });
  try {
    const listing = await api("/api/settings/models", { cookie });
    assert.equal(listing.status, 200);
    assert.ok(listing.body.warning, "the outage is reported as a warning");
    const ids = listing.body.models.filter(model => !model.shared).map(model => model.id);
    assert.ok(ids.includes("fake-model-mini"));
    assert.ok(ids.includes("fake-model-pro"));
    assert.ok(listing.body.models.some(model => model.shared && model.id === FAKE_OLLAMA_MODEL), "free models survive outages");

    const focused = await api(`/api/settings/models?configId=${created.body.config.configId}`, { cookie });
    assert.equal(focused.status, 200);
    assert.ok(focused.body.warning);
    assert.deepEqual(focused.body.models.map(model => model.id).sort(), ["fake-model-mini", "fake-model-pro"]);
  } finally {
    fakeA.state.reset();
  }
});

test("free shared models remain selectable when saved configurations exist", async () => {
  const { cookie } = await signupUser();
  await createConfig(cookie, {
    provider: "Personal",
    providerId: "personal",
    baseUrl: fakeA.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });

  fakeOllama.state.reset();
  fakeA.state.reset();
  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      model: FAKE_OLLAMA_MODEL,
      messages: [{ role: "user", content: "use the free model" }]
    }
  });
  assert.equal(chat.status, 200);
  assert.equal(fakeOllama.state.chatRequests.length, 1);
  assert.equal(fakeA.state.chatRequests.length, 0, "free model selection must not hit the personal provider");
  assert.match(chat.text, /Shared reply/);
});

test("legacy rows without a configId migrate without losing settings", async () => {
  const { cookie } = await signupUser();
  const me = await api("/api/auth/me", { cookie });
  const userId = new mongoose.Types.ObjectId(me.body.user.id);
  await ProviderConfig.collection.insertOne({
    userId,
    providerId: "legacy-deepseek",
    provider: "Legacy DeepSeek",
    providerType: "openai_compatible",
    baseUrl: fakeA.baseUrl,
    model: "fake-model-mini",
    models: [],
    defaultModel: "",
    enabled: true,
    active: true,
    encryptedApiKey: encryptSecret(FAKE_API_KEY),
    lastTestStatus: "",
    lastTestCode: "",
    lastTestMessage: "",
    lastTestAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.providers.length, 1);
  assert.equal(list.body.providers[0].configId, "legacy-deepseek");
  assert.equal(list.body.providers[0].provider, "Legacy DeepSeek");

  fakeA.state.reset();
  const chat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      configId: "legacy-deepseek",
      model: "fake-model-mini",
      messages: [{ role: "user", content: "legacy still works" }]
    }
  });
  assert.equal(chat.status, 200);
  assert.equal(fakeA.state.chatRequests.length, 1);
});



test("OpenCode Zen restricted models fail with actionable statuses before any upstream request", async () => {
  const { cookie } = await signupUser();
  const created = await createConfig(cookie, {
    provider: "OpenCode Zen",
    providerId: "opencode-zen",
    baseUrl: "https://opencode.ai/inference/openai/v1",
    apiKey: "oc_sk_test_restricted_123456",
    model: "deepseek-v4.1-flash-free"
  });
  assert.equal(created.status, 201);
  const configId = created.body.config.configId;

  const freeChat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      configId,
      model: "deepseek-v4.1-flash-free",
      messages: [{ role: "user", content: "hi" }]
    }
  });
  assert.equal(freeChat.status, 403);
  assert.equal(freeChat.body.code, "free_tier_client_only");
  assert.match(freeChat.body.message, /official OpenCode client/);

  const unsupportedChat = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      stream: false,
      configId,
      model: "gemini-3.1-pro",
      messages: [{ role: "user", content: "hi" }]
    }
  });
  assert.equal(unsupportedChat.status, 400);
  assert.equal(unsupportedChat.body.code, "unsupported_protocol");
  assert.match(unsupportedChat.body.message, /native API/);
});
