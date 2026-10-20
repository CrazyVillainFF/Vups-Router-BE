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
delete process.env.OPENROUTER_API_KEY;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_provider_persistence_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: ProviderConfig } = await import("./providerConfig.js");
const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");

const fakeDeepSeek = await startFakeProvider();
const fakeFlagship = await startFakeProvider();

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeDeepSeek.close();
  await fakeFlagship.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `providers${Date.now()}-${counter}@example.com`;
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
    body: { name: "Provider Tester", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return { email, cookie: sessionCookie(response) };
}

async function saveProvider(cookie, providerId, overrides = {}) {
  return api(`/api/settings/providers/${providerId}`, {
    method: "PUT",
    cookie,
    body: {
      provider: providerId,
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-key-123456",
      model: "test-model",
      ...overrides
    }
  });
}

function publicEntry(list, providerId) {
  return list.find(entry => entry.providerId === providerId);
}

test("saving FlagshipRouter does not modify DeepSeek and both persist independently", async () => {
  const { cookie } = await signupUser();
  const deepseek = await saveProvider(cookie, "deepseek", {
    provider: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-deepseek-abcdef",
    model: "deepseek-chat"
  });
  assert.equal(deepseek.status, 200);
  const deepseekBefore = deepseek.body.config;

  const flagship = await saveProvider(cookie, "flagshiprouter", {
    provider: "FlagshipRouter",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "sk-flagship-abcdef",
    model: "flagship-chat"
  });
  assert.equal(flagship.status, 200);
  assert.equal(flagship.body.config.provider, "FlagshipRouter");

  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.providers.length, 2);
  const deepseekAfter = publicEntry(list.body.providers, "deepseek");
  assert.equal(deepseekAfter.provider, "DeepSeek");
  assert.equal(deepseekAfter.baseUrl, "https://api.deepseek.com");
  assert.equal(deepseekAfter.model, "deepseek-chat");
  assert.equal(deepseekAfter.apiKeyMasked, deepseekBefore.apiKeyMasked);
  assert.equal(deepseekAfter.providerType, deepseekBefore.providerType);
  assert.deepEqual(deepseekAfter.models, deepseekBefore.models);
  assert.equal(deepseekAfter.defaultModel, deepseekBefore.defaultModel);
  assert.equal(deepseekAfter.active, false, "the newly saved provider becomes active; DeepSeek keeps everything else");

  const stored = await ProviderConfig.find({}).select("+encryptedApiKey");
  assert.equal(stored.length, 2);
  const keys = stored.map(entry => entry.encryptedApiKey).join("|");
  assert.doesNotMatch(keys, /sk-deepseek-abcdef/);
  assert.doesNotMatch(keys, /sk-flagship-abcdef/);
  assert.doesNotMatch(JSON.stringify(list.body), /sk-deepseek-abcdef|sk-flagship-abcdef/);
});

test("saving DeepSeek after FlagshipRouter leaves FlagshipRouter untouched, and edits stay scoped", async () => {
  const { cookie } = await signupUser();
  await saveProvider(cookie, "flagshiprouter", { provider: "FlagshipRouter", apiKey: "sk-flagship-abcdef" });
  await saveProvider(cookie, "deepseek", { provider: "DeepSeek" });
  const before = publicEntry((await api("/api/settings/providers", { cookie })).body.providers, "flagshiprouter");

  await saveProvider(cookie, "deepseek", { provider: "DeepSeek", model: "deepseek-reasoner" });

  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.providers.length, 2);
  const after = publicEntry(list.body.providers, "flagshiprouter");
  assert.deepEqual(after, before, "editing DeepSeek must not change FlagshipRouter in any way");
});

test("the active provider switches explicitly and is restored on reload", async () => {
  const { cookie } = await signupUser();
  await saveProvider(cookie, "deepseek", { provider: "DeepSeek" });
  await saveProvider(cookie, "flagshiprouter", { provider: "FlagshipRouter" });

  let list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.activeProviderId, "flagshiprouter", "a newly saved provider becomes active");

  const activated = await api("/api/settings/providers/deepseek/activate", { method: "POST", cookie });
  assert.equal(activated.status, 200);

  list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.activeProviderId, "deepseek");
  assert.equal(publicEntry(list.body.providers, "deepseek").active, true);
  assert.equal(publicEntry(list.body.providers, "flagshiprouter").active, false);

  const legacy = await api("/api/settings/provider", { cookie });
  assert.equal(legacy.body.config.providerId, "deepseek");
});

test("deleting one provider keeps the other and promotes a fallback", async () => {
  const { cookie } = await signupUser();
  await saveProvider(cookie, "deepseek", { provider: "DeepSeek" });
  await saveProvider(cookie, "flagshiprouter", { provider: "FlagshipRouter" });

  const deleted = await api("/api/settings/providers/flagshiprouter", { method: "DELETE", cookie });
  assert.equal(deleted.status, 200);
  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.providers.length, 1);
  assert.equal(list.body.activeProviderId, "deepseek");
});

test("provider settings are owner-scoped and never leak keys", async () => {
  const owner = await signupUser();
  const stranger = await signupUser();
  await saveProvider(owner.cookie, "deepseek", { provider: "DeepSeek", apiKey: "sk-owner-secret-999999" });

  const strangerList = await api("/api/settings/providers", { cookie: stranger.cookie });
  assert.equal(strangerList.body.providers.length, 0);
  const strangerDelete = await api("/api/settings/providers/deepseek", { method: "DELETE", cookie: stranger.cookie });
  assert.equal(strangerDelete.status, 404);
  const ownerList = await api("/api/settings/providers", { cookie: owner.cookie });
  assert.equal(ownerList.body.providers.length, 1);
  assert.doesNotMatch(JSON.stringify(ownerList.body), /sk-owner-secret-999999/);
});

test("a failed model-discovery request never erases saved models or defaults", async () => {
  const { cookie } = await signupUser();
  await saveProvider(cookie, "flagshiprouter", {
    provider: "FlagshipRouter",
    baseUrl: fakeFlagship.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });
  const savedModels = await api("/api/settings/providers/flagshiprouter/models", {
    method: "PUT",
    cookie,
    body: { models: ["fake-model-mini", "fake-model-pro"], defaultModel: "fake-model-pro" }
  });
  assert.equal(savedModels.status, 200);
  assert.deepEqual(savedModels.body.config.models, ["fake-model-mini", "fake-model-pro"]);
  assert.equal(savedModels.body.config.defaultModel, "fake-model-pro");

  fakeFlagship.state.set({ listStatus: 500 });
  try {
    const listing = await api("/api/settings/models", { cookie });
    assert.equal(listing.status, 200, "saved models must survive a discovery outage");
    assert.ok(listing.body.warning, "the outage must be reported as a warning");
    const ids = listing.body.models.map(model => model.id);
    assert.ok(ids.includes("fake-model-mini"));
    assert.ok(ids.includes("fake-model-pro"));

    const list = await api("/api/settings/providers", { cookie });
    const entry = publicEntry(list.body.providers, "flagshiprouter");
    assert.deepEqual(entry.models, ["fake-model-mini", "fake-model-pro"]);
    assert.equal(entry.defaultModel, "fake-model-pro");
  } finally {
    fakeFlagship.state.reset();
  }
});

test("base URLs are normalized without duplicating endpoint paths", async () => {
  const { cookie } = await signupUser();
  const saved = await saveProvider(cookie, "flagged", {
    provider: "Flagged URL",
    baseUrl: "https://api.example.com/v1/chat/completions/"
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.baseUrl, "https://api.example.com/v1");

  const savedTwo = await saveProvider(cookie, "flagged-two", {
    provider: "Flagged URL Two",
    baseUrl: "https://api.example.com/v1/models"
  });
  assert.equal(savedTwo.body.config.baseUrl, "https://api.example.com/v1");
});

test("local endpoints get an actionable reachability error in production instead of 'invalid key'", async () => {
  const { cookie } = await signupUser();
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const local = await saveProvider(cookie, "flagshiprouter", {
      provider: "FlagshipRouter",
      baseUrl: "http://localhost:20128/v1",
      apiKey: "sk-flagship-local"
    });
    assert.equal(local.status, 400);
    assert.equal(local.body.code, "local_endpoint");
    assert.match(local.body.message, /localhost/i);
    assert.match(local.body.message, /ALLOW_PRIVATE_PROVIDER_URLS/);
    assert.doesNotMatch(local.body.message, /invalid api key/i);

    const privateUrl = await saveProvider(cookie, "lan-gateway", {
      provider: "LAN Gateway",
      baseUrl: "http://192.168.1.50:8080/v1",
      apiKey: "sk-lan-key"
    });
    assert.equal(privateUrl.status, 400);
    assert.equal(privateUrl.body.code, "private_endpoint");

    const metadata = await saveProvider(cookie, "metadata", {
      provider: "Metadata",
      baseUrl: "http://169.254.169.254/latest/meta-data",
      apiKey: "sk-meta-key"
    });
    assert.equal(metadata.status, 400);
    assert.equal(metadata.body.code, "private_endpoint");
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("chat uses exactly the active provider and switching cannot cross keys", async () => {
  const { cookie } = await signupUser();
  await saveProvider(cookie, "provider-a", {
    provider: "Provider A",
    baseUrl: fakeDeepSeek.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });
  await saveProvider(cookie, "provider-b", {
    provider: "Provider B",
    baseUrl: fakeFlagship.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "fake-model-mini"
  });

  fakeDeepSeek.state.reset();
  fakeFlagship.state.reset();
  const first = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "which provider?" }] }
  });
  assert.equal(first.status, 200);
  assert.equal(fakeFlagship.state.chatRequests.length, 1);
  assert.equal(fakeDeepSeek.state.chatRequests.length, 0, "the inactive provider must never receive traffic");

  await api("/api/settings/providers/provider-a/activate", { method: "POST", cookie });
  fakeDeepSeek.state.reset();
  fakeFlagship.state.reset();
  const second = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { stream: false, messages: [{ role: "user", content: "and now?" }] }
  });
  assert.equal(second.status, 200);
  assert.equal(fakeDeepSeek.state.chatRequests.length, 1);
  assert.equal(fakeFlagship.state.chatRequests.length, 0, "switch must route to the newly active provider");
  assert.equal(fakeDeepSeek.state.chatRequests[0].key, FAKE_API_KEY);
});

test("personal OmniRoute uses only the user's key, never the server gateway key", async () => {
  const previousUrl = process.env.OMNIROUTE_BASE_URL;
  const previousKey = process.env.OMNIROUTE_API_KEY;
  const previousEnabled = process.env.OMNIROUTE_ENABLED;
  try {
    process.env.OMNIROUTE_BASE_URL = fakeFlagship.baseUrl.replace(/\/v1$/, "");
    process.env.OMNIROUTE_API_KEY = "sk-server-shared-gateway-key";
    process.env.OMNIROUTE_ENABLED = "true";

    const { cookie } = await signupUser();
    const saved = await saveProvider(cookie, "omniroute", {
      provider: "OmniRoute",
      baseUrl: fakeDeepSeek.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-mini"
    });
    assert.equal(saved.status, 200);

    fakeDeepSeek.state.reset();
    fakeFlagship.state.reset();
    const check = await api("/api/settings/providers/omniroute/test", { method: "POST", cookie, body: {} });
    assert.equal(check.status, 200);
    assert.equal(fakeDeepSeek.state.modelsRequests, 1, "Check must list models");
    assert.equal(fakeDeepSeek.state.chatRequests.length, 0, "Check must stay zero-inference");
    assert.equal(fakeFlagship.state.modelsRequests, 0, "the shared gateway must not be contacted");

    const modelTest = await api("/api/settings/providers/omniroute/test-model", {
      method: "POST",
      cookie,
      body: { model: "fake-model-mini" }
    });
    assert.equal(modelTest.status, 200);
    assert.equal(fakeDeepSeek.state.chatRequests.length, 1, "Test model is the explicit inference action");
    assert.equal(fakeDeepSeek.state.chatRequests[0].key, FAKE_API_KEY);
    assert.equal(fakeFlagship.state.chatRequests.length, 0);

    fakeDeepSeek.state.reset();
    fakeFlagship.state.reset();
    const chat = await api("/api/chat", {
      method: "POST",
      cookie,
      body: { stream: false, messages: [{ role: "user", content: "personal omniroute" }] }
    });
    assert.equal(chat.status, 200);
    assert.equal(fakeDeepSeek.state.chatRequests.length, 1);
    assert.equal(fakeDeepSeek.state.chatRequests[0].key, FAKE_API_KEY);
    assert.equal(fakeFlagship.state.chatRequests.length, 0, "chat must not fall back to the shared gateway");
  } finally {
    if (previousUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
    else process.env.OMNIROUTE_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousKey;
    if (previousEnabled === undefined) delete process.env.OMNIROUTE_ENABLED;
    else process.env.OMNIROUTE_ENABLED = previousEnabled;
  }
});

test("legacy single-provider clients migrate without losing their configuration", async () => {
  const { cookie } = await signupUser();
  const legacySave = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-legacy-key-123456",
      model: "deepseek-chat"
    }
  });
  assert.equal(legacySave.status, 200);

  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.body.providers.length, 1);
  assert.equal(list.body.activeProviderId, "deepseek");
  assert.equal(publicEntry(list.body.providers, "deepseek").model, "deepseek-chat");
  assert.equal(list.body.providers[0].hasApiKey, true);
});
