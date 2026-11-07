import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// Phase 2 — model-busy and provider failures on the persistent task path.
// The contract here is that a temporary provider failure costs a task its
// patience, not its existence: the retry is bounded, its state is on the record,
// the attempts are all kept, a permanent failure is never retried, and nothing
// already done is done a second time.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.SETTINGS_RATE_LIMIT_MAX = "10000";
process.env.AI_DAILY_QUOTA = "1000";
delete process.env.MONGODB_URI;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.VUPS_BASE_URL;
delete process.env.VUPS_API_KEY;
delete process.env.VUPS_UNDERLYING_MODEL;
process.env.TASK_WORKER_DISABLED = "1";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_task_retries_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: Conversation } = await import("./conversation.js");
const { default: Task } = await import("./task.js");
const worker = await import("./taskWorker.js");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

before(() => {
  worker.startTaskWorker({ tickMs: 40 });
});

after(async () => {
  await worker.stopTaskWorker();
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `retry${Date.now()}-${counter}@example.com`;
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

async function newUser() {
  fakeProvider.state.reset();
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Retry Tester", email: uniqueEmail(), password: "correct-horse-battery", acceptTerms: true }
  });
  assert.equal(signup.status, 201);
  const cookie = sessionCookie(signup);
  const configured = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "Fake OpenAI-compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-mini"
    }
  });
  assert.equal(configured.status, 200);
  fakeProvider.state.reset();
  return cookie;
}

function sessionCookie(response) {
  const set = response.headers?.getSetCookie?.() || [];
  const session = set.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function submit(cookie, prompt) {
  const created = await api("/api/tasks", { method: "POST", cookie, body: { prompt } });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return created.body.task.taskId;
}

async function taskOf(cookie, taskId) {
  const found = await api(`/api/tasks/${taskId}`, { cookie });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  return found.body.task;
}

async function waitForState(cookie, taskId, wanted, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await taskOf(cookie, taskId);
    if ((Array.isArray(wanted) ? wanted : [wanted]).includes(last.state)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} never reached ${JSON.stringify(wanted)}; last state ${last?.state}`);
}

async function eventsOf(cookie, taskId) {
  const events = await api(`/api/tasks/${taskId}/events?after=0`, { cookie });
  assert.equal(events.status, 200, JSON.stringify(events.body));
  return events.body.events;
}

/**
 * Waits for a condition on the record itself. The worker writes the state and
 * the operation it is running in two steps, so a test that means to look at a
 * running operation has to wait for the operation, not only for the state.
 */
async function waitForTask(cookie, taskId, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await taskOf(cookie, taskId);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} never showed ${label}; last ${JSON.stringify(last)}`);
}

/** The retry policy under test, written back after each task so no test leaks it. */
function retryPolicy({ maxRetries = 2, baseMs = 40, maxMs = 8000, maxRetryAfterMs = 15000 } = {}) {
  process.env.VUPS_MAX_RETRIES = String(maxRetries);
  process.env.VUPS_RETRY_BASE_MS = String(baseMs);
  process.env.VUPS_RETRY_MAX_MS = String(maxMs);
  process.env.VUPS_RETRY_MAX_RETRY_AFTER_MS = String(maxRetryAfterMs);
}

test("2.2 a transient provider failure is retried, the task completes, and every attempt is recorded", async () => {
  const cookie = await newUser();
  retryPolicy();
  fakeProvider.state.set({ chatFailuresRemaining: 1, chatResponseText: "Answered on the second attempt." });
  const taskId = await submit(cookie, "Retry this after the provider is briefly unavailable.");
  const done = await waitForState(cookie, taskId, "completed");
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(fakeProvider.state.chatRequests.length, 2, "the model was not asked a second time");
  assert.equal(done.retry.attempts, 1, JSON.stringify(done.retry));
  assert.equal(done.retry.maxAttempts, 3, JSON.stringify(done.retry));
  assert.equal(done.retry.policy, "provider_backoff");
  assert.ok(done.retry.lastCode, "the record has to say which failure was retried");
  assert.ok(done.retry.lastErrorAt instanceof Date || typeof done.retry.lastErrorAt === "string");

  // Every attempt is its own row, so a report can count them instead of guessing:
  // the attempt that failed is recorded as failed, not left looking like it is
  // still running, and the one that answered is recorded as completed.
  const attempts = done.modelRequests.map(entry => entry.attempt);
  assert.deepEqual(attempts, [1, 2], JSON.stringify(done.modelRequests));
  assert.deepEqual(done.modelRequests.map(entry => entry.status), ["failed", "completed"], JSON.stringify(done.modelRequests));
  assert.ok(done.modelRequests[0].code, "the failed attempt has to say why it failed");
  assert.equal(new Set(done.modelRequests.map(entry => entry.requestId)).size, 1);
  const events = await eventsOf(cookie, taskId);
  const attemptEvents = events.filter(event => String(event.key).startsWith(`provider:${done.steps}:`));
  assert.equal(attemptEvents.length >= 1, true, JSON.stringify(events));
  assert.equal(attemptEvents.every(event => event.code), true, "a retry event has to name the failure it retried");
  assert.equal(done.state, "completed");
});

test("2.2 while the backoff is waiting, the task says it is retrying instead of pretending to run", async () => {
  const cookie = await newUser();
  // A long enough first backoff that the waiting period is observable, not raced.
  retryPolicy({ baseMs: 1500 });
  fakeProvider.state.set({ chatFailuresRemaining: 1, chatResponseText: "Answered after waiting." });
  const taskId = await submit(cookie, "Wait out a busy model and then answer.");

  const waiting = await waitForState(cookie, taskId, "retrying");
  assert.equal(waiting.state, "retrying");
  assert.ok(waiting.retry.nextAttemptAt instanceof Date || typeof waiting.retry.nextAttemptAt === "string",
    "a retrying task has to say when it tries again");
  assert.equal(fakeProvider.state.chatRequests.length, 1, "the retry started before the backoff was over");

  const done = await waitForState(cookie, taskId, "completed");
  assert.equal(done.state, "completed");
  assert.equal(fakeProvider.state.chatRequests.length, 2);
  // The wait itself is a row in the replayable log, carrying the delay the
  // worker really decided on. A client that reconnects after the wait can see
  // that the task spent time waiting, not that it silently did nothing.
  const events = await eventsOf(cookie, taskId);
  const backoff = events.find(event => event.key === `backoff:${done.steps}:1`);
  assert.ok(backoff, JSON.stringify(events));
  assert.equal(backoff.phase, "provider");
  assert.equal(backoff.code, "provider_unavailable");
  assert.match(backoff.message, /Waiting [\d.]+m?s before attempt 2 of 3\./);
});

test("2.2 a provider Retry-After is honoured and persisted, not averaged into the backoff", async () => {
  const cookie = await newUser();
  retryPolicy({ baseMs: 40, maxMs: 8000 });
  fakeProvider.state.set({
    chatStatus: 429,
    chatFailuresRemaining: 1,
    chatRetryAfter: 1,
    chatResponseText: "Answered after the provider's own wait."
  });
  const taskId = await submit(cookie, "This model is rate limited for a second.");
  const started = Date.now();
  const waiting = await waitForState(cookie, taskId, "retrying");
  assert.equal(waiting.retry.retryAfterMs, 1000, JSON.stringify(waiting.retry));
  assert.equal(waiting.retry.lastCode, "rate_limited", JSON.stringify(waiting.retry));
  assert.equal(waiting.error.kind, "", "a retried failure is not yet the task's final error");

  const done = await waitForState(cookie, taskId, "completed", 12000);
  const waited = Date.now() - started;
  assert.ok(waited >= 950, `the Retry-After second was not waited out: ${waited}ms`);
  assert.equal(done.state, "completed");
  assert.equal(fakeProvider.state.chatRequests.length, 2);
});

test("2.2 a Retry-After longer than the policy cap does not turn into an unbounded wait", async () => {
  const cookie = await newUser();
  retryPolicy({ baseMs: 40, maxRetryAfterMs: 1000 });
  fakeProvider.state.set({ chatStatus: 429, chatRetryAfter: 60, chatResponseText: "Never asked a second time." });
  const taskId = await submit(cookie, "The provider wants me to wait a minute.");
  const failed = await waitForState(cookie, taskId, "failed");
  assert.equal(fakeProvider.state.chatRequests.length, 1, "the task sat on a wait the policy forbids");
  assert.equal(failed.retry.attempts, 0, JSON.stringify(failed.retry));
  assert.equal(failed.error.code, "rate_limited");
  assert.equal(failed.error.retryable, true, "the provider was busy, and the record has to say so");
  assert.equal(failed.completedAt instanceof Date || typeof failed.completedAt === "string", true);
});

test("2.1 permanent provider failures are classified on the task and never retried", async () => {
  const cases = [
    {
      name: "authentication failure",
      behavior: { chatStatus: 401 },
      category: "invalid_credentials"
    },
    {
      name: "invalid request",
      behavior: { chatStatus: 400, chatErrorPayload: { error: { message: "Unsupported parameter: temperature." } } },
      category: "invalid_request"
    },
    {
      name: "context length exceeded",
      behavior: {
        chatStatus: 400,
        chatErrorPayload: { error: { message: "This model's maximum context length is 8192 tokens. Your prompt is too long." } }
      },
      category: "context_limit"
    },
    {
      name: "model unavailable",
      behavior: { failModel: "fake-model-mini", failModelStatus: 404, failModelMessage: "The model is temporarily unavailable." },
      category: "invalid_model"
    },
    {
      name: "quota exhausted",
      behavior: { chatStatus: 402 },
      category: "quota_exhausted"
    }
  ];
  for (const scenario of cases) {
    const cookie = await newUser();
    retryPolicy({ maxRetries: 3, baseMs: 40 });
    fakeProvider.state.set({ ...scenario.behavior, chatResponseText: "This answer must never be reached." });
    const taskId = await submit(cookie, `A permanent failure: ${scenario.name}.`);
    const failed = await waitForState(cookie, taskId, "failed", 12000);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(
      fakeProvider.state.chatRequests.length,
      1,
      `${scenario.name} was retried: ${fakeProvider.state.chatRequests.length} requests`
    );
    assert.equal(failed.error.kind, scenario.category, JSON.stringify(failed.error));
    assert.equal(failed.error.retryable, false, `${scenario.name} must not look retryable`);
    assert.ok(failed.error.code, JSON.stringify(failed.error));
    assert.equal(failed.retry.attempts, 0, JSON.stringify(failed.retry));
    assert.equal(failed.state, "failed", "a permanent failure is not a completed task");
  }
});

test("2.1 the task record never carries the provider key or a bearer token", async () => {
  const cookie = await newUser();
  retryPolicy({ maxRetries: 1, baseMs: 40 });
  fakeProvider.state.set({
    chatStatus: 401,
    chatErrorPayload: {
      error: {
        message: `The key ${FAKE_API_KEY} was rejected. Authorization: Bearer ${FAKE_API_KEY}`
      }
    }
  });
  const taskId = await submit(cookie, "Fail with a message that quotes the key.");
  const failed = await waitForState(cookie, taskId, "failed");
  const events = await eventsOf(cookie, taskId);
  const record = JSON.stringify(await Task.findOne({ taskId }).lean());
  // The word "Bearer" is allowed to survive as a label; what must never survive
  // is a token or a key after it.
  assert.equal(record.includes(FAKE_API_KEY), false, "the API key reached the task record");
  assert.equal(/Bearer\s+(?!\[redacted\])/i.test(record), false, "an unredacted authorization token reached the task record");
  const surfaced = JSON.stringify({ error: failed.error, events });
  assert.equal(surfaced.includes(FAKE_API_KEY), false, "the key reached a progress event or the error");
  assert.equal(/Bearer\s+(?!\[redacted\])/i.test(surfaced), false, "an unredacted token reached the client");
});

test("2.2 a retry does not redo work that already completed", async () => {
  const cookie = await newUser();
  retryPolicy({ baseMs: 40 });
  fakeProvider.state.set({ chatFailuresRemaining: 2, chatResponseText: "One answer, after two waits." });
  const taskId = await submit(cookie, "Do the setup once, then retry only the model call.");
  const done = await waitForState(cookie, taskId, "completed");
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(fakeProvider.state.chatRequests.length, 3);
  assert.equal(done.steps, 1, "the attempt counter moved the task's own step count");
  // The daily quota is the one side effect a retry could double-charge. Three
  // model requests, one consumption.
  const usage = await api("/api/auth/usage", { cookie });
  assert.equal(usage.status, 200, JSON.stringify(usage.body));
  assert.equal(usage.body.usage.dailyUsed, 1, JSON.stringify(usage.body.usage));
  const prepare = done.plan.find(step => step.id === "prepare");
  assert.equal(prepare.status, "completed", JSON.stringify(done.plan));
  assert.equal(done.plan.filter(step => step.id === "prepare").length, 1);

  const stored = await Task.findOne({ taskId }).lean();
  const conversation = await Conversation.findOne({ _id: stored.conversationId }).lean();
  const userTurns = conversation.messages.filter(message => message.role === "user");
  const assistants = conversation.messages.filter(message => message.role === "assistant");
  assert.equal(userTurns.length, 1, JSON.stringify(userTurns));
  assert.equal(assistants.length, 1, JSON.stringify(assistants));
  assert.equal(assistants[0].content, "One answer, after two waits.");
});

test("2.4 the provider call has a durable operation identity for its own step", async () => {
  const cookie = await newUser();
  retryPolicy({ baseMs: 40 });
  fakeProvider.state.set({ chatDelayMs: 400, chatResponseText: "Identity check." });
  const taskId = await submit(cookie, "Record which operation this run owns.");
  const running = await waitForTask(
    cookie,
    taskId,
    task => task.state === "running" && task.activeOperation.kind === "provider",
    "the provider operation while the call was in flight"
  );
  assert.equal(running.activeOperation.kind, "provider", JSON.stringify(running.activeOperation));
  assert.equal(running.activeOperation.operationId, `provider:${taskId}:${running.steps}`);
  assert.ok(running.activeOperation.startedAt, "the operation has to be timed");

  const done = await waitForState(cookie, taskId, "completed");
  assert.equal(done.activeOperation.kind, "none", JSON.stringify(done.activeOperation));
  assert.equal(done.modelRequests.every(entry => entry.requestId === `task-${taskId}`), true);
});

test("2.3 a provider that hangs up mid-request never becomes a completed answer", async () => {
  const cookie = await newUser();
  retryPolicy({ baseMs: 40 });
  fakeProvider.state.set({ dropConnectionBeforeResponse: true });
  const taskId = await submit(cookie, "Answer this while the network is unstable.");
  const done = await waitForState(cookie, taskId, "failed");

  // Three requests went out and none of them was answered. The task says so.
  assert.equal(fakeProvider.state.chatRequests.length, 3, "the dropped connection was not retried");
  assert.equal(done.error.kind, "network_error", JSON.stringify(done.error));
  assert.equal(done.error.retryable, true, "an interrupted connection is not a permanent failure");
  assert.equal(done.retry.attempts, 2, JSON.stringify(done.retry));
  assert.equal(done.modelRequests.length, 3, JSON.stringify(done.modelRequests));
  assert.equal(done.modelRequests.every(entry => entry.status === "failed"), true);

  const stored = await Task.findOne({ taskId }).lean();
  const conversation = await Conversation.findOne({ _id: stored.conversationId }).lean();
  const assistant = conversation.messages.filter(message => message.role === "assistant").at(-1);
  assert.equal(assistant.status, "failed", JSON.stringify(assistant));
  assert.equal(assistant.errorCode, "network_error", JSON.stringify(assistant));
});

test("2.1 a model still busy with the previous reply costs a task its patience, not its existence", async () => {
  const cookie = await newUser();
  retryPolicy({ baseMs: 40 });
  fakeProvider.state.set({
    chatStatus: 409,
    chatFailuresRemaining: 1,
    chatErrorPayload: {
      error: {
        type: "invalid_request_error",
        message: "Session is currently processing a turn. Cancel the current turn or wait for completion."
      }
    },
    chatResponseText: "Answered once the model was free again."
  });
  const taskId = await submit(cookie, "Ask again after the model finishes its previous reply.");
  const done = await waitForState(cookie, taskId, "completed");
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(done.state, "completed");
  assert.equal(fakeProvider.state.chatRequests.length, 2, "the busy model was not asked a second time");
  assert.equal(done.retry.attempts, 1, JSON.stringify(done.retry));
  assert.equal(done.retry.lastCategory, "session_busy", JSON.stringify(done.retry));
  assert.equal(done.modelRequests[0].code, "session_busy", JSON.stringify(done.modelRequests));
  assert.deepEqual(done.modelRequests.map(entry => entry.status), ["failed", "completed"], JSON.stringify(done.modelRequests));

  const events = await eventsOf(cookie, taskId);
  const backoff = events.find(event => event.key === `backoff:${done.steps}:1`);
  assert.ok(backoff, JSON.stringify(events));
  assert.match(backoff.message, /still finishing its previous reply\. Waiting [\d.]+m?s before attempt 2 of 3\./);

  const stored = await Task.findOne({ taskId }).lean();
  const conversation = await Conversation.findOne({ _id: stored.conversationId }).lean();
  const assistant = conversation.messages.filter(message => message.role === "assistant").at(-1);
  assert.equal(assistant.status, "completed", JSON.stringify(assistant));
  assert.match(assistant.content, /Answered once the model was free again\./);
});

test("2.2 cancelling during the backoff stops the retry instead of sending another request", async () => {
  const cookie = await newUser();
  // Long enough that the cancel definitely lands inside the wait.
  retryPolicy({ baseMs: 2500 });
  fakeProvider.state.set({ chatFailuresRemaining: 1, chatResponseText: "Should never be written." });
  const taskId = await submit(cookie, "Retry this one, but I am changing my mind.");

  await waitForState(cookie, taskId, "retrying");
  assert.equal(fakeProvider.state.chatRequests.length, 1);

  const cancelled = await api(`/api/tasks/${taskId}/cancel`, { method: "POST", cookie, body: {} });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.task.state, "cancelled");
  assert.ok(cancelled.body.task.completedAt, "a cancelled task has to be closed in the record");

  // Long past the backoff that was pending: nothing may have been sent.
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(fakeProvider.state.chatRequests.length, 1, "a cancelled task sent another model request");
  const again = await taskOf(cookie, taskId);
  assert.equal(again.state, "cancelled", "the task came back from a user cancellation");
  assert.equal(again.retry.attempts, 1, "the retry that was waiting is still recorded");

  const stored = await Task.findOne({ taskId }).lean();
  const conversation = await Conversation.findOne({ _id: stored.conversationId }).lean();
  const assistant = conversation.messages.filter(message => message.role === "assistant").at(-1);
  assert.equal(assistant.status, "interrupted", JSON.stringify(assistant));
});
