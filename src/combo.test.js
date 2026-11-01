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
process.env.MONGODB_URI = mongod.getUri("vupsrouter_combo_test");

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: User } = await import("./user.js");
const { default: ComboConfig, normalizeComboSettings, normalizeSelectedModels } = await import("./comboConfig.js");
const { runAvailabilityChecks } = await import("./comboAvailability.js");
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
  return `combo${Date.now()}-${counter}@example.com`;
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
  const email = uniqueEmail();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Combo Tester", email, password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return { cookie: sessionCookie(response), email };
}

async function saveProvider(cookie, { id, name, key = FAKE_API_KEY, models = FAKE_MODELS }) {
  const response = await api(`/api/settings/providers/${id}`, {
    method: "PUT",
    cookie,
    body: {
      provider: name,
      providerId: id,
      baseUrl: fake.baseUrl,
      apiKey: key,
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

function modelsFor(catalog, configId, models) {
  return models.map(model => {
    const entry = catalog.models.find(row => row.kind === "saved" && row.configId === configId && row.model === model);
    assert.ok(entry, `catalog entry ${configId}/${model}`);
    return entry;
  });
}

async function selectModels(cookie, selected, settings) {
  const response = await api("/api/combo", {
    method: "PUT",
    cookie,
    body: { selected, ...(settings ? { settings } : {}) }
  });
  assert.equal(response.status, 200, response.text);
  return response.body.config;
}

function parseEvents(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    const data = block
      .split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* A heartbeat or non-SSE fragment is not a run event. */
    }
  }
  return events;
}

async function runCombo(
  cookie,
  messages = [{ role: "user", content: "Explain recursion briefly." }],
  extra = {}
) {
  const response = await fetch(`${baseURL}/api/combo/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ messages, ...extra })
  });
  const raw = await response.text();
  return { status: response.status, raw, events: parseEvents(raw) };
}

function eventOfType(events, type) {
  return events.filter(event => event.type === type);
}

function doneEvent(events) {
  return eventOfType(events, "done").at(-1) || null;
}

function deltaText(events) {
  return eventOfType(events, "delta").map(event => event.content).join("");
}

function responder() {
  return (body, model) => {
    const system = body.messages?.find(message => message.role === "system")?.content || "";
    if (system.includes("You compare independent answers")) {
      return JSON.stringify({
        conflicts: [{ topic: "base case", summary: "The drafts describe the stopping condition differently." }],
        completeness: "complete"
      });
    }
    if (system.includes("synthesis stage of Vups Combo AI")) return "SYNTHESIS-FINAL";
    return `DRAFT:${model}`;
  };
}

test("combo settings normalize to safe defaults and clamp input", () => {
  const settings = normalizeComboSettings({
    strategy: "bogus",
    timeoutMs: 1,
    retries: 99,
    maxConcurrent: 0,
    minWorkingModels: 5,
    maxWorkingModels: 2,
    healthTtlMs: 5
  });
  assert.equal(settings.strategy, "parallel");
  assert.equal(settings.timeoutMs, 5000);
  assert.equal(settings.retries, 2);
  assert.equal(settings.maxConcurrent, 1);
  assert.equal(settings.healthTtlMs, 15000);
  assert.equal(settings.minWorkingModels, 5);
  assert.equal(settings.maxWorkingModels, 5);

  const selected = normalizeSelectedModels([
    { kind: "saved", configId: "cfg", model: "model-a" },
    { kind: "saved", configId: "cfg", model: "model-a" },
    { kind: "saved", configId: "cfg", model: "" },
    { kind: "shared", model: "vendor/model" }
  ]);
  assert.equal(selected.length, 2);
  assert.equal(selected[0].key, "saved:cfg:model-a");
  assert.equal(selected[1].key, "shared:vendor/model");
});

test("selection is saved in priority order, deduplicated, and restored", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, { id: "combo-a", name: "Combo A", models: [FAKE_MODELS[0], FAKE_MODELS[1]] });
  const { catalog } = await comboState(cookie);
  const [first, second] = modelsFor(catalog, "combo-a", [FAKE_MODELS[1], FAKE_MODELS[0]]);

  const saved = await selectModels(cookie, [first, second, first], {
    strategy: "sequential",
    timeoutMs: 999999,
    retries: 9
  });
  assert.equal(saved.selected.length, 2);
  assert.equal(saved.selected[0].key, first.key);
  assert.equal(saved.selected[1].key, second.key);
  assert.equal(saved.settings.strategy, "sequential");
  assert.equal(saved.settings.timeoutMs, 300000);
  assert.equal(saved.settings.retries, 2);

  const restored = await comboState(cookie);
  assert.deepEqual(restored.config.selected.map(entry => entry.key), [first.key, second.key]);
  assert.equal(restored.config.settings.strategy, "sequential");
});

test("availability isolates invalid credentials and never exposes provider errors", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, { id: "combo-a", name: "Combo A", models: [FAKE_MODELS[0], FAKE_MODELS[1]] });
  await saveProvider(cookie, {
    id: "combo-b",
    name: "Combo B",
    key: "sk-wrong-key",
    models: [FAKE_MODELS[2], "fake-model-ghost"]
  });
  const { catalog } = await comboState(cookie);
  const selected = [
    ...modelsFor(catalog, "combo-a", [FAKE_MODELS[0], FAKE_MODELS[1]]),
    ...modelsFor(catalog, "combo-b", [FAKE_MODELS[2], "fake-model-ghost"])
  ];
  await selectModels(cookie, selected);

  const check = await api("/api/combo/availability", {
    method: "POST",
    cookie,
    body: { force: true }
  });
  assert.equal(check.status, 200, check.text);
  const statuses = Object.fromEntries(check.body.models.map(entry => [entry.key, entry.status]));
  assert.equal(statuses[selected[0].key], "working");
  assert.equal(statuses[selected[1].key], "working");
  assert.equal(statuses[selected[2].key], "not_working");
  assert.equal(statuses[selected[3].key], "not_working");
  for (const entry of check.body.models) {
    assert.deepEqual(Object.keys(entry).sort(), ["checkedAt", "key", "status"]);
  }
  assert.doesNotMatch(check.text, /Invalid API key|\b401\b/i);

  // Fixing the second provider's key must restore the eligible model without
  // the user having to reselect anything.
  await saveProvider(cookie, {
    id: "combo-b",
    name: "Combo B",
    key: FAKE_API_KEY,
    models: [FAKE_MODELS[2], "fake-model-ghost"]
  });
  const recovered = await api("/api/combo/availability", {
    method: "POST",
    cookie,
    body: { force: true }
  });
  assert.equal(recovered.status, 200, recovered.text);
  const recoveredStatuses = Object.fromEntries(recovered.body.models.map(entry => [entry.key, entry.status]));
  assert.equal(recoveredStatuses[selected[2].key], "working");
  assert.equal(recoveredStatuses[selected[3].key], "not_working");
  assert.equal(recoveredStatuses[selected[0].key], "working");

  const restored = await comboState(cookie);
  assert.equal(restored.config.selected.length, 4);
});

test("critical scenario: four selected, two working, only those two receive requests", async () => {
  fake.state.reset();
  const { cookie, email } = await signupUser();
  await saveProvider(cookie, { id: "combo-a", name: "Combo A", models: [FAKE_MODELS[0], FAKE_MODELS[1]] });
  await saveProvider(cookie, {
    id: "combo-b",
    name: "Combo B",
    key: "sk-wrong-key",
    models: [FAKE_MODELS[2], "fake-model-ghost"]
  });
  const { catalog } = await comboState(cookie);
  const selected = [
    ...modelsFor(catalog, "combo-a", [FAKE_MODELS[0], FAKE_MODELS[1]]),
    ...modelsFor(catalog, "combo-b", [FAKE_MODELS[2], "fake-model-ghost"])
  ];
  await selectModels(cookie, selected);
  const check = await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.body.models.filter(entry => entry.status === "working").length, 2);

  const mid = await comboState(cookie);
  assert.equal(mid.config.availability.filter(entry => entry.status === "working").length, 2);
  fake.state.set({ chatResponder: responder() });
  fake.state.chatRequests.length = 0;
  const run = await runCombo(cookie);
  assert.equal(run.status, 200, run.raw);
  const pool = eventOfType(run.events, "pool").at(-1);
  assert.equal(pool.active.length, 2);
  assert.deepEqual(pool.active.map(entry => entry.model).sort(), [FAKE_MODELS[0], FAKE_MODELS[1]].sort());
  assert.equal(pool.excluded.length, 2);
  assert.ok(pool.excluded.every(entry => entry.status === "not_working"));

  const requestedModels = fake.state.chatRequests.map(request => request.body.model);
  assert.ok(requestedModels.length >= 2);
  assert.ok(!requestedModels.includes(FAKE_MODELS[2]));
  assert.ok(!requestedModels.includes("fake-model-ghost"));

  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.activeCount, 2);
  assert.equal(done.excludedCount, 2);
  assert.equal(done.singleModel, false);
  assert.equal(done.review.used, true);
  assert.equal(done.review.conflicts.length, 1);
  assert.equal(done.synthesis.used, true);
  assert.equal(deltaText(run.events), "SYNTHESIS-FINAL");
  assert.doesNotMatch(run.raw, /Invalid API key|sk-wrong|401|provider failure/i);

  const restored = await comboState(cookie);
  assert.equal(restored.config.selected.length, 4);
  assert.deepEqual(restored.config.selected.map(entry => entry.key), selected.map(entry => entry.key));
});

test("zero working models returns an honest error and no answer", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, {
    id: "combo-b",
    name: "Combo B",
    key: "sk-wrong-key",
    models: [FAKE_MODELS[2], "fake-model-ghost"]
  });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-b", [FAKE_MODELS[2]]);
  await selectModels(cookie, selected);

  const run = await runCombo(cookie);
  assert.equal(run.status, 200, run.raw);
  const errors = eventOfType(run.events, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "no_working_models");
  assert.match(errors[0].message, /None of your selected models/);
  assert.equal(eventOfType(run.events, "delta").length, 0);
  assert.equal(doneEvent(run.events), null);
  assert.doesNotMatch(run.raw, /Invalid API key|401/i);

  const restored = await comboState(cookie);
  assert.equal(restored.config.selected.length, 1);
});

test("single-model fallback is configurable and transparent", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, { id: "combo-a", name: "Combo A", models: [FAKE_MODELS[0]] });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-a", [FAKE_MODELS[0]]);

  await selectModels(cookie, selected, { allowSingleFallback: false });
  const blocked = await runCombo(cookie);
  const blockedErrors = eventOfType(blocked.events, "error");
  assert.equal(blockedErrors.length, 1);
  assert.equal(blockedErrors[0].code, "single_model_fallback_disabled");
  assert.equal(eventOfType(blocked.events, "delta").length, 0);

  await selectModels(cookie, selected, { allowSingleFallback: true });
  fake.state.set({ chatResponder: responder() });
  const allowed = await runCombo(cookie);
  const done = doneEvent(allowed.events);
  assert.ok(done, allowed.raw);
  assert.equal(done.singleModel, true);
  assert.equal(done.activeCount, 1);
  assert.equal(deltaText(allowed.events), `DRAFT:${FAKE_MODELS[0]}`);
});

test("a model that fails after the health check does not cancel successful drafts", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, {
    id: "combo-a",
    name: "Combo A",
    models: [FAKE_MODELS[0], FAKE_MODELS[1], FAKE_MODELS[2]]
  });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-a", FAKE_MODELS);
  await selectModels(cookie, selected, { review: false });
  const check = await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });
  assert.equal(check.body.models.filter(entry => entry.status === "working").length, 3);

  fake.state.set({ chatResponder: responder(), failModel: FAKE_MODELS[1], failModelStatus: 503 });
  fake.state.chatRequests.length = 0;
  const run = await runCombo(cookie);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  const failed = done.results.filter(entry => entry.status === "failed");
  const succeeded = done.results.filter(entry => entry.status === "succeeded");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].model, FAKE_MODELS[1]);
  assert.equal(succeeded.length, 2);
  assert.equal(deltaText(run.events), `DRAFT:${FAKE_MODELS[0]}`);
  assert.doesNotMatch(run.raw, /temporarily unavailable|503|failed to/i);
});

test("sequential collaboration passes the previous draft to the next model", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, {
    id: "combo-a",
    name: "Combo A",
    models: [FAKE_MODELS[0], FAKE_MODELS[1], FAKE_MODELS[2]]
  });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-a", FAKE_MODELS);
  await selectModels(cookie, selected, { strategy: "sequential", review: false });
  await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });

  fake.state.set({ chatResponder: responder() });
  fake.state.chatRequests.length = 0;
  const run = await runCombo(cookie);
  assert.deepEqual(fake.state.chatRequests.map(request => request.body.model), FAKE_MODELS);
  const second = fake.state.chatRequests[1].body.messages;
  assert.ok(second.some(message => message.role === "assistant" && message.content === `DRAFT:${FAKE_MODELS[0]}`));
  assert.equal(deltaText(run.events), `DRAFT:${FAKE_MODELS[2]}`);
  assert.equal(doneEvent(run.events).strategy, "sequential");
});

test("maxWorkingModels defers extra working models without calling them Not Working", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, {
    id: "combo-a",
    name: "Combo A",
    models: [FAKE_MODELS[0], FAKE_MODELS[1], FAKE_MODELS[2]]
  });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-a", FAKE_MODELS);
  await selectModels(cookie, selected, { maxWorkingModels: 2, review: false });
  await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });

  fake.state.set({ chatResponder: responder() });
  fake.state.chatRequests.length = 0;
  const run = await runCombo(cookie);
  const done = doneEvent(run.events);
  assert.equal(done.activeCount, 2);
  assert.equal(done.deferredCount, 1);
  assert.equal(done.excluded.length, 0);
  assert.deepEqual(
    fake.state.chatRequests.map(request => request.body.model).sort(),
    [FAKE_MODELS[0], FAKE_MODELS[1]].sort()
  );
  assert.equal(deltaText(run.events), `DRAFT:${FAKE_MODELS[0]}`);
});

test("cached availability prevents duplicate health-check requests", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, { id: "combo-a", name: "Combo A", models: [FAKE_MODELS[0], FAKE_MODELS[1]] });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-a", [FAKE_MODELS[0], FAKE_MODELS[1]]);
  await selectModels(cookie, selected);
  await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });

  fake.state.set({ chatResponder: responder() });
  fake.state.chatRequests.length = 0;
  await runCombo(cookie);
  const probeRequests = fake.state.chatRequests.filter(request =>
    request.body.messages?.some(message => message.content === "Reply with the single word OK.")
  );
  assert.equal(probeRequests.length, 0);
});

test("client cancellation aborts an in-flight run without emitting done", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, { id: "combo-a", name: "Combo A", models: [FAKE_MODELS[0], FAKE_MODELS[1]] });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-a", [FAKE_MODELS[0], FAKE_MODELS[1]]);
  await selectModels(cookie, selected);
  await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });

  fake.state.set({ chatResponder: responder(), chatDelayMs: 1500 });
  const controller = new AbortController();
  let seen = "";
  let sawDone = false;
  try {
    const response = await fetch(`${baseURL}/api/combo/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ messages: [{ role: "user", content: "Write a long essay." }] }),
      signal: controller.signal
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      if (seen.includes('"phase":"drafting"')) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    assert.equal(error.name, "AbortError");
  }
  sawDone = seen.includes('"type":"done"');
  assert.equal(sawDone, false);
  assert.ok(seen.includes('"type":"meta"'));

  fake.state.set({ chatDelayMs: 0 });
  await new Promise(resolve => setTimeout(resolve, 100));
  const afterCancel = await runCombo(cookie);
  assert.ok(doneEvent(afterCancel.events), afterCancel.raw);
});

test("availability checks can be cancelled without corrupting the saved statuses", async () => {
  fake.state.reset();
  const { cookie, email } = await signupUser();
  await saveProvider(cookie, { id: "combo-a", name: "Combo A", models: [FAKE_MODELS[0], FAKE_MODELS[1]] });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, "combo-a", [FAKE_MODELS[0], FAKE_MODELS[1]]);
  await selectModels(cookie, selected);
  fake.state.set({ chatDelayMs: 400 });

  const user = await User.findOne({ email }).lean();
  const config = await ComboConfig.findOne({ userId: user._id });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);
  const result = await runAvailabilityChecks({
    userId: user._id,
    config,
    force: true,
    signal: controller.signal
  });
  assert.equal(result.models.length, 2);
  assert.ok(result.models.every(entry => entry.status === "unknown"));

  fake.state.set({ chatDelayMs: 0 });
  const health = await api("/api/combo", { cookie });
  assert.equal(health.status, 200);
});

// A Combo turn is now sent from the chat composer, so it has to land in the same
// reloadable history as a single-model answer. These run against the real route,
// a real database and the fake provider - no mocked persistence layer.
async function workingComboUser() {
  fake.state.reset();
  const user = await signupUser();
  await saveProvider(user.cookie, { id: "combo-p", name: "Combo P", models: FAKE_MODELS.slice(0, 2) });
  const { catalog } = await comboState(user.cookie);
  await selectModels(user.cookie, modelsFor(catalog, "combo-p", FAKE_MODELS.slice(0, 2)));
  const check = await api("/api/combo/availability", { method: "POST", cookie: user.cookie, body: { force: true } });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.body.models.filter(entry => entry.status === "working").length, 2);
  fake.state.set({ chatResponder: responder() });
  return user;
}

test("a Combo answer is written to the conversation the chat reloads", async () => {
  const { cookie } = await workingComboUser();
  const assistantMessageId = String(new mongoose.Types.ObjectId());

  const run = await runCombo(cookie, [{ role: "user", content: "Explain recursion briefly." }], {
    assistantMessageId
  });
  assert.equal(run.status, 200, run.raw);
  const meta = eventOfType(run.events, "meta")[0];
  assert.ok(meta, run.raw);
  assert.ok(mongoose.isValidObjectId(meta.conversationId), "the chat needs an id before the first delta");
  assert.equal(meta.messageId, assistantMessageId);
  assert.equal(eventOfType(run.events, "delta").length > 0, true);
  assert.equal(eventOfType(run.events, "error").length, 0);
  const done = doneEvent(run.events);
  assert.equal(done.conversationId, meta.conversationId, "one conversation id for the whole turn");
  assert.equal(eventOfType(run.events, "meta").length, 1);
  assert.equal(eventOfType(run.events, "done").length, 1);

  const history = await api(`/api/conversations/${meta.conversationId}`, { cookie });
  assert.equal(history.status, 200, history.text);
  assert.deepEqual(
    history.body.conversation.messages.map(message => [message.role, message.content]),
    [
      ["user", "Explain recursion briefly."],
      ["assistant", "SYNTHESIS-FINAL"]
    ]
  );
  assert.equal(history.body.conversation.messages[1].messageId, assistantMessageId);
  assert.equal(history.body.conversation.title, "Explain recursion briefly.");
});

test("a follow-up Combo turn appends to the same conversation", async () => {
  const { cookie } = await workingComboUser();
  const first = await runCombo(cookie, [{ role: "user", content: "First question." }]);
  const conversationId = eventOfType(first.events, "meta")[0].conversationId;
  assert.ok(doneEvent(first.events), first.raw);

  const second = await runCombo(
    cookie,
    [
      { role: "user", content: "First question." },
      { role: "assistant", content: "SYNTHESIS-FINAL" },
      { role: "user", content: "Second question." }
    ],
    { conversationId }
  );
  assert.ok(doneEvent(second.events), second.raw);
  assert.equal(eventOfType(second.events, "meta")[0].conversationId, conversationId, "a known chat keeps its id");

  const history = await api(`/api/conversations/${conversationId}`, { cookie });
  assert.deepEqual(
    history.body.conversation.messages.map(message => message.role),
    ["user", "assistant", "user", "assistant"]
  );
  assert.equal(history.body.conversation.messages[0].content, "First question.");
  assert.equal(history.body.conversation.messages[2].content, "Second question.");

  const list = await api("/api/conversations", { cookie });
  assert.equal(list.body.conversations.length, 1, "the follow-up did not open a second chat");
});

test("another user's conversation id starts a fresh conversation instead of writing into it", async () => {
  const owner = await workingComboUser();
  const ownerRun = await runCombo(owner.cookie, [{ role: "user", content: "Owner question." }]);
  const conversationId = eventOfType(ownerRun.events, "meta")[0].conversationId;
  assert.ok(doneEvent(ownerRun.events), ownerRun.raw);

  const stranger = await workingComboUser();
  const stolen = await runCombo(stranger.cookie, [{ role: "user", content: "Stranger question." }], {
    conversationId
  });
  const strangerMeta = eventOfType(stolen.events, "meta")[0];
  assert.ok(strangerMeta, stolen.raw);
  assert.notEqual(strangerMeta.conversationId, conversationId, "a foreign id cannot select someone else's chat");

  const denied = await api(`/api/conversations/${conversationId}`, { cookie: stranger.cookie });
  assert.equal(denied.status, 404, denied.text);

  const untouched = await api(`/api/conversations/${conversationId}`, { cookie: owner.cookie });
  assert.equal(untouched.status, 200, untouched.text);
  assert.deepEqual(
    untouched.body.conversation.messages.map(message => message.content),
    ["Owner question.", "SYNTHESIS-FINAL"]
  );

  const own = await api(`/api/conversations/${strangerMeta.conversationId}`, { cookie: stranger.cookie });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.conversation.messages[0].content, "Stranger question.");
});

test("a run that produced no answer stores no conversation", async () => {
  fake.state.reset();
  const { cookie } = await signupUser();
  await saveProvider(cookie, { id: "combo-dead", name: "Combo Dead", key: "sk-wrong-key", models: [FAKE_MODELS[0]] });
  const { catalog } = await comboState(cookie);
  await selectModels(cookie, modelsFor(catalog, "combo-dead", [FAKE_MODELS[0]]));

  const conversationId = String(new mongoose.Types.ObjectId());
  const run = await runCombo(cookie, [{ role: "user", content: "Anything." }], { conversationId });
  assert.equal(eventOfType(run.events, "error").length, 1, run.raw);
  assert.equal(doneEvent(run.events), null);

  const list = await api("/api/conversations", { cookie });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.conversations, [], "a failed run must not leave an empty chat behind");
  const missing = await api(`/api/conversations/${conversationId}`, { cookie });
  assert.equal(missing.status, 404, missing.text);
});
