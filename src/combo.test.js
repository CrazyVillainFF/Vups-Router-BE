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
const { COMBO_EXECUTION } = await import("./comboOrchestrator.js");
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
    body: { name: "Combo Tester", email, password: "correct-horse-battery", acceptTerms: true }
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

function errorEvent(events) {
  return eventOfType(events, "error").at(-1) || null;
}

function deltaText(events) {
  return eventOfType(events, "delta").map(event => event.content).join("");
}

const EXTRA_MODEL = "fake-model-extra";
const PERSISTED_ANSWER = `ANSWER:${FAKE_MODELS[0]}`;

function answerResponder() {
  return (body, model) => `ANSWER:${model}`;
}

function extraModel() {
  return { id: EXTRA_MODEL, name: EXTRA_MODEL, owned_by: "fake", pricing: { prompt: "0", completion: "0", request: "0" } };
}

// A signed-in account with a saved provider and a Combo selection in the given
// priority order. No availability check is run: a chat turn must work from a cold
// cache without spending probe requests.
async function comboUser({
  id = "combo-a",
  name = "Combo A",
  models = FAKE_MODELS,
  key = FAKE_API_KEY,
  settings,
  extraModels = []
} = {}) {
  fake.state.reset();
  fake.state.set({ chatResponder: answerResponder(), ...(extraModels.length > 0 ? { extraModels } : {}) });
  const { cookie, email } = await signupUser();
  await saveProvider(cookie, { id, name, key, models });
  const { catalog } = await comboState(cookie);
  const selected = modelsFor(catalog, id, models);
  const config = await selectModels(cookie, selected, settings);
  return { cookie, email, selected, config };
}

function requestedModels() {
  return fake.state.chatRequests.map(request => request.body.model);
}

// Called immediately before a run so the request log measures that run only.
function clearRequestLog() {
  assert.equal(fake.state.chatInFlight, 0, "a previous provider request is still open");
  fake.state.chatRequests.length = 0;
  fake.state.chatOverlaps.length = 0;
  fake.state.chatMaxInFlight = 0;
  fake.state.modelsRequests = 0;
}

// The hard invariant: ONE TASK = ONE ACTIVE MODEL REQUEST AT A TIME. The fake
// provider records every pair of requests that were open together, so a fan-out
// regression fails here even when the final answer still looks correct.
function assertOneAtATime() {
  assert.deepEqual(fake.state.chatOverlaps, [], "two model requests for the same task overlapped");
  assert.equal(fake.state.chatMaxInFlight, 1, "more than one model request was in flight for the task");
}

function assertNoProviderLeak(raw) {
  assert.doesNotMatch(
    raw,
    /Invalid API key provided|Simulated provider failure|Insufficient credits\.|Upstream exploded|sk-fake|sk-wrong|The model `[^`]+` does not exist/i
  );
}

function delayEveryModel(ms, models = [...FAKE_MODELS, EXTRA_MODEL]) {
  fake.state.set({ modelDelayMs: Object.fromEntries(models.map(model => [model, ms])) });
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "the expected state never arrived");
}

test("combo settings normalize to safe defaults and clamp input", () => {
  const settings = normalizeComboSettings({
    timeoutMs: 1,
    retries: 99,
    maxConcurrent: 0,
    maxWorkingModels: 2,
    healthTtlMs: 5,
    probeTimeoutMs: 1,
    autoAvailability: false
  });
  assert.equal(settings.timeoutMs, 5000);
  assert.equal(settings.retries, 2);
  assert.equal(settings.maxConcurrent, 1);
  assert.equal(settings.healthTtlMs, 15000);
  assert.equal(settings.probeTimeoutMs, 5000);
  assert.equal(settings.maxWorkingModels, 2);
  assert.equal(settings.autoAvailability, false);

  // Parallel collaboration is gone, so its knobs must not survive as dead
  // settings the interface could still offer.
  const defaults = normalizeComboSettings({});
  for (const removed of ["strategy", "review", "synthesizer", "minWorkingModels", "allowSingleFallback"]) {
    assert.equal(removed in defaults, false, `${removed} is no longer a Combo setting`);
    assert.equal(removed in normalizeComboSettings({ [removed]: "anything" }), false);
  }
  assert.equal(defaults.retries, 0, "a run attempts each model once unless the user asks for retries");
  assert.equal(defaults.maxWorkingModels, 4);

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
    maxWorkingModels: 2,
    timeoutMs: 999999,
    retries: 9
  });
  assert.equal(saved.selected.length, 2);
  assert.equal(saved.selected[0].key, first.key);
  assert.equal(saved.selected[1].key, second.key);
  assert.equal(saved.settings.maxWorkingModels, 2);
  assert.equal(saved.settings.timeoutMs, 300000);
  assert.equal(saved.settings.retries, 2);

  const restored = await comboState(cookie);
  assert.deepEqual(restored.config.selected.map(entry => entry.key), [first.key, second.key]);
  assert.equal(restored.config.settings.maxWorkingModels, 2);
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

  const check = await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });
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
  const recovered = await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });
  assert.equal(recovered.status, 200, recovered.text);
  const recoveredStatuses = Object.fromEntries(recovered.body.models.map(entry => [entry.key, entry.status]));
  assert.equal(recoveredStatuses[selected[2].key], "working");
  assert.equal(recoveredStatuses[selected[3].key], "not_working");
  assert.equal(recoveredStatuses[selected[0].key], "working");

  const restored = await comboState(cookie);
  assert.equal(restored.config.selected.length, 4);
});

// Proof 1 + 2: a healthy first model is the only model that is ever called.
test("a successful first model ends the run and no other model is requested", async () => {
  const { cookie } = await comboUser();
  delayEveryModel(250);
  clearRequestLog();

  const run = await runCombo(cookie);
  assert.equal(run.status, 200, run.raw);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0]], "the second and third models must not be called at all");

  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.execution, COMBO_EXECUTION);
  assert.equal(done.attemptedCount, 1);
  assert.equal(done.attemptLimit, 3);
  assert.equal(done.selectedCount, 3);
  assert.equal(done.switches.length, 0);
  assert.equal(done.singleModel, true);
  assert.equal(done.finalModel.model, FAKE_MODELS[0]);
  assert.deepEqual(done.attempts.map(entry => [entry.attempt, entry.status]), [[1, "succeeded"]]);
  assert.equal(deltaText(run.events), `ANSWER:${FAKE_MODELS[0]}`);
  assert.equal(errorEvent(run.events), null);
  assertNoProviderLeak(run.raw);
});

// Proof 1, stated as its own regression: this test fails the moment two model
// requests for one task are open at the same time, whether or not the run answers.
test("two model requests for the same task never overlap, even across failovers", async () => {
  const { cookie } = await comboUser();
  delayEveryModel(200);
  fake.state.set({
    modelFailures: {
      [FAKE_MODELS[0]]: { status: 429, message: "Rate limit reached for this model." },
      [FAKE_MODELS[1]]: { status: 503, message: "The service is temporarily overloaded." }
    }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assert.equal(run.status, 200, run.raw);
  assert.deepEqual(requestedModels(), FAKE_MODELS, "each candidate is asked once, in the configured order");
  assertOneAtATime();

  // The event stream is the interface's only source of truth, so it must show the
  // same serialization: at most one model open at any point, none left open.
  let open = 0;
  let peak = 0;
  for (const event of run.events) {
    if (event.type !== "model") continue;
    if (event.status === "started") {
      open += 1;
      peak = Math.max(peak, open);
    } else if (event.status === "finished" || event.status === "failed") {
      open -= 1;
    }
    assert.ok(open >= 0, "a model finished before it started");
  }
  assert.equal(peak, 1, "the interface showed two models running at once");
  assert.equal(open, 0, "a model was left running after the run ended");
  assert.ok(doneEvent(run.events), run.raw);
});

// Proof 3: HTTP 429 moves to the next configured model.
test("a rate limit switches to the next model and says why", async () => {
  const { cookie } = await comboUser();
  fake.state.set({
    modelFailures: {
      [FAKE_MODELS[0]]: { status: 429, retryAfter: 30, message: "Rate limit reached for requests." }
    }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0], FAKE_MODELS[1]]);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.attemptedCount, 2);
  assert.equal(done.finalModel.model, FAKE_MODELS[1]);
  assert.equal(done.switches.length, 1);
  assert.equal(done.switches[0].category, "rate_limit_requests");
  assert.equal(done.switches[0].from.model, FAKE_MODELS[0]);
  assert.equal(done.switches[0].to.model, FAKE_MODELS[1]);
  assert.equal(done.switches[0].to.status, "waiting");

  const failed = eventOfType(run.events, "model").find(event => event.status === "failed");
  assert.equal(failed.willSwitch, true);
  assert.equal(failed.category, "rate_limit_requests");
  assert.match(failed.reason, /rate limit/i);
  const switching = eventOfType(run.events, "stage").filter(event => event.phase === "switching");
  assert.equal(switching.length, 1);
  assert.match(switching[0].message, /Switching to/);
  assert.equal(deltaText(run.events), `ANSWER:${FAKE_MODELS[1]}`);
  assertNoProviderLeak(run.raw);
});

// Proof 4: quota and credit exhaustion fail over even though the provider client
// calls them permanent for same-model retry purposes.
test("quota exhaustion and insufficient credits both switch models", async () => {
  const { cookie } = await comboUser();
  fake.state.set({
    modelFailures: {
      [FAKE_MODELS[0]]: { status: 402, message: "Insufficient credits." },
      [FAKE_MODELS[1]]: {
        status: 429,
        payload: { error: { message: "Request denied.", code: "insufficient_quota", type: "insufficient_quota" } }
      }
    }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), FAKE_MODELS);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.attemptedCount, 3);
  assert.deepEqual(done.switches.map(entry => entry.category), ["quota_exhausted", "quota_exhausted"]);
  assert.deepEqual(done.attempts.map(entry => entry.category), ["quota_exhausted", "quota_exhausted", undefined]);
  assert.equal(done.finalModel.model, FAKE_MODELS[2]);
  assert.match(done.switches[0].reason, /quota or credits/i);
  assert.equal(deltaText(run.events), `ANSWER:${FAKE_MODELS[2]}`);
  assertNoProviderLeak(run.raw);
});

// Proof 5: temporary capacity and service-unavailability failures fail over.
test("temporary overload and upstream unavailability switch models", async () => {
  const { cookie } = await comboUser();
  fake.state.set({
    modelFailures: {
      [FAKE_MODELS[0]]: { status: 503, message: "The service is temporarily overloaded." },
      [FAKE_MODELS[1]]: { status: 500, message: "Internal server error." }
    }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.deepEqual(done.switches.map(entry => entry.category), ["overloaded", "upstream_unavailable"]);
  assert.equal(done.finalModel.model, FAKE_MODELS[2]);
  assert.equal(done.attemptedCount, 3);
  assertNoProviderLeak(run.raw);
});

// Proof 6: several consecutive failures still reach a working model.
test("three consecutive failures reach the fourth configured model", async () => {
  const models = [...FAKE_MODELS, EXTRA_MODEL];
  const { cookie } = await comboUser({ models, extraModels: [extraModel()] });
  fake.state.set({
    modelFailures: {
      [FAKE_MODELS[0]]: { status: 429, message: "Rate limit reached for requests." },
      [FAKE_MODELS[1]]: { status: 402, message: "Insufficient credits." },
      [FAKE_MODELS[2]]: { status: 503, message: "Temporarily at capacity." }
    }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), models);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.attemptedCount, 4);
  assert.deepEqual(done.attempts.map(entry => entry.attempt), [1, 2, 3, 4]);
  assert.deepEqual(done.attempts.map(entry => entry.status), ["failed", "failed", "failed", "succeeded"]);
  assert.equal(done.finalModel.model, EXTRA_MODEL);
  assert.equal(done.switches.length, 3);
  assert.equal(deltaText(run.events), `ANSWER:${EXTRA_MODEL}`);
  assert.equal(eventOfType(run.events, "model").filter(entry => entry.status === "finished").length, 1);
});

// Proof 7: every candidate failing produces one clear final error, not an answer.
test("all models failing produces a clear final error and keeps the selection", async () => {
  const { cookie, selected } = await comboUser();
  fake.state.set({
    modelFailures: Object.fromEntries(FAKE_MODELS.map(model => [model, { status: 429, message: "Rate limit reached." }]))
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), FAKE_MODELS);
  const error = errorEvent(run.events);
  assert.ok(error, run.raw);
  assert.equal(error.code, "all_models_failed");
  assert.match(error.message, /None of your 3 tried models/);
  assert.equal(eventOfType(run.events, "error").length, 1);
  assert.equal(eventOfType(run.events, "delta").length, 0);
  assert.equal(doneEvent(run.events), null);
  assert.equal(eventOfType(run.events, "model").filter(entry => entry.status === "finished").length, 0);
  assertNoProviderLeak(run.raw);

  const restored = await comboState(cookie);
  assert.deepEqual(restored.config.selected.map(entry => entry.key), selected.map(entry => entry.key));
});

// Proof 8: an authentication failure is not a reason to burn the other models.
test("an invalid API key stops the run instead of trying every other model", async () => {
  const { cookie } = await comboUser({ key: "sk-wrong-key" });
  clearRequestLog();

  const run = await runCombo(cookie);
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0]], "a rejected key must not be retried on other models");
  assert.equal(fake.state.chatMaxInFlight, 1);
  const error = errorEvent(run.events);
  assert.ok(error, run.raw);
  assert.equal(error.code, "non_retryable_failure");
  assert.match(error.message, /API key/i);
  assert.match(error.message, /stopped instead of trying another model/i);
  assert.equal(doneEvent(run.events), null);
  assert.equal(eventOfType(run.events, "delta").length, 0);
  assert.equal(eventOfType(run.events, "stage").filter(entry => entry.phase === "switching").length, 0);
  const doneAttempts = eventOfType(run.events, "model").filter(entry => entry.status === "failed");
  assert.equal(doneAttempts.length, 1);
  assert.equal(doneAttempts[0].willSwitch, false);
  assert.equal(doneAttempts[0].category, null);
  assertNoProviderLeak(run.raw);
});

test("authorization, unknown model and context overflow are terminal, not failover", async () => {
  const cases = [
    { status: 403, message: "Access denied for this key.", reason: /denied access/i },
    { status: 404, message: "The model does not exist.", reason: /not offered by that provider/i },
    {
      status: 400,
      payload: { error: { message: "This model's maximum context length is 8192 tokens.", code: "context_length_exceeded" } },
      reason: /context window/i
    }
  ];
  for (const scenario of cases) {
    const { cookie } = await comboUser();
    fake.state.set({ modelFailures: { [FAKE_MODELS[0]]: scenario } });
    clearRequestLog();

    const run = await runCombo(cookie);
    assert.deepEqual(requestedModels(), [FAKE_MODELS[0]], `${scenario.status} must not fan out`);
    const error = errorEvent(run.events);
    assert.ok(error, run.raw);
    assert.equal(error.code, "non_retryable_failure", run.raw);
    assert.match(error.message, scenario.reason);
    assert.equal(doneEvent(run.events), null);
    assert.equal(eventOfType(run.events, "stage").filter(entry => entry.phase === "switching").length, 0);
    assertNoProviderLeak(run.raw);
  }
});

// Proof 9: a malformed request is the caller's problem, not a model's.
test("an invalid request payload stops the run without failover", async () => {
  const { cookie } = await comboUser();
  fake.state.set({
    modelFailures: {
      [FAKE_MODELS[0]]: { status: 400, message: "Invalid value for temperature: expected a number." }
    }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0]]);
  const error = errorEvent(run.events);
  assert.ok(error, run.raw);
  assert.equal(error.code, "non_retryable_failure");
  assert.match(error.message, /request payload/i);
  assert.equal(doneEvent(run.events), null);
  assertNoProviderLeak(run.raw);
});

// Proof 10: every attempt receives the identical conversation, so a switch never
// loses the original message, the history or the system context.
test("every attempt sends the identical conversation and the run keeps one id", async () => {
  const { cookie } = await comboUser();
  const history = [
    { role: "user", content: "My project uses a binary tree." },
    { role: "assistant", content: "Understood - a binary tree." },
    { role: "user", content: "Now explain recursion briefly." }
  ];
  fake.state.set({
    modelFailures: {
      [FAKE_MODELS[0]]: { status: 429, message: "Rate limit reached for requests." },
      [FAKE_MODELS[1]]: { status: 503, message: "Temporarily overloaded." }
    }
  });
  clearRequestLog();

  const run = await runCombo(cookie, history);
  assertOneAtATime();
  assert.equal(fake.state.chatRequests.length, 3);
  for (const request of fake.state.chatRequests) {
    assert.deepEqual(request.body.messages, history, "a switched model must receive the same task and history");
    assert.equal(request.body.stream, false);
  }
  const meta = eventOfType(run.events, "meta")[0];
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(meta.execution, COMBO_EXECUTION);
  assert.equal(done.conversationId, meta.conversationId);
  assert.equal(done.runId, eventOfType(run.events, "run")[0].runId);
  assert.equal(done.finalModel.model, FAKE_MODELS[2]);
  assert.equal(deltaText(run.events), `ANSWER:${FAKE_MODELS[2]}`);

  const stored = await api(`/api/conversations/${meta.conversationId}`, { cookie });
  assert.equal(stored.status, 200, stored.text);
  assert.deepEqual(
    stored.body.conversation.messages.map(message => [message.role, message.content]),
    [...history.map(message => [message.role, message.content]), ["assistant", `ANSWER:${FAKE_MODELS[2]}`]]
  );
});

// Proof 11: cancellation stops the run before the next candidate is contacted.
test("cancelling a run stops it before the next model is attempted", async () => {
  const { cookie } = await comboUser();
  fake.state.set({
    modelDelayMs: { [FAKE_MODELS[0]]: 1200 },
    modelFailures: { [FAKE_MODELS[0]]: { status: 429, message: "Rate limit reached." } }
  });
  clearRequestLog();

  const controller = new AbortController();
  let seen = "";
  const response = await fetch(`${baseURL}/api/combo/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "Write a long essay." }] }),
    signal: controller.signal
  });
  const reading = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
  })().catch(error => assert.equal(error.name, "AbortError"));

  // Cancel while the first model is genuinely in flight, not before it is asked:
  // the next candidate must never be contacted after the user stops the run.
  await waitFor(() => fake.state.chatInFlight === 1 && seen.includes('"status":"started"'));
  controller.abort();
  await reading;

  assert.equal(seen.includes('"type":"done"'), false, "a cancelled run must not report success");
  assert.ok(seen.includes('"type":"meta"'));

  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0]], "cancellation must not start the next model");
  assert.equal(fake.state.chatInFlight, 0, "the cancelled provider request was left open");
  assert.deepEqual(fake.state.chatOverlaps, []);

  const list = await api("/api/conversations", { cookie });
  assert.deepEqual(list.body.conversations, [], "a cancelled run stores no answer");

  fake.state.set({ modelDelayMs: {}, modelFailures: {} });
  const afterCancel = await runCombo(cookie);
  assert.ok(doneEvent(afterCancel.events), afterCancel.raw);
  assert.equal(deltaText(afterCancel.events), `ANSWER:${FAKE_MODELS[0]}`);
});

// Proof 12: a turn costs exactly the requests it reports - no probes, no drafts,
// no review, no synthesis, and no second execution of the same task.
test("a successful turn spends exactly one request and no hidden model work", async () => {
  const { cookie } = await comboUser();
  clearRequestLog();

  const run = await runCombo(cookie);
  assert.ok(doneEvent(run.events), run.raw);
  assert.equal(fake.state.chatRequests.length, 1, "one answer must cost one provider request");
  assert.equal(fake.state.modelsRequests, 0, "a chat turn must not discover or probe models");
  for (const request of fake.state.chatRequests) {
    assert.equal(
      request.body.messages.some(message => message.content === "Reply with the single word OK."),
      false,
      "the availability probe must never run inside a chat turn"
    );
  }
  assert.doesNotMatch(run.raw, /"phase":"(checking|drafting|reviewing|synthesizing)"/);
  assert.doesNotMatch(run.raw, /You compare independent answers|synthesis stage of Vups Combo AI/i);
  const done = doneEvent(run.events);
  assert.equal("review" in done, false);
  assert.equal("synthesis" in done, false);
  assert.equal("results" in done, false);
  assert.equal(done.finalChars, deltaText(run.events).length);

  // A failing cycle still asks each configured model exactly once.
  fake.state.set({
    modelFailures: Object.fromEntries(FAKE_MODELS.map(model => [model, { status: 429, message: "Rate limit reached." }]))
  });
  clearRequestLog();
  const failed = await runCombo(cookie);
  assert.equal(errorEvent(failed.events).code, "all_models_failed");
  assert.deepEqual(requestedModels(), FAKE_MODELS);
  assert.equal(fake.state.chatRequests.length, 3);
  assertOneAtATime();
});

// Proof 13: the interface can distinguish waiting, running, switching, success
// and exhaustion, and never claims an answer that was not received.
test("the event stream reports waiting, running, switching and the real winner", async () => {
  const { cookie } = await comboUser();
  fake.state.set({
    modelFailures: { [FAKE_MODELS[0]]: { status: 429, message: "Rate limit reached for requests." } }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  const pool = eventOfType(run.events, "pool")[0];
  assert.equal(pool.active.length, 3);
  assert.equal(pool.attemptLimit, 3);
  assert.ok(pool.active.every(entry => entry.status === "waiting"), "no model may be shown as drafting before it is asked");
  assert.deepEqual(pool.active.map(entry => entry.model), FAKE_MODELS);
  assert.equal("excluded" in pool, false);

  const started = eventOfType(run.events, "model").filter(entry => entry.status === "started");
  assert.deepEqual(started.map(entry => entry.attempt), [1, 2]);
  assert.deepEqual(started.map(entry => entry.model), [FAKE_MODELS[0], FAKE_MODELS[1]]);
  assert.ok(started.every(entry => entry.total === 3));

  const finished = eventOfType(run.events, "model").filter(entry => entry.status === "finished");
  assert.equal(finished.length, 1, "exactly one model may be reported as answering");
  assert.equal(finished[0].model, FAKE_MODELS[1]);
  assert.equal(finished[0].attempt, 2);
  assert.ok(finished[0].chars > 0);

  const stages = eventOfType(run.events, "stage").map(entry => entry.phase);
  assert.deepEqual(stages, ["starting", "switching", "finalizing"]);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.finalModel.model, finished[0].model);
  assert.equal(done.attemptedCount, 2);
  assert.equal(done.singleModel, false);
  assert.equal("strategy" in done, false);
  assert.equal(deltaText(run.events), `ANSWER:${FAKE_MODELS[1]}`);
});

// Proof 14: two independent tasks may run at once, but they never share a request,
// a prompt or a conversation. The deliberate cross-task overlap here is also the
// positive control for the overlap detector used by every sequential assertion.
test("concurrent independent tasks stay isolated from each other", async () => {
  const alpha = await comboUser({ id: "combo-alpha", name: "Combo Alpha" });
  const beta = await comboUser({ id: "combo-beta", name: "Combo Beta", models: [FAKE_MODELS[1], FAKE_MODELS[0]] });
  delayEveryModel(400);
  clearRequestLog();

  const [first, second] = await Promise.all([
    runCombo(alpha.cookie, [{ role: "user", content: "Alpha task question." }]),
    runCombo(beta.cookie, [{ role: "user", content: "Beta task question." }])
  ]);
  assert.ok(doneEvent(first.events), first.raw);
  assert.ok(doneEvent(second.events), second.raw);
  assert.equal(fake.state.chatMaxInFlight, 2, "the detector must see two independent tasks running together");
  assert.equal(fake.state.chatRequests.length, 2, "each task still costs exactly one request");
  assert.deepEqual(
    fake.state.chatRequests.map(request => request.body.messages.at(-1).content).sort(),
    ["Alpha task question.", "Beta task question."]
  );
  assert.deepEqual(requestedModels().sort(), [FAKE_MODELS[0], FAKE_MODELS[1]].sort());

  const firstId = doneEvent(first.events).conversationId;
  const secondId = doneEvent(second.events).conversationId;
  assert.notEqual(firstId, secondId);
  assert.equal(deltaText(first.events), `ANSWER:${FAKE_MODELS[0]}`);
  assert.equal(deltaText(second.events), `ANSWER:${FAKE_MODELS[1]}`);

  const denied = await api(`/api/conversations/${firstId}`, { cookie: beta.cookie });
  assert.equal(denied.status, 404, denied.text);
  const own = await api(`/api/conversations/${firstId}`, { cookie: alpha.cookie });
  assert.deepEqual(own.body.conversation.messages.map(message => message.content), ["Alpha task question.", `ANSWER:${FAKE_MODELS[0]}`]);
});

test("maxWorkingModels bounds the attempt list and defers the rest honestly", async () => {
  const { cookie } = await comboUser({ settings: { maxWorkingModels: 2 } });
  clearRequestLog();

  const run = await runCombo(cookie);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.attemptLimit, 2);
  assert.equal(done.selectedCount, 3);
  assert.equal(done.deferredCount, 1);
  assert.equal(done.deferred.length, 1);
  assert.equal(done.deferred[0].model, FAKE_MODELS[2]);
  assert.equal(done.deferred[0].status, "waiting", "a deferred model is not a broken model");
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0]]);
  assertOneAtATime();
});

test("a chat turn never probes, even with a cold availability cache", async () => {
  const { cookie } = await comboUser();
  clearRequestLog();

  const run = await runCombo(cookie);
  assert.ok(doneEvent(run.events), run.raw);
  assert.equal(fake.state.chatRequests.length, 1);
  assert.equal(fake.state.modelsRequests, 0);
  assert.equal(fake.state.keyRequests, 0);

  // The explicit diagnostic endpoint is still allowed to check several models;
  // it is a user action, not part of a task.
  const check = await api("/api/combo/availability", { method: "POST", cookie, body: { force: true } });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.body.models.length, 3);
  assert.ok(check.body.models.every(entry => entry.status === "working"));
});

test("the existing retry preference stays bounded and never overlaps models", async () => {
  const { cookie } = await comboUser({ settings: { retries: 2 } });
  fake.state.set({
    modelFailures: { [FAKE_MODELS[0]]: { status: 503, remaining: 2, message: "Temporarily overloaded." } }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0], FAKE_MODELS[0], FAKE_MODELS[0]]);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.attemptedCount, 1, "a same-model retry is not a new failover attempt");
  assert.equal(done.switches.length, 0);
  assert.equal(done.finalModel.model, FAKE_MODELS[0]);
});

test("a model that keeps failing is attempted at most once per retry budget, then left", async () => {
  const { cookie } = await comboUser({ settings: { retries: 2 } });
  fake.state.set({
    modelFailures: { [FAKE_MODELS[0]]: { status: 429, message: "Rate limit reached for requests." } }
  });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0], FAKE_MODELS[0], FAKE_MODELS[0], FAKE_MODELS[1]]);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.attemptedCount, 2);
  assert.equal(done.switches.length, 1);
  assert.equal(done.finalModel.model, FAKE_MODELS[1]);
});

test("an empty answer is never reported as a successful model", async () => {
  const { cookie } = await comboUser();
  fake.state.set({ chatResponder: (body, model) => (model === FAKE_MODELS[0] ? "   " : `ANSWER:${model}`) });
  clearRequestLog();

  const run = await runCombo(cookie);
  assertOneAtATime();
  assert.deepEqual(requestedModels(), [FAKE_MODELS[0], FAKE_MODELS[1]]);
  const done = doneEvent(run.events);
  assert.ok(done, run.raw);
  assert.equal(done.attempts[0].status, "failed");
  assert.equal(done.attempts[0].category, "empty_response");
  assert.equal(done.finalModel.model, FAKE_MODELS[1]);
  assert.equal(deltaText(run.events), `ANSWER:${FAKE_MODELS[1]}`);
});

test("a disabled Combo or an empty selection fails before any provider request", async () => {
  const { cookie } = await comboUser();
  const messages = [{ role: "user", content: "Anything." }];
  await api("/api/combo", { method: "PUT", cookie, body: { enabled: false } });
  clearRequestLog();
  const disabled = await api("/api/combo/chat", { method: "POST", cookie, body: { messages } });
  assert.equal(disabled.status, 403, disabled.text);
  assert.equal(disabled.body.code, "combo_disabled");

  await api("/api/combo", { method: "PUT", cookie, body: { enabled: true, selected: [] } });
  const empty = await api("/api/combo/chat", { method: "POST", cookie, body: { messages } });
  assert.equal(empty.status, 400, empty.text);
  assert.equal(empty.body.code, "no_models_selected");
  assert.equal(fake.state.chatRequests.length, 0);
});

test("availability checks can be cancelled without corrupting the saved statuses", async () => {
  const { cookie, email } = await comboUser({ models: FAKE_MODELS.slice(0, 2) });
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

// A Combo turn is sent from the chat composer, so it has to land in the same
// reloadable history as a single-model answer. These run against the real route,
// a real database and the fake provider - no mocked persistence layer.
async function workingComboUser() {
  return comboUser({ id: "combo-p", name: "Combo P", models: FAKE_MODELS.slice(0, 2) });
}

test("a Combo answer is written to the conversation the chat reloads", async () => {
  const { cookie } = await workingComboUser();
  const assistantMessageId = String(new mongoose.Types.ObjectId());
  clearRequestLog();

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
      ["assistant", PERSISTED_ANSWER]
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
  clearRequestLog();

  const history = [
    { role: "user", content: "First question." },
    { role: "assistant", content: PERSISTED_ANSWER },
    { role: "user", content: "Second question." }
  ];
  const second = await runCombo(cookie, history, { conversationId });
  assert.ok(doneEvent(second.events), second.raw);
  assert.equal(eventOfType(second.events, "meta")[0].conversationId, conversationId, "a known chat keeps its id");
  assert.equal(fake.state.chatRequests.length, 1, "the follow-up is one request, not a replay of the turn");
  assert.deepEqual(fake.state.chatRequests[0].body.messages, history);

  const stored = await api(`/api/conversations/${conversationId}`, { cookie });
  assert.deepEqual(
    stored.body.conversation.messages.map(message => message.role),
    ["user", "assistant", "user", "assistant"]
  );
  assert.equal(stored.body.conversation.messages[0].content, "First question.");
  assert.equal(stored.body.conversation.messages[2].content, "Second question.");

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
    ["Owner question.", PERSISTED_ANSWER]
  );

  const own = await api(`/api/conversations/${strangerMeta.conversationId}`, { cookie: stranger.cookie });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.conversation.messages[0].content, "Stranger question.");
});

test("a run that produced no answer stores no conversation", async () => {
  const { cookie } = await comboUser({ id: "combo-dead", name: "Combo Dead", key: "sk-wrong-key", models: [FAKE_MODELS[0]] });
  const conversationId = String(new mongoose.Types.ObjectId());
  clearRequestLog();

  const run = await runCombo(cookie, [{ role: "user", content: "Anything." }], { conversationId });
  assert.equal(eventOfType(run.events, "error").length, 1, run.raw);
  assert.equal(doneEvent(run.events), null);
  assert.equal(fake.state.chatRequests.length, 1);

  const list = await api("/api/conversations", { cookie });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.conversations, [], "a failed run must not leave an empty chat behind");
  const missing = await api(`/api/conversations/${conversationId}`, { cookie });
  assert.equal(missing.status, 404, missing.text);
});