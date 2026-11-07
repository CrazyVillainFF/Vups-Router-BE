import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

// Phase 1 — persistent task manager. These tests are the contract: a submitted
// task is a durable record owned by the server, it reaches a terminal state only
// through a legal transition, and no client connection owns its lifetime.
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
// The worker is started explicitly below, so a single test file owns its timing.
process.env.TASK_WORKER_DISABLED = "1";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_task_lifecycle_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: Conversation } = await import("./conversation.js");
const { default: Task } = await import("./task.js");
const state = await import("./taskState.js");
const worker = await import("./taskWorker.js");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

before(() => {
  worker.startTaskWorker({ tickMs: 60 });
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
  return `task${Date.now()}-${counter}@example.com`;
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

/**
 * Submit over a socket the client then destroys hard, which is what a screen
 * that unmounts, a tab that goes away or a phone that is minimised does to the
 * connection. The task must not find out about it.
 */
function submitAndDropSocket(cookie, prompt) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: "/api/tasks",
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }
      },
      res => {
        res.setEncoding("utf8");
        let text = "";
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => {
          req.destroy();
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ prompt }));
  });
}

function sessionCookie(response) {
  const set = response.headers.getSetCookie();
  const session = set.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function newUser() {
  fakeProvider.state.reset();
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Task Tester", email: uniqueEmail(), password: "correct-horse-battery", acceptTerms: true }
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

async function submit(cookie, prompt, extra = {}) {
  return api("/api/tasks", { method: "POST", cookie, body: { prompt, ...extra } });
}

async function taskOf(cookie, taskId) {
  return api(`/api/tasks/${taskId}`, { cookie });
}

async function eventsOf(cookie, taskId, after = 0) {
  return api(`/api/tasks/${taskId}/events?after=${after}`, { cookie });
}

async function waitForState(cookie, taskId, wanted, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await taskOf(cookie, taskId);
    if (last.status === 200 && (Array.isArray(wanted) ? wanted : [wanted]).includes(last.body.task.state)) {
      return last.body.task;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`task ${taskId} never reached ${JSON.stringify(wanted)}; last state ${last.body?.task?.state ?? last.status}`);
}

const NON_TERMINAL = state.TASK_STATES.filter(candidate => !state.TERMINAL_STATES.includes(candidate));

test("1.3 every required task state exists, and the terminal set is exactly the three that end a task", () => {
  for (const required of [
    "queued", "planning", "running", "executing_tool", "retrying", "waiting_for_user",
    "waiting_for_permission", "paused", "recovering", "verifying", "completed", "failed", "cancelled"
  ]) {
    assert.ok(state.TASK_STATES.includes(required), `state ${required} is missing`);
  }
  assert.deepEqual([...state.TERMINAL_STATES].sort(), ["cancelled", "completed", "failed"]);
});

test("1.3 legal transitions are accepted and illegal ones are rejected with a code", () => {
  assert.equal(state.canTransition("queued", "planning"), true);
  assert.equal(state.canTransition("running", "executing_tool"), true);
  assert.equal(state.canTransition("running", "retrying"), true);
  assert.equal(state.canTransition("retrying", "running"), true);
  assert.equal(state.canTransition("waiting_for_user", "running"), true);
  assert.equal(state.canTransition("waiting_for_permission", "executing_tool"), true);
  assert.equal(state.canTransition("paused", "queued"), true);
  assert.equal(state.canTransition("recovering", "running"), true);
  assert.equal(state.canTransition("verifying", "completed"), true);

  // A task cannot jump from a queue to a terminal state, and a step cannot be
  // claimed as finished without passing through the work itself.
  assert.equal(state.canTransition("queued", "completed"), false);
  assert.equal(state.canTransition("planning", "completed"), false);
  assert.equal(state.canTransition("queued", "executing_tool"), false);
  assert.equal(state.canTransition("completed", "running"), false);
  assert.equal(state.canTransition("failed", "running"), false);
  assert.equal(state.canTransition("cancelled", "queued"), false);
  assert.throws(
    () => state.assertTransition("queued", "completed"),
    error => error.code === "illegal_transition" && error.from === "queued" && error.to === "completed"
  );
  // A finished task says so with its own code, so a caller can tell "that make
  // no sense" apart from "that task is over and stays over".
  assert.throws(
    () => state.assertTransition("completed", "running"),
    error => error.code === "task_terminal" && error.from === "completed" && error.to === "running"
  );
  assert.throws(() => state.assertTransition("running", "teleported"), error => error.code === "unknown_state");
});

test("1.3 no transition leaves a terminal state, so a finished task cannot restart itself", () => {
  for (const terminal of state.TERMINAL_STATES) {
    for (const target of state.TASK_STATES) {
      assert.equal(
        state.canTransition(terminal, target),
        false,
        `terminal state ${terminal} must not allow ${target}`
      );
    }
    assert.equal(state.isTerminal(terminal), true);
  }
  // Every non-terminal state has to have a way forward, or a task is stuck.
  for (const open of NON_TERMINAL) {
    assert.ok(state.outgoingStates(open).length > 0, `${open} has no legal exit`);
  }
});

test("1.1/1.2 a submitted task is a durable record with its own id and the required fields", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatResponseText: "The plan is ready.", chatDelayMs: 250 });

  const created = await submit(cookie, "Install and configure the inspector skill.");
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const taskId = created.body.task.taskId;
  assert.match(taskId, /^tsk_[0-9a-f]{24}$/, `unexpected task id ${taskId}`);
  assert.equal(created.body.task.state, "queued");

  // The record is the database's, not the process's: read it back through the
  // driver, not through the API, to prove what a reconnect can still find.
  const stored = await Task.findOne({ taskId }).lean();
  assert.ok(stored, "no task document was written");
  for (const field of [
    "taskId", "userId", "conversationId", "description", "state", "stage", "plan",
    "events", "modelRequests", "toolOperations", "retry", "clarifications", "error",
    "createdAt", "lastActivityAt", "recovery"
  ]) {
    assert.ok(field in stored, `task record is missing ${field}`);
  }
  assert.equal(stored.description, "Install and configure the inspector skill.");

  const finished = await waitForState(cookie, taskId, "completed");
  assert.equal(finished.stage, "done");
  assert.equal(finished.error.code, "");
  assert.ok(finished.completedAt, "a completed task must record when it finished");
  assert.ok(finished.modelRequests.length >= 1, "the model request reference was not recorded");
  assert.equal(finished.modelRequests[0].status, "completed");
  assert.ok(finished.plan.every(step => step.status === "completed"), JSON.stringify(finished.plan));
  assert.deepEqual(finished.toolOperations, [], "a backend task must not claim tool work it did not do");

  const conversation = await Conversation.findOne({ _id: finished.conversationId }).lean();
  assert.ok(conversation, "the task did not write its conversation");
  assert.equal(conversation.messages.filter(m => m.role === "user").length, 1);
  assert.equal(conversation.messages.at(-1).role, "assistant");
  assert.equal(conversation.messages.at(-1).content, "The plan is ready.");
  assert.ok(Array.isArray(conversation.messages.at(-1).progress));
});

test("1.1 the task outlives the request that submitted it, and a second task is not disturbed", async () => {
  const cookie = await newUser();
  // The turn is slow enough that the first task is still in flight when its
  // connection is dropped and when the second task is submitted. The answer is
  // chosen from the message the provider actually received, because two tasks
  // run at once and a single scripted response would be read by the wrong one.
  fakeProvider.state.set({
    chatDelayMs: 900,
    chatResponder: body =>
      String(body.messages?.at(-1)?.content || "").startsWith("First task:") ? "First answer." : "Second answer."
  });
  const first = await submitAndDropSocket(cookie, "First task: keep going after my socket closes.");
  assert.equal(first.status, 202, JSON.stringify(first.body));
  const firstId = first.body.task.taskId;

  const second = await submit(cookie, "Second task: an unrelated question.");
  assert.equal(second.status, 202);
  const secondId = second.body.task.taskId;
  assert.notEqual(firstId, secondId);

  const firstDone = await waitForState(cookie, firstId, "completed", 12000);
  const secondDone = await waitForState(cookie, secondId, "completed", 12000);
  assert.notEqual(firstDone.conversationId, secondDone.conversationId);
  assert.equal(firstDone.error.code, "");
  assert.equal(secondDone.error.code, "");

  // The abandoned socket is not a cancellation: the answer is really in the
  // conversation the task belongs to.
  const conversation = await Conversation.findOne({ _id: firstDone.conversationId }).lean();
  assert.equal(conversation.messages.at(-1).content, "First answer.");
  assert.equal(conversation.messages.at(-1).status, "completed");

  const listed = await api("/api/tasks", { cookie });
  assert.equal(listed.status, 200);
  const ids = listed.body.tasks.map(entry => entry.taskId);
  assert.ok(ids.includes(firstId) && ids.includes(secondId), JSON.stringify(ids));
  assert.equal(listed.body.tasks.filter(entry => entry.state === "completed").length >= 2, true);
});

test("1.1/5.3 events are ordered, replayable from a cursor, and never repeated", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatResponseText: "Replay me.", chatDelayMs: 400 });
  const created = await submit(cookie, "Replay this task's progress after a disconnect.");
  const taskId = created.body.task.taskId;
  await waitForState(cookie, taskId, "completed");

  const seen = [];
  let cursor = 0;
  for (let page = 0; page < 12; page += 1) {
    const events = await eventsOf(cookie, taskId, cursor);
    assert.equal(events.status, 200);
    for (const event of events.body.events) {
      assert.ok(event.seq > cursor, `event ${event.seq} arrived after cursor ${cursor}`);
      cursor = event.seq;
      seen.push(event);
    }
    if (events.body.state === "completed" && events.body.events.length === 0) break;
  }
  const seqs = seen.map(event => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "events arrived out of order");
  assert.equal(new Set(seqs).size, seqs.length, "an event id was replayed twice");
  assert.ok(seqs[0] === 1, `the first event must open the log, got ${seqs[0]}`);
  assert.equal(seen.every(event => typeof event.message === "string" && event.message.length > 0), true);
  assert.equal(seen.at(-1).status, "completed");

  // A final replay from zero returns the whole log, which is what a client that
  // was offline for the entire run receives when it comes back.
  const all = await eventsOf(cookie, taskId, 0);
  assert.equal(all.body.events.length, seen.length);
  assert.equal(all.body.lastSeq, cursor);
});

test("1.1 cancelling is an explicit action, stops the provider call, and leaves an honest record", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatDelayMs: 2500, chatResponseText: "Should never be saved." });
  const created = await submit(cookie, "Cancel this one while the model is still thinking.");
  const taskId = created.body.task.taskId;
  await waitForState(cookie, taskId, ["running", "planning"]);

  const cancelled = await api(`/api/tasks/${taskId}/cancel`, { method: "POST", cookie });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.task.state, "cancelled");

  const settled = await waitForState(cookie, taskId, "cancelled");
  assert.ok(settled.cancelRequestedAt, "the cancel had to be recorded as a user action");
  assert.equal(settled.completedAt instanceof Date || typeof settled.completedAt === "string", true);
  const events = await eventsOf(cookie, taskId, 0);
  assert.equal(events.body.events.some(event => event.status === "cancelled"), true);

  // A cancelled task writes nothing into the conversation except the user's own
  // message, so a reload cannot show an answer that was never given.
  const stored = await Task.findOne({ taskId }).lean();
  if (stored.conversationId) {
    const conversation = await Conversation.findOne({ _id: stored.conversationId }).lean();
    const assistant = (conversation?.messages ?? []).filter(m => m.role === "assistant");
    assert.equal(assistant.length <= 1, true);
    for (const message of assistant) {
      assert.notEqual(message.status, "completed", JSON.stringify(message));
      assert.equal(message.content === "Should never be saved.", false);
    }
  }

  // Cancelling twice is not an error, and it cannot move a terminal task.
  const again = await api(`/api/tasks/${taskId}/cancel`, { method: "POST", cookie });
  assert.equal(again.status, 200);
  assert.equal(again.body.task.state, "cancelled");
});

test("1.3 a terminal task cannot be restarted through the API", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatResponseText: "Done." });
  const created = await submit(cookie, "A short finished task.");
  const taskId = created.body.task.taskId;
  await waitForState(cookie, taskId, "completed");

  const resumed = await api(`/api/tasks/${taskId}/resume`, { method: "POST", cookie });
  assert.equal(resumed.status, 409, JSON.stringify(resumed.body));
  assert.equal(resumed.body.code, "task_terminal");

  const stored = await Task.findOne({ taskId }).lean();
  assert.equal(stored.state, "completed");
});

test("9 no account can see, list or cancel another account's task", async () => {
  const owner = await newUser();
  const intruder = await newUser();
  fakeProvider.state.set({ chatResponseText: "Private answer.", chatDelayMs: 300 });
  const created = await submit(owner, "A task belonging to the first account.");
  const taskId = created.body.task.taskId;

  for (const attempt of [
    await taskOf(intruder, taskId),
    await eventsOf(intruder, taskId, 0),
    await api(`/api/tasks/${taskId}/cancel`, { method: "POST", cookie: intruder })
  ]) {
    assert.equal(attempt.status, 404, JSON.stringify(attempt.body));
  }
  const listed = await api("/api/tasks", { cookie: intruder });
  assert.equal(listed.body.tasks.some(entry => entry.taskId === taskId), false);
  const unauthenticated = await taskOf(null, taskId);
  assert.equal(unauthenticated.status, 401);

  await waitForState(owner, taskId, "completed");
});

test("1.2 submit input is validated before a task exists, so a bad request makes no record", async () => {
  const cookie = await newUser();
  const empty = await submit(cookie, "   ");
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "invalid_prompt");
  const tooLong = await submit(cookie, "x".repeat(20001));
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.code, "invalid_prompt");
  assert.equal((await api("/api/tasks", { cookie })).body.tasks.length, 0, "a rejected submission created a task");

  const unknown = await taskOf(cookie, "tsk_000000000000000000000000");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "task_not_found");
  const malformed = await taskOf(cookie, "not-a-task-id");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_task_id");
});

test("1.2/1.3 a task interrupted by a server restart is recovered, not lost, and answers once", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatResponseText: "Resumed answer." });
  const created = await submit(cookie, "Survive a backend restart mid-task.");
  const taskId = created.body.task.taskId;
  await waitForState(cookie, taskId, "completed");

  // Stand in for a process that died holding this task: the record is left in an
  // open state with an expired lease, exactly what a restart produces today.
  await Task.updateOne(
    { taskId },
    { $set: { state: "running", "lease.expiresAt": new Date(Date.now() - 1000), completedAt: null, expiresAt: null } }
  );
  const recovered = await worker.reconcileInterruptedTasks();
  assert.ok(recovered.some(entry => entry.taskId === taskId), JSON.stringify(recovered));
  const done = await waitForState(cookie, taskId, "completed", 12000);
  assert.ok(done.recovery.restarts >= 1, JSON.stringify(done.recovery));
  assert.ok(done.recovery.interruptedAt, "the interruption has to be dated");

  const conversation = await Conversation.findOne({ _id: done.conversationId }).lean();
  const assistants = conversation.messages.filter(m => m.role === "assistant");
  assert.equal(assistants.length, 1, "recovery repeated an answer the task had already given");
  assert.equal(assistants[0].content, "Resumed answer.");
});

test("1.1 a task running when the worker stops is picked up again and answers once", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatDelayMs: 1200, chatResponseText: "Answered after the restart." });
  const created = await submit(cookie, "Keep this answer across a worker restart.");
  const taskId = created.body.task.taskId;
  await waitForState(cookie, taskId, "running");

  // The holder really goes away while the model call is still open. This is the
  // deployment restart case, run for real rather than written into the record.
  await worker.stopTaskWorker();
  const stopped = (await taskOf(cookie, taskId)).body.task;
  assert.equal(stopped.cancelRequestedAt || null, null, "a worker stopping must not read as a cancellation");
  assert.equal(state.isTerminal(stopped.state), false, `a stopped holder left the task ${stopped.state}`);

  worker.startTaskWorker({ tickMs: 60 });
  const done = await waitForState(cookie, taskId, "completed", 15000);
  assert.ok(done.recovery.restarts >= 1, JSON.stringify(done.recovery));
  const conversation = await Conversation.findOne({ _id: done.conversationId }).lean();
  assert.equal(conversation.messages.filter(message => message.role === "assistant").length, 1,
    "the restarted holder answered twice");
  assert.equal(conversation.messages.at(-1).content, "Answered after the restart.");
});

test("1.1 a task cancelled before any worker picks it up never starts, and never runs late", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatResponseText: "This must never be asked." });
  // Hold the scheduler back so the task is certainly still in the queue.
  await worker.stopTaskWorker();
  const created = await submit(cookie, "Cancel me before anyone starts me.");
  const taskId = created.body.task.taskId;
  assert.equal((await taskOf(cookie, taskId)).body.task.state, "queued");

  const cancelled = await api(`/api/tasks/${taskId}/cancel`, { method: "POST", cookie });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.task.state, "cancelled");

  // Released back to the pool: a cancelled task must not be claimable again.
  worker.startTaskWorker({ tickMs: 60 });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await taskOf(cookie, taskId)).body.task.state, "cancelled");
  assert.equal(fakeProvider.state.chatRequests.length, 0, "a cancelled task reached the model");
});

test("1.3 a provider failure is recorded as failed with its code, never as completed", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatStatus: 500 });
  const created = await submit(cookie, "This model call will fail.");
  const taskId = created.body.task.taskId;
  const failed = await waitForState(cookie, taskId, "failed");
  assert.ok(failed.error.code, "the failure has to carry its machine-readable code");
  assert.equal(typeof failed.error.message, "string");
  assert.ok(failed.completedAt, "a failed task is terminal and has to be dated");
  const events = await eventsOf(cookie, taskId, 0);
  assert.equal(events.body.events.some(event => event.status === "failed"), true);
  const states = events.body.events.map(event => event.state || event.status);
  assert.equal(states.includes("completed"), false, JSON.stringify(events.body.events));
});
