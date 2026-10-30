// End-to-end model-persistence scenario for VupsRouter.
// Runs the real Express app against a real MongoDB instance, three fake
// providers (OpenRouter-style, Qoder Cloud Agents, a local OpenAI-compatible
// gateway), restarts the database process, and checks that every saved model
// catalogue survives. Not part of `npm test` — run explicitly:
//   node scratch/model-persistence-scenario.mjs
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";

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
delete process.env.OMNIROUTE_BASE_URL;
delete process.env.OMNIROUTE_API_KEY;
delete process.env.OMNIROUTE_ENABLED;

const dbPath = path.join(os.tmpdir(), `vups-model-scenario-${Date.now()}`);
const dbName = "vupsrouter_model_scenario";
mkdirSync(dbPath, { recursive: true });
const mongod = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: "wiredTiger" } });
process.env.MONGODB_URI = mongod.getUri(dbName);

const { default: app } = await import("../src/index.js");
const { default: mongoose } = await import("mongoose");
const { default: ProviderConfig } = await import("../src/providerConfig.js");
const { startFakeProvider } = await import("../src/testUtils/fakeProvider.js");
const { startFakeQoder, FAKE_QODER_API_KEY, FAKE_QODER_MODELS } = await import("../src/testUtils/fakeQoder.js");

const openRouter = await startFakeProvider();
const localGateway = await startFakeProvider();
const qoder = await startFakeQoder();

const httpServer = app.listen(0, "127.0.0.1");
await new Promise(resolve => httpServer.once("listening", resolve));
const apiBase = `http://127.0.0.1:${httpServer.address().port}`;

const OPENROUTER_KEY = "sk-openrouter-scenario-1";
const LOCAL_KEY = "sk-ollama-scenario-2";
const QODER_PAT = FAKE_QODER_API_KEY;
openRouter.state.set({ acceptedKeys: [OPENROUTER_KEY], extraModels: [{ id: "deepseek/deepseek-chat-v3" }] });
localGateway.state.set({ acceptedKeys: [LOCAL_KEY], extraModels: [{ id: "qwen2.5-coder:7b" }] });

const seenBodies = [];
let cookie = "";

async function api(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
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
  seenBodies.push(JSON.stringify(json));
  const session = response.headers.getSetCookie().find(value => value.startsWith("vr_session="));
  if (session) cookie = session.split(";")[0];
  return { status: response.status, body: json };
}

const results = [];
let failures = 0;
function step(name, run) {
  return run().then(
    detail => results.push({ name, ok: true, detail }),
    error => {
      failures += 1;
      results.push({ name, ok: false, detail: error.message });
    }
  );
}

function entryOf(listBody, providerId) {
  return listBody.providers.find(item => item.providerId === providerId);
}

async function catalogOf(providerId) {
  const list = await api("/api/settings/providers");
  const entry = entryOf(list.body, providerId);
  if (!entry) throw new Error(`${providerId} is missing from the saved list`);
  return entry;
}

async function main() {
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Scenario Tester", email: `scenario${Date.now()}@example.com`, password: "correct-horse-battery" }
  });
  assert.equal(signup.status, 201, "signup must succeed for the scenario to mean anything");

  await step("1. save OpenRouter (no models selected yet)", async () => {
    const saved = await api("/api/settings/providers", {
      method: "POST",
      body: {
        provider: "OpenRouter",
        providerId: "openrouter",
        baseUrl: openRouter.baseUrl,
        apiKey: OPENROUTER_KEY,
        model: "deepseek/deepseek-chat-v3",
        providerType: "openai_compatible"
      }
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.config.models, []);
    return `created ${saved.body.config.configId}`;
  });

  await step("2. discover OpenRouter models", async () => {
    const listing = await api("/api/settings/models?configId=openrouter");
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    const entry = await catalogOf("openrouter");
    assert.ok(entry.models.includes("deepseek/deepseek-chat-v3"), JSON.stringify(entry.models));
    return `${entry.models.length} models persisted`;
  });

  await step("3. save Qoder with one custom model id", async () => {
    const saved = await api("/api/settings/providers/qoder", {
      method: "PUT",
      body: {
        provider: "Qoder Cloud",
        providerId: "qoder",
        baseUrl: qoder.baseUrl,
        apiKey: QODER_PAT,
        providerType: "qoder_cloud_agents",
        authMode: "pat",
        openapiBaseUrl: new URL(qoder.baseUrl).origin,
        model: "",
        models: ["qfmodel"],
        defaultModel: "qfmodel"
      }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.config.models, ["qfmodel"], "the custom id must survive the very first save");
    assert.equal(saved.body.config.defaultModel, "qfmodel");
    assert.equal(saved.body.config.openapiBaseUrl, new URL(qoder.baseUrl).origin);
    return `custom id saved, authMode ${saved.body.config.authMode}`;
  });

  await step("4. discover Qoder models without losing the custom id", async () => {
    const tested = await api("/api/settings/providers/qoder/test", { method: "POST", body: {} });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    const entry = await catalogOf("qoder");
    for (const id of ["qfmodel", ...FAKE_QODER_MODELS]) {
      assert.ok(entry.models.includes(id), `${id} missing after discovery: ${JSON.stringify(entry.models)}`);
    }
    assert.equal(entry.defaultModel, "qfmodel", "discovery must not move the default");
    return `${entry.models.length} models: ${entry.models.join(", ")}`;
  });

  await step("5. rotate the OpenRouter key only; catalogue must stay", async () => {
    const saved = await api("/api/settings/providers/openrouter", {
      method: "PUT",
      body: {
        provider: "OpenRouter",
        providerId: "openrouter",
        baseUrl: openRouter.baseUrl,
        apiKey: "sk-openrouter-scenario-rotated-9",
        model: "deepseek/deepseek-chat-v3",
        providerType: "openai_compatible"
      }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const entry = await catalogOf("openrouter");
    assert.ok(entry.models.length >= 4, JSON.stringify(entry.models));
    assert.ok(entry.models.includes("deepseek/deepseek-chat-v3"));
    const qoderEntry = await catalogOf("qoder");
    assert.ok(qoderEntry.models.includes("qfmodel"), "editing one provider cannot touch another");
    return `OpenRouter kept ${entry.models.length}, Qoder kept ${qoderEntry.models.length}`;
  });

  await step("6. set an explicit OpenRouter default through the models editor", async () => {
    const before = await catalogOf("openrouter");
    const saved = await api("/api/settings/providers/openrouter/models", {
      method: "PUT",
      body: { models: before.models, defaultModel: "fake-model-pro" }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.defaultModel, "fake-model-pro");
    assert.deepEqual(saved.body.config.models, before.models);
    return "duplicate-free catalogue re-saved";
  });

  await step("7. save a local OpenAI-compatible gateway (Ollama /v1)", async () => {
    const saved = await api("/api/settings/providers/ollama-local", {
      method: "PUT",
      body: {
        provider: "Ollama",
        providerId: "ollama-local",
        baseUrl: localGateway.baseUrl,
        apiKey: LOCAL_KEY,
        model: "qwen2.5-coder:7b",
        providerType: "openai_compatible"
      }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const tested = await api("/api/settings/providers/ollama-local/test", { method: "POST", body: {} });
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    const entry = await catalogOf("ollama-local");
    assert.ok(entry.models.includes("qwen2.5-coder:7b"), JSON.stringify(entry.models));
    const openRouterEntry = await catalogOf("openrouter");
    const qoderEntry = await catalogOf("qoder");
    assert.ok(openRouterEntry.models.length >= 4 && qoderEntry.models.includes("qfmodel"), "the other catalogues are intact");
    return `three catalogues: ${openRouterEntry.models.length}/${qoderEntry.models.length}/${entry.models.length}`;
  });

  await step("8. restart mongod and the backend connection, then reload", async () => {
    const before = await api("/api/settings/providers");
    const beforeMap = new Map(before.body.providers.map(item => [item.providerId, [...item.models].sort().join(",")]));
    await new Promise((resolve, reject) => httpServer.close(error => (error ? reject(error) : resolve())));
    await mongoose.disconnect();
    await mongod.stop({ doCleanup: false, force: false });
    await mongod.start();
    process.env.MONGODB_URI = mongod.getUri(dbName);
    const restarted = app.listen(0, "127.0.0.1");
    await new Promise(resolve => restarted.once("listening", resolve));
    globalThis.__restartedApiBase = `http://127.0.0.1:${restarted.address().port}`;
    const after = await apiOn(globalThis.__restartedApiBase, "/api/settings/providers");
    assert.equal(after.status, 200, JSON.stringify(after.body));
    for (const item of after.body.providers) {
      assert.equal(
        [...item.models].sort().join(","),
        beforeMap.get(item.providerId),
        `${item.providerId} lost models across the restart`
      );
      assert.equal(item.defaultModel, (before.body.providers.find(p => p.providerId === item.providerId) || {}).defaultModel);
    }
    assert.equal(after.body.providers.length, 3);
    return `3 configurations and ${after.body.providers.reduce((sum, item) => sum + item.models.length, 0)} models read back from disk`;
  });

  await step("9. a failing Qoder listing deletes nothing", async () => {
    qoder.state.clearRequests();
    qoder.state.modelsStatus = 503;
    const listing = await apiOn(globalThis.__restartedApiBase, "/api/settings/models?configId=qoder");
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    assert.ok(listing.body.warning, "the outage must be surfaced as a warning");
    assert.ok(listing.body.models.some(model => model.id === "qfmodel"), JSON.stringify(listing.body.models));
    const tested = await apiOn(globalThis.__restartedApiBase, "/api/settings/providers/qoder/test", { method: "POST", body: {} });
    assert.equal(tested.status, 400);
    qoder.state.clearRequests();
    const entry = await catalogOn(globalThis.__restartedApiBase, "qoder");
    assert.ok(entry.models.includes("qfmodel") && FAKE_QODER_MODELS.every(id => entry.models.includes(id)));
    assert.equal(entry.defaultModel, "qfmodel");
    return `${entry.models.length} models survived two failed Qoder refreshes`;
  });

  await step("10. a failing OpenRouter listing deletes nothing", async () => {
    openRouter.state.set({ listStatus: 500, acceptedKeys: ["sk-openrouter-scenario-rotated-9"] });
    const listing = await apiOn(globalThis.__restartedApiBase, "/api/settings/models?configId=openrouter");
    assert.equal(listing.status, 200);
    assert.ok(listing.body.warning);
    const entry = await catalogOn(globalThis.__restartedApiBase, "openrouter");
    assert.equal(entry.defaultModel, "fake-model-pro");
    assert.ok(entry.models.length >= 4, JSON.stringify(entry.models));
    openRouter.state.set({ listStatus: 200 });
    return `${entry.models.length} models and the default intact`;
  });

  await step("11. chat routes to the active configuration with its own model", async () => {
    openRouter.state.reset();
    openRouter.state.set({ acceptedKeys: ["sk-openrouter-scenario-rotated-9"] });
    localGateway.state.reset();
    localGateway.state.set({ acceptedKeys: [LOCAL_KEY] });
    const activated = await apiOn(globalThis.__restartedApiBase, "/api/settings/providers/openrouter/activate", { method: "POST" });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const chat = await apiOn(globalThis.__restartedApiBase, "/api/chat", {
      method: "POST",
      body: { stream: false, messages: [{ role: "user", content: "scenario" }] }
    });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    assert.equal(openRouter.state.chatRequests.length, 1);
    assert.equal(localGateway.state.chatRequests.length, 0, "an inactive provider must not receive traffic");
    assert.equal(openRouter.state.chatRequests[0].key, "sk-openrouter-scenario-rotated-9");
    assert.equal(openRouter.state.chatRequests[0].body.model, "fake-model-pro");
    return "default model + rotated key used, no cross-provider leakage";
  });

  await step("12. the chat picker catalog keeps every provider separate", async () => {
    const listing = await apiOn(globalThis.__restartedApiBase, "/api/settings/models");
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    const rows = listing.body.models;
    const byConfig = new Map();
    for (const row of rows) {
      if (row.shared) continue;
      const key = row.configId || row.providerId;
      byConfig.set(key, (byConfig.get(key) || []).concat(row.id));
    }
    assert.equal(byConfig.size, 3, `expected three personal configurations, got ${byConfig.size}`);
    for (const row of rows.filter(item => !item.shared)) {
      assert.equal(row.identity, `${row.providerId}:${row.id}`, `identity missing on ${row.id}`);
      assert.ok(row.configId, `a personal row has no configId: ${row.id}`);
    }
    const ids = rows.map(row => row.id);
    assert.ok(ids.includes("qfmodel") && ids.includes("qwen2.5-coder:7b") && ids.includes("fake-model-pro"));
    return `3 scopes: ${[...byConfig.entries()].map(([key, list]) => `${key}(${list.length})`).join(", ")}`;
  });

  await step("13. no response ever carries a provider secret", async () => {
    const all = seenBodies.join("\n");
    for (const secret of [OPENROUTER_KEY, LOCAL_KEY, "sk-openrouter-scenario-rotated-9", QODER_PAT]) {
      assert.ok(!all.includes(secret), `a response leaked ${secret.slice(0, 8)}…`);
    }
    const stored = await ProviderConfig.find({}).select("+encryptedApiKey");
    assert.ok(!JSON.stringify(stored).includes("sk-openrouter-scenario-rotated-9"), "keys are stored encrypted");
    return "13 response payloads and the raw rows scanned";
  });

  await step("14. a rejected save leaves the stored catalogue untouched", async () => {
    const before = await catalogOn(globalThis.__restartedApiBase, "ollama-local");
    const rejected = await apiOn(globalThis.__restartedApiBase, "/api/settings/providers/ollama-local", {
      method: "PUT",
      body: {
        provider: "Ollama",
        providerId: "ollama-local",
        baseUrl: localGateway.baseUrl,
        model: "qwen2.5-coder:7b",
        providerType: "openai_compatible",
        models: ["qwen2.5-coder:7b"],
        defaultModel: "not-in-the-list"
      }
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    const after = await catalogOn(globalThis.__restartedApiBase, "ollama-local");
    assert.deepEqual(after.models, before.models);
    assert.equal(after.defaultModel, before.defaultModel);
    return rejected.body.message;
  });

  console.log("\nMODEL PERSISTENCE SCENARIO");
  for (const item of results) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}\n      ${item.detail}`);
  }
  console.log(`\n${results.length - failures}/${results.length} steps passed`);
}

async function apiOn(base, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
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
  seenBodies.push(JSON.stringify(json));
  return { status: response.status, body: json };
}

async function catalogOn(base, providerId) {
  const list = await apiOn(base, "/api/settings/providers");
  const entry = list.body.providers.find(item => item.providerId === providerId);
  if (!entry) throw new Error(`${providerId} is missing from the saved list`);
  return entry;
}

try {
  await main();
} finally {
  await mongoose.disconnect().catch(() => {});
  await mongod.stop({ doCleanup: false, force: false }).catch(() => {});
  rmSync(dbPath, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
