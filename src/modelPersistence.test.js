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
process.env.MONGODB_URI = mongod.getUri("vupsrouter_model_persistence_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: ProviderConfig } = await import("./providerConfig.js");
const { startFakeProvider, FAKE_API_KEY, FAKE_MODELS } = await import("./testUtils/fakeProvider.js");
const {
  startFakeQoder,
  FAKE_QODER_API_KEY,
  FAKE_QODER_SA_KEY,
  FAKE_QODER_MODELS
} = await import("./testUtils/fakeQoder.js");

const fakeA = await startFakeProvider();
const fakeB = await startFakeProvider();
const fakeQoder = await startFakeQoder();
const qoderBusinessUrl = fakeQoder.baseUrl;
const qoderOpenapiUrl = new URL(fakeQoder.baseUrl).origin;

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeA.close();
  await fakeB.close();
  await fakeQoder.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `models${Date.now()}-${counter}@example.com`;
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
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Model Persistence Tester", email: uniqueEmail(), password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return sessionCookie(response);
}

function providerPayload(overrides = {}) {
  return {
    provider: "Catalog Provider",
    providerId: "catalog",
    baseUrl: fakeA.baseUrl,
    apiKey: FAKE_API_KEY,
    model: "",
    ...overrides
  };
}

async function saveProvider(cookie, overrides = {}) {
  const providerId = overrides.providerId || "catalog";
  return api(`/api/settings/providers/${providerId}`, {
    method: "PUT",
    cookie,
    body: providerPayload(overrides)
  });
}

async function entryOf(cookie, providerId) {
  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.status, 200);
  return list.body.providers.find(item => item.providerId === providerId);
}

async function storedOf(providerId) {
  return ProviderConfig.findOne({ providerId }).select("+encryptedApiKey");
}

function modelIds(list) {
  return list.map(model => model.id);
}

test("saving a provider persists its model list and default model", async () => {
  const cookie = await signupUser();
  const saved = await saveProvider(cookie, {
    providerId: "openrouter-cat",
    provider: "OpenRouter Cat",
    models: ["deepseek/deepseek-chat", "meta-llama/llama-3.3-70b"],
    defaultModel: "meta-llama/llama-3.3-70b"
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.config.models, ["deepseek/deepseek-chat", "meta-llama/llama-3.3-70b"]);
  assert.equal(saved.body.config.defaultModel, "meta-llama/llama-3.3-70b");
  assert.equal(saved.body.config.model, "meta-llama/llama-3.3-70b", "an empty model field falls back to the default");

  const reloaded = await entryOf(cookie, "openrouter-cat");
  assert.deepEqual(reloaded.models, ["deepseek/deepseek-chat", "meta-llama/llama-3.3-70b"]);
  assert.equal(reloaded.defaultModel, "meta-llama/llama-3.3-70b");

  const stored = await storedOf("openrouter-cat");
  assert.equal(stored.models.length, 2);
  assert.equal(stored.defaultModel, "meta-llama/llama-3.3-70b");
});

test("a provider save without a models field keeps the saved catalogue and rotates the key", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, {
    providerId: "keep-cat",
    provider: "Keep Cat",
    models: ["hand-typed-model"],
    defaultModel: "hand-typed-model"
  });

  const edited = await saveProvider(cookie, {
    providerId: "keep-cat",
    provider: "Keep Cat",
    apiKey: "sk-rotated-key-999999"
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.config.models, ["hand-typed-model"]);
  assert.equal(edited.body.config.defaultModel, "hand-typed-model");

  const stored = await storedOf("keep-cat");
  assert.deepEqual(stored.models, ["hand-typed-model"]);
  assert.ok(stored.encryptedApiKey.includes("•") || stored.encryptedApiKey.length > 0);
  assert.doesNotMatch(stored.encryptedApiKey, /sk-rotated-key-999999/, "the secret stays encrypted at rest");
});

test("an explicit empty model list is rejected instead of erasing the catalogue", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, {
    providerId: "empty-cat",
    provider: "Empty Cat",
    models: ["model-one", "model-two"],
    defaultModel: "model-one"
  });

  const cleared = await saveProvider(cookie, {
    providerId: "empty-cat",
    provider: "Empty Cat",
    models: []
  });
  assert.equal(cleared.status, 400);
  assert.match(cleared.body.message, /Save models & default/);

  const entry = await entryOf(cookie, "empty-cat");
  assert.deepEqual(entry.models, ["model-one", "model-two"]);
  assert.equal(entry.defaultModel, "model-one");
});

test("an invalid default model is rejected and a dropped default never points outside the catalogue", async () => {
  const cookie = await signupUser();
  const badDefault = await saveProvider(cookie, {
    providerId: "default-cat",
    provider: "Default Cat",
    models: ["model-a", "model-b"],
    defaultModel: "model-not-saved"
  });
  assert.equal(badDefault.status, 400);
  assert.match(badDefault.body.message, /default model must be one of the saved model IDs/);

  await saveProvider(cookie, {
    providerId: "default-cat",
    provider: "Default Cat",
    models: ["model-a", "model-b"],
    defaultModel: "model-b"
  });
  const shrunk = await saveProvider(cookie, {
    providerId: "default-cat",
    provider: "Default Cat",
    models: ["model-a"]
  });
  assert.equal(shrunk.status, 200, JSON.stringify(shrunk.body));
  assert.equal(shrunk.body.config.defaultModel, "", "a default removed from the list cannot survive");
  assert.deepEqual(shrunk.body.config.models, ["model-a"]);
});

test("the models editor accepts duplicate IDs and rejects malformed lists without touching stored data", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, { providerId: "editor-cat", provider: "Editor Cat" });

  const deduped = await api("/api/settings/providers/editor-cat/models", {
    method: "PUT",
    cookie,
    body: { models: ["m1", "m1", "m2"], defaultModel: "m2" }
  });
  assert.equal(deduped.status, 200, JSON.stringify(deduped.body));
  assert.deepEqual(deduped.body.config.models, ["m1", "m2"]);
  assert.equal(deduped.body.config.defaultModel, "m2");

  const cases = [
    { body: { models: ["m1", 42] }, label: "a non-string entry" },
    { body: { models: ["m1", "   "] }, label: "a blank entry" },
    { body: { models: ["x".repeat(201)] }, label: "an over-long entry" },
    { body: { models: Array.from({ length: 501 }, (_, index) => `model-${index}`) }, label: "more than 500 entries" }
  ];
  for (const item of cases) {
    const rejected = await api("/api/settings/providers/editor-cat/models", { method: "PUT", cookie, body: item.body });
    assert.equal(rejected.status, 400, `${item.label} must be rejected`);
    assert.match(rejected.body.message, /model/i);
  }

  const entry = await entryOf(cookie, "editor-cat");
  assert.deepEqual(entry.models, ["m1", "m2"], "a rejected edit never changes the stored catalogue");
  assert.equal(entry.defaultModel, "m2");
});

test("discovery merges additively and never removes a manually saved model", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, { providerId: "merge-cat", provider: "Merge Cat" });
  await api("/api/settings/providers/merge-cat/models", {
    method: "PUT",
    cookie,
    body: { models: ["hand-typed-model"], defaultModel: "hand-typed-model" }
  });
  fakeA.state.reset();
  fakeA.state.set({ extraModels: [{ id: "newly-listed" }] });
  try {
    const tested = await api("/api/settings/providers/merge-cat/test", { method: "POST", cookie, body: {} });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.ok(tested.body.availableModels.some(model => model.id === "newly-listed"));

    const entry = await entryOf(cookie, "merge-cat");
    assert.deepEqual(
      [...entry.models].sort(),
      [...FAKE_MODELS, "hand-typed-model", "newly-listed"].sort(),
      "discovery adds to the catalogue instead of replacing it"
    );
    assert.equal(entry.defaultModel, "hand-typed-model", "discovery never changes the default");
    assert.equal(fakeA.state.chatRequests.length, 0, "a connection test must not run inference");
  } finally {
    fakeA.state.reset();
  }
});

test("one malformed discovery entry does not block persisting the valid models", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, { providerId: "partial-cat", provider: "Partial Cat" });
  fakeA.state.reset();
  fakeA.state.set({ extraModels: [{ name: "entry-without-id" }, null, { id: "good-one" }] });
  try {
    const listing = await api("/api/settings/models?configId=partial-cat", { cookie });
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    const entry = await entryOf(cookie, "partial-cat");
    assert.ok(entry.models.includes("good-one"), JSON.stringify(entry.models));
    assert.ok(!entry.models.includes(undefined));
    assert.equal(entry.defaultModel, "");
  } finally {
    fakeA.state.reset();
  }
});

test("a failed discovery keeps saved models and the default visible", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, { providerId: "outage-cat", provider: "Outage Cat" });
  await api("/api/settings/providers/outage-cat/models", {
    method: "PUT",
    cookie,
    body: { models: ["model-one", "model-two"], defaultModel: "model-two" }
  });
  fakeA.state.reset();
  fakeA.state.set({ listStatus: 500 });
  try {
    const listing = await api("/api/settings/models?configId=outage-cat", { cookie });
    assert.equal(listing.status, 200);
    assert.ok(listing.body.warning, "the outage is reported instead of hidden");
    assert.deepEqual(modelIds(listing.body.models), ["model-one", "model-two"]);

    const tested = await api("/api/settings/providers/outage-cat/test", { method: "POST", cookie, body: {} });
    assert.equal(tested.status, 400);

    const entry = await entryOf(cookie, "outage-cat");
    assert.deepEqual(entry.models, ["model-one", "model-two"]);
    assert.equal(entry.defaultModel, "model-two");
  } finally {
    fakeA.state.reset();
  }
});

test("each configuration keeps its own catalogue when both providers are refreshed", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, { providerId: "provider-one", provider: "Provider One", baseUrl: fakeA.baseUrl });
  await saveProvider(cookie, { providerId: "provider-two", provider: "Provider Two", baseUrl: fakeB.baseUrl });
  await api("/api/settings/providers/provider-one/models", {
    method: "PUT",
    cookie,
    body: { models: ["only-in-one"], defaultModel: "only-in-one" }
  });
  await api("/api/settings/providers/provider-two/models", {
    method: "PUT",
    cookie,
    body: { models: ["only-in-two"], defaultModel: "only-in-two" }
  });

  fakeA.state.reset();
  fakeB.state.reset();
  fakeA.state.set({ extraModels: [{ id: "listed-in-one" }] });
  try {
    const refreshed = await api("/api/settings/models?configId=provider-one", { cookie });
    assert.equal(refreshed.status, 200);
    assert.ok(modelIds(refreshed.body.models).includes("listed-in-one"));

    const one = await entryOf(cookie, "provider-one");
    const two = await entryOf(cookie, "provider-two");
    assert.ok(one.models.includes("only-in-one"));
    assert.deepEqual(two.models, ["only-in-two"], "refreshing one provider cannot rewrite another");
    assert.equal(two.defaultModel, "only-in-two");
    assert.notEqual(one.configId, two.configId);
  } finally {
    fakeA.state.reset();
    fakeB.state.reset();
  }
});

test("concurrent discovery on one configuration never drops a model", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, { providerId: "race-cat", provider: "Race Cat" });
  await api("/api/settings/providers/race-cat/models", {
    method: "PUT",
    cookie,
    body: { models: ["manual-a"], defaultModel: "manual-a" }
  });
  fakeA.state.reset();
  fakeA.state.set({ extraModels: [{ id: "concurrent-1" }] });
  try {
    const both = await Promise.all([
      api("/api/settings/providers/race-cat/test", { method: "POST", cookie, body: {} }),
      api("/api/settings/providers/race-cat/test", { method: "POST", cookie, body: {} })
    ]);
    for (const response of both) assert.equal(response.status, 200, JSON.stringify(response.body));
    const entry = await entryOf(cookie, "race-cat");
    for (const id of ["manual-a", "concurrent-1", ...FAKE_MODELS]) {
      assert.ok(entry.models.includes(id), `${id} survived concurrent discovery`);
    }
    assert.equal(entry.models.length, 5);
    assert.equal(new Set(entry.models).size, entry.models.length, "the merge leaves no duplicates");
  } finally {
    fakeA.state.reset();
  }
});

test("the 500-model cap is enforced consistently across saving and discovery", async () => {
  const cookie = await signupUser();
  await saveProvider(cookie, { providerId: "cap-cat", provider: "Cap Cat" });
  const seeded = Array.from({ length: 499 }, (_, index) => `seed-model-${index}`);
  const savedList = await api("/api/settings/providers/cap-cat/models", {
    method: "PUT",
    cookie,
    body: { models: seeded, defaultModel: "seed-model-0" }
  });
  assert.equal(savedList.status, 200);
  assert.equal(savedList.body.config.models.length, 499);

  fakeA.state.reset();
  fakeA.state.set({ extraModels: [{ id: "cap-extra-1" }, { id: "cap-extra-2" }] });
  try {
    const tested = await api("/api/settings/providers/cap-cat/test", { method: "POST", cookie, body: {} });
    assert.equal(tested.status, 200);
    const stored = await storedOf("cap-cat");
    assert.equal(stored.models.length, 500, "discovery fills the catalogue up to the cap and no further");
    assert.equal(new Set(stored.models).size, 500);
  } finally {
    fakeA.state.reset();
  }

  const tooMany = await api("/api/settings/providers/cap-cat/models", {
    method: "PUT",
    cookie,
    body: { models: Array.from({ length: 501 }, (_, index) => `over-${index}`) }
  });
  assert.equal(tooMany.status, 400);
  const afterReject = await storedOf("cap-cat");
  assert.equal(afterReject.models.length, 500, "a rejected save leaves the catalogue intact");
});

test("model payloads and errors never echo the API key", async () => {
  const cookie = await signupUser();
  const saved = await saveProvider(cookie, {
    providerId: "leak-cat",
    provider: "Leak Cat",
    apiKey: "sk-leak-secret-123456",
    models: ["model-one"],
    defaultModel: "model-one"
  });
  assert.equal(saved.status, 200);
  assert.doesNotMatch(JSON.stringify(saved.body), /sk-leak-secret-123456/);

  fakeA.state.reset();
  fakeA.state.set({ listStatus: 401, invalidKey: true });
  try {
    const listing = await api("/api/settings/models?configId=leak-cat", { cookie });
    assert.equal(listing.status, 200);
    assert.doesNotMatch(JSON.stringify(listing.body), /sk-leak-secret-123456/);
  } finally {
    fakeA.state.reset();
  }

  const refreshed = await api("/api/settings/models", { cookie });
  assert.doesNotMatch(JSON.stringify(refreshed.body), /sk-leak-secret-123456/);
});

test("a Qoder configuration keeps models, auth mode, region and default across a re-save", async () => {
  const cookie = await signupUser();
  const save = await api("/api/settings/providers/qoder-cloud", {
    method: "PUT",
    cookie,
    body: {
      provider: "Qoder Cloud",
      providerId: "qoder-cloud",
      baseUrl: qoderBusinessUrl,
      apiKey: FAKE_QODER_SA_KEY,
      providerType: "qoder_cloud_agents",
      authMode: "service_account",
      openapiBaseUrl: qoderOpenapiUrl,
      model: "",
      models: FAKE_QODER_MODELS,
      defaultModel: "giga"
    }
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.deepEqual(save.body.config.models, FAKE_QODER_MODELS);
  assert.equal(save.body.config.defaultModel, "giga");
  assert.equal(save.body.config.authMode, "service_account");
  assert.equal(save.body.config.openapiBaseUrl, qoderOpenapiUrl);

  fakeQoder.state.clearRequests();
  const tested = await api("/api/settings/providers/qoder-cloud/test", { method: "POST", cookie, body: {} });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));

  const reSaved = await api("/api/settings/providers/qoder-cloud", {
    method: "PUT",
    cookie,
    body: {
      provider: "Qoder Cloud",
      providerId: "qoder-cloud",
      baseUrl: qoderBusinessUrl,
      providerType: "qoder_cloud_agents"
    }
  });
  assert.equal(reSaved.status, 200, JSON.stringify(reSaved.body));
  assert.deepEqual(reSaved.body.config.models, FAKE_QODER_MODELS, "re-saving without models keeps the catalogue");
  assert.equal(reSaved.body.config.defaultModel, "giga");
  assert.equal(reSaved.body.config.authMode, "service_account", "the token mode survives an edit");
  assert.equal(reSaved.body.config.openapiBaseUrl, qoderOpenapiUrl, "the region survives an edit");

  const entry = await entryOf(cookie, "qoder-cloud");
  assert.deepEqual(entry.models, FAKE_QODER_MODELS);
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(FAKE_QODER_SA_KEY));
  assert.doesNotMatch(JSON.stringify(await storedOf("qoder-cloud")), new RegExp(FAKE_QODER_SA_KEY));
  assert.equal(await (async () => {
    const rows = await ProviderConfig.find({ providerId: "qoder-cloud" });
    return rows.length;
  })(), 1, "the discovery merge never spawns a second configuration row");
});

test("a Qoder catalogue survives a model-listing outage", async () => {
  const cookie = await signupUser();
  await api("/api/settings/providers/qoder-pat", {
    method: "PUT",
    cookie,
    body: {
      provider: "Qoder PAT",
      providerId: "qoder-pat",
      baseUrl: qoderBusinessUrl,
      apiKey: FAKE_QODER_API_KEY,
      providerType: "qoder_cloud_agents",
      authMode: "pat",
      openapiBaseUrl: qoderOpenapiUrl,
      model: "ultimate",
      models: ["ultimate", "private-model"],
      defaultModel: "ultimate"
    }
  });
  fakeQoder.state.clearRequests();
  fakeQoder.state.modelsStatus = 503;
  try {
    const listing = await api("/api/settings/models?configId=qoder-pat", { cookie });
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    assert.ok(listing.body.warning, "the outage is surfaced as a warning");
    assert.deepEqual(modelIds(listing.body.models), ["ultimate", "private-model"]);

    const chat = await api("/api/settings/providers", { cookie });
    const entry = chat.body.providers.find(item => item.providerId === "qoder-pat");
    assert.deepEqual(entry.models, ["ultimate", "private-model"]);
    assert.equal(entry.defaultModel, "ultimate");
    assert.equal(entry.authMode, "pat");
  } finally {
    fakeQoder.state.clearRequests();
  }
});
