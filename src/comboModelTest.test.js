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
process.env.MONGODB_URI = mongod.getUri("vupsrouter_combo_testaction_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { startFakeProvider, FAKE_API_KEY, FAKE_MODELS } = await import("./testUtils/fakeProvider.js");

const fake = await startFakeProvider();
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
  return `testaction${Date.now()}-${counter}@example.com`;
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
  const cookies = response.headers.getSetCookie?.() || [];
  const session = cookies.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function signupUser() {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Test Action", email: uniqueEmail(), password: "correct-horse-battery", acceptTerms: true }
  });
  assert.equal(response.status, 201);
  return sessionCookie(response);
}

// Every case in this file talks to the local fake provider, so it is deterministic
// and never touches a configured credential. Live provider results are reported
// separately.
async function saveProvider(cookie, { id = "fake", name = "Fake", models = FAKE_MODELS }) {
  const response = await api(`/api/settings/providers/${id}`, {
    method: "PUT",
    cookie,
    body: {
      provider: name,
      providerId: id,
      baseUrl: fake.baseUrl,
      apiKey: FAKE_API_KEY,
      providerType: "openai_compatible",
      model: models[0],
      models,
      defaultModel: models[0]
    }
  });
  assert.equal(response.status, 200, response.text);
  return response.body.config;
}

async function comboState(cookie) {
  const response = await api("/api/combo", { cookie });
  assert.equal(response.status, 200, response.text);
  return response.body;
}

function entryFor(state, model) {
  const entry = (state.catalog?.models || []).find(row => row.model === model);
  assert.ok(entry, `catalog row for ${model}`);
  return entry;
}

function availabilityOf(state) {
  return state.config?.availability || [];
}

async function testModel(cookie, key) {
  return api("/api/combo/test", { method: "POST", cookie, body: { key } });
}

async function readyUser({ models = FAKE_MODELS, selected = [] } = {}) {
  const cookie = await signupUser();
  await saveProvider(cookie, { models });
  const state = await comboState(cookie);
  const rows = selected.map(model => entryFor(state, model));
  if (rows.length > 0) {
    const save = await api("/api/combo", { method: "PUT", cookie, body: { selected: rows } });
    assert.equal(save.status, 200, save.text);
  }
  return { cookie, catalog: await comboState(cookie) };
}

test("a successful test proves the model answered, using that model and its own stored key", async () => {
  const user = await readyUser();
  const entry = entryFor(user.catalog, "fake-model-pro");
  fake.state.reset();

  const response = await testModel(user.cookie, entry.key);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.model.status, "working");
  assert.equal(response.body.model.key, entry.key);
  assert.ok(Number.isFinite(response.body.model.latencyMs));
  assert.equal(response.body.model.httpStatus, null);
  assert.equal(response.body.model.detail, "");
  assert.ok(Date.parse(response.body.model.checkedAt));

  assert.equal(fake.state.chatRequests.length, 1);
  assert.equal(fake.state.chatRequests[0].body.model, "fake-model-pro");
  assert.equal(fake.state.chatRequests[0].key, FAKE_API_KEY);
});

test("testing one model does not mark its provider's other models working", async () => {
  const user = await readyUser();
  const entry = entryFor(user.catalog, "fake-model-mini");
  fake.state.reset();

  assert.equal((await testModel(user.cookie, entry.key)).status, 200);
  const rows = availabilityOf(await comboState(user.cookie));
  assert.deepEqual(rows.map(row => row.key), [entry.key]);
  assert.equal(rows[0].status, "working");
});

test("a provider failure records Not Working with the HTTP status and a redacted detail", async () => {
  const user = await readyUser();
  const entry = entryFor(user.catalog, "fake-model-reasoning");
  fake.state.reset();
  fake.state.set({
    failModel: "fake-model-reasoning",
    failModelStatus: 429,
    failModelMessage: `Rate limited while using ${FAKE_API_KEY}.`
  });

  const response = await testModel(user.cookie, entry.key);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.model.status, "not_working");
  assert.equal(response.body.model.httpStatus, 429);
  assert.equal(response.body.model.retryable, true);
  assert.ok(response.body.model.reason);
  assert.ok(!response.text.includes(FAKE_API_KEY), "the key must not travel back to the client");
  assert.ok(!response.body.model.detail.includes(FAKE_API_KEY));
  assert.match(response.body.model.detail, /Rate limited/);

  const rows = availabilityOf(await comboState(user.cookie));
  assert.deepEqual(rows.map(row => row.status), ["not_working"]);
});

test("an HTTP 200 that carries no model answer is not a successful test", async () => {
  const user = await readyUser();
  const entry = entryFor(user.catalog, "fake-model-mini");
  fake.state.reset();
  // A well-formed 200 whose content is empty: the endpoint accepted the request,
  // the model said nothing.
  fake.state.set({ chatResponseText: "" });

  const response = await testModel(user.cookie, entry.key);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.model.status, "not_working");
  assert.equal(response.body.model.httpStatus, 200);
  assert.equal(response.body.model.reason, "empty_response");
  assert.ok(!/"status":"working"/.test(response.text));
  assert.equal(availabilityOf(await comboState(user.cookie))[0].status, "not_working");
});

test("a rejected credential is a permanent failure, not a retryable one", async () => {
  const user = await readyUser();
  const entry = entryFor(user.catalog, "fake-model-mini");
  fake.state.reset();
  fake.state.set({ invalidKey: true });

  const response = await testModel(user.cookie, entry.key);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.model.status, "not_working");
  assert.equal(response.body.model.httpStatus, 401);
  assert.equal(response.body.model.retryable, false);
});

test("a hung provider is cut off by the configured probe timeout", async () => {
  const user = await readyUser({ models: ["fake-model-mini"] });
  const entry = entryFor(user.catalog, "fake-model-mini");
  const save = await api("/api/combo", {
    method: "PUT",
    cookie: user.cookie,
    body: { selected: [entry], settings: { probeTimeoutMs: 5000 } }
  });
  assert.equal(save.status, 200, save.text);
  fake.state.reset();
  fake.state.set({ chatDelayMs: 9000 });

  const startedAt = Date.now();
  const response = await testModel(user.cookie, entry.key);
  const elapsed = Date.now() - startedAt;
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.model.status, "not_working");
  assert.equal(response.body.model.retryable, true);
  assert.ok(elapsed < 8000, `the probe outlived its own timeout: ${elapsed}ms`);
});

test("a cancelled test records no status", async () => {
  const user = await readyUser();
  const entry = entryFor(user.catalog, "fake-model-mini");
  fake.state.reset();
  fake.state.set({ chatDelayMs: 4000 });

  const controller = new AbortController();
  const pending = fetch(`${baseURL}/api/combo/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: user.cookie },
    body: JSON.stringify({ key: entry.key }),
    signal: controller.signal
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  controller.abort();
  await pending.catch(() => {});

  assert.deepEqual(availabilityOf(await comboState(user.cookie)), []);
});

test("parallel tests on one model send a single request, and concurrent models keep both results", async () => {
  const user = await readyUser();
  const mini = entryFor(user.catalog, "fake-model-mini");
  const pro = entryFor(user.catalog, "fake-model-pro");
  fake.state.reset();
  fake.state.set({ chatDelayMs: 300 });

  const first = testModel(user.cookie, mini.key);
  await new Promise(resolve => setTimeout(resolve, 120));
  const second = await testModel(user.cookie, mini.key);
  const firstResponse = await first;

  assert.equal(firstResponse.status, 200, firstResponse.text);
  assert.equal(second.status, 200, second.text);
  assert.equal(firstResponse.body.model.status, "working");
  assert.equal(second.body.model.status, "working");
  assert.equal(second.body.reused, true);
  assert.equal(fake.state.chatRequests.length, 1, "one model must not get two live probes");

  const both = await Promise.all([testModel(user.cookie, mini.key), testModel(user.cookie, pro.key)]);
  assert.deepEqual(both.map(row => row.status), [200, 200]);
  const keys = new Set(availabilityOf(await comboState(user.cookie)).map(row => row.key));
  assert.deepEqual(keys, new Set([mini.key, pro.key]));
});

test("a test leaves the selection and the saved provider configuration untouched", async () => {
  const user = await readyUser({ selected: ["fake-model-mini"] });
  const pro = entryFor(user.catalog, "fake-model-pro");
  fake.state.reset();
  const before = await api("/api/settings/providers", { cookie: user.cookie });
  assert.equal(before.status, 200, before.text);

  const response = await testModel(user.cookie, pro.key);
  assert.equal(response.status, 200, response.text);

  const after = await comboState(user.cookie);
  assert.deepEqual((after.config?.selected || []).map(row => row.model), ["fake-model-mini"]);
  const providers = await api("/api/settings/providers", { cookie: user.cookie });
  assert.equal(JSON.stringify(providers.body), JSON.stringify(before.body), "a test must not rewrite provider config");
});

test("saving a selection keeps a tested model that is not in it", async () => {
  const user = await readyUser();
  const mini = entryFor(user.catalog, "fake-model-mini");
  const pro = entryFor(user.catalog, "fake-model-pro");
  fake.state.reset();

  assert.equal((await testModel(user.cookie, pro.key)).status, 200);
  const save = await api("/api/combo", { method: "PUT", cookie: user.cookie, body: { selected: [mini] } });
  assert.equal(save.status, 200, save.text);
  assert.deepEqual(availabilityOf(save.body).map(row => `${row.key}:${row.status}`), [`${pro.key}:working`]);
});

test("a keyed availability recheck keeps statuses it did not probe", async () => {
  const user = await readyUser({ selected: ["fake-model-mini", "fake-model-pro"] });
  const mini = entryFor(user.catalog, "fake-model-mini");
  const pro = entryFor(user.catalog, "fake-model-pro");
  fake.state.reset();

  assert.equal((await testModel(user.cookie, pro.key)).status, 200);
  const recheck = await api("/api/combo/availability", {
    method: "POST",
    cookie: user.cookie,
    body: { keys: [mini.key], force: true }
  });
  assert.equal(recheck.status, 200, recheck.text);

  const rows = new Map(availabilityOf(await comboState(user.cookie)).map(row => [row.key, row.status]));
  assert.equal(rows.get(mini.key), "working");
  assert.equal(rows.get(pro.key), "working", "a recheck must not drop the other model's result");
});

test("an unknown key is refused and the request body cannot name a model, URL or key", async () => {
  const user = await readyUser();
  fake.state.reset();

  const missing = await testModel(user.cookie, "saved:none:never-heard-of-it");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "model_not_found");
  assert.equal((await testModel(user.cookie, "")).status, 400);

  const smuggled = await api("/api/combo/test", {
    method: "POST",
    cookie: user.cookie,
    body: {
      key: entryFor(user.catalog, "fake-model-mini").key,
      model: "not-in-my-catalog",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-sneaky-value"
    }
  });
  assert.equal(smuggled.status, 200, smuggled.text);
  assert.equal(fake.state.chatRequests.length, 1);
  assert.equal(fake.state.chatRequests[0].body.model, "fake-model-mini");
  assert.ok(!JSON.stringify(fake.state.chatRequests).includes("sk-sneaky-value"));
});

test("a test sends one probe request and starts no Combo orchestration", async () => {
  const user = await readyUser({ selected: ["fake-model-mini"] });
  const mini = entryFor(user.catalog, "fake-model-mini");
  fake.state.reset();

  assert.equal((await testModel(user.cookie, mini.key)).status, 200);
  assert.equal(fake.state.chatRequests.length, 1, "a review and a synthesis pass would mean more calls");
  assert.equal(fake.state.chatRequests[0].body.messages.length, 1);
  assert.match(fake.state.chatRequests[0].body.messages[0].content, /single word OK/);
});
