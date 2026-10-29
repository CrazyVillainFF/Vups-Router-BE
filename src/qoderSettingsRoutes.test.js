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
process.env.MONGODB_URI = mongod.getUri("vupsrouter_qoder_settings_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: ProviderConfig } = await import("./providerConfig.js");
const { startFakeQoder, FAKE_QODER_API_KEY, FAKE_QODER_SA_KEY, FAKE_QODER_MODELS } = await import("./testUtils/fakeQoder.js");

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
  return `qodersettings${Date.now()}-${counter}@example.com`;
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
    body: { name: "Qoder Settings Tester", email: uniqueEmail(), password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return sessionCookie(response);
}

function qoderPayload(overrides = {}) {
  return {
    provider: "Qoder Cloud",
    providerId: "qoder-cloud",
    baseUrl: businessUrl,
    apiKey: FAKE_QODER_API_KEY,
    providerType: "qoder_cloud_agents",
    model: FAKE_QODER_MODELS[0],
    authMode: "pat",
    ...overrides
  };
}

test("a saved Qoder service account configuration round-trips through the settings API", async () => {
  const cookie = await signupUser();
  const save = await api("/api/settings/providers/qoder-cloud", {
    method: "PUT",
    cookie,
    body: qoderPayload({ apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: openapiUrl })
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.config.authMode, "service_account");
  assert.equal(save.body.config.openapiBaseUrl, openapiUrl);
  assert.notEqual(save.body.config.apiKeyMasked, FAKE_QODER_SA_KEY, "the key is never returned in full");
  assert.match(save.body.config.apiKeyMasked, /•|…|\.\.\./);

  const list = await api("/api/settings/providers", { cookie });
  assert.equal(list.status, 200);
  const entry = list.body.providers.find(item => item.providerId === "qoder-cloud");
  assert.equal(entry.authMode, "service_account");
  assert.equal(entry.openapiBaseUrl, openapiUrl);
  assert.equal(entry.providerType, "qoder_cloud_agents");

  const stored = await ProviderConfig.find({}).select("+encryptedApiKey");
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(FAKE_QODER_SA_KEY));
  assert.doesNotMatch(JSON.stringify(list.body), new RegExp(FAKE_QODER_SA_KEY));
});

test("testing a saved service account exchanges the key and never sends it to the business API", async () => {
  const cookie = await signupUser();
  await api("/api/settings/providers/qoder-sa", {
    method: "PUT",
    cookie,
    body: qoderPayload({ providerId: "qoder-sa", apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: openapiUrl })
  });
  fake.state.clearRequests();
  const tested = await api("/api/settings/providers/qoder-sa/test", { method: "POST", cookie, body: {} });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.ok, true);
  assert.deepEqual(tested.body.availableModels.map(model => model.id), FAKE_QODER_MODELS);
  const exchange = fake.state.requests.filter(entry => entry.path === "/api/v1/serviceToken/exchange");
  assert.equal(exchange.length, 1, "exactly one exchange");
  assert.equal(exchange[0].headers.authorization, `Bearer ${FAKE_QODER_SA_KEY}`, "the SA key is used only for the exchange");
  const business = fake.state.requests.filter(entry => entry.path.startsWith("/api/v1/cloud/"));
  assert.ok(business.length > 0);
  assert.ok(business.every(entry => entry.headers.authorization !== `Bearer ${FAKE_QODER_SA_KEY}`), "SA key never reaches the business API");
  assert.ok(business.every(entry => /^Bearer sat-fake-/.test(String(entry.headers.authorization))), "business calls use the exchanged token");
});

test("changing the Qoder auth mode clears a saved connection result", async () => {
  const cookie = await signupUser();
  await api("/api/settings/providers/qoder-flip", {
    method: "PUT",
    cookie,
    body: qoderPayload({ providerId: "qoder-flip" })
  });
  const tested = await api("/api/settings/providers/qoder-flip/test", { method: "POST", cookie, body: {} });
  assert.equal(tested.status, 200);
  let entry = (await api("/api/settings/providers", { cookie })).body.providers.find(item => item.providerId === "qoder-flip");
  assert.equal(entry.lastTest.status, "connected");

  const saved = await api("/api/settings/providers/qoder-flip", {
    method: "PUT",
    cookie,
    body: qoderPayload({ providerId: "qoder-flip", apiKey: "", authMode: "service_account", openapiBaseUrl: openapiUrl })
  });
  assert.equal(saved.status, 200);
  entry = (await api("/api/settings/providers", { cookie })).body.providers.find(item => item.providerId === "qoder-flip");
  assert.equal(entry.lastTest, null, "a behavior change invalidates the stored result instead of showing it as connected");
});

test("mismatched regions are rejected on save and the previous configuration survives", async () => {
  const cookie = await signupUser();
  await api("/api/settings/providers/qoder-region", {
    method: "PUT",
    cookie,
    body: qoderPayload({ providerId: "qoder-region" })
  });
  const rejected = await api("/api/settings/providers/qoder-region", {
    method: "PUT",
    cookie,
    body: qoderPayload({
      providerId: "qoder-region",
      apiKey: "",
      baseUrl: "https://api.qoder.com/api/v1/cloud",
      authMode: "service_account",
      openapiBaseUrl: "https://openapi.qoder.com.cn"
    })
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.message, /same region/);
  const entry = (await api("/api/settings/providers", { cookie })).body.providers.find(item => item.providerId === "qoder-region");
  assert.equal(entry.baseUrl, businessUrl, "the rejected edit did not overwrite the saved endpoint");
  assert.equal(entry.authMode, "pat");
});

test("a service account save without an OpenAPI URL is rejected with a clear message", async () => {
  const cookie = await signupUser();
  const rejected = await api("/api/settings/providers/qoder-nourl", {
    method: "PUT",
    cookie,
    body: qoderPayload({
      providerId: "qoder-nourl",
      baseUrl: "https://qoder.example.com/api/v1/cloud",
      authMode: "service_account",
      openapiBaseUrl: ""
    })
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.message, /OpenAPI base URL/);
});

test("an expired service account token is refreshed on the next test", async () => {
  const cookie = await signupUser();
  await api("/api/settings/providers/qoder-refresh", {
    method: "PUT",
    cookie,
    body: qoderPayload({ providerId: "qoder-refresh", apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: openapiUrl })
  });
  fake.state.clearRequests();
  const first = await api("/api/settings/providers/qoder-refresh/test", { method: "POST", cookie, body: {} });
  assert.equal(first.status, 200);
  fake.state.rejectSatOnce = true;
  const second = await api("/api/settings/providers/qoder-refresh/test", { method: "POST", cookie, body: {} });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.ok, true);
  const exchanges = fake.state.requests.filter(entry => entry.path === "/api/v1/serviceToken/exchange");
  assert.ok(exchanges.length >= 1, "a rejected token triggers a fresh exchange");
  assert.equal(fake.state.rejectSatOnce, false, "the server retried after the cached token was rejected");
});
