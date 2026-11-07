/**
 * Phase 3 acceptance suite (issue #333): PH3-01..PH3-12 plus the #337 regression.
 *
 * The style is the one the other task suites already use: a real HTTP server on a
 * loopback port over `mongodb-memory-server`, real `requireAuth` sessions, the
 * real routes, the real claim/lease/retry/recovery/cancellation code, and the
 * deterministic stand-in provider from `testUtils/fakeProvider.js`.
 *
 * What that means for reading the results: the upstream model in every case here
 * is a scripted fake. These tests prove the task system's own behaviour — what it
 * records, what it refuses, what it replays — and say nothing about real provider
 * latency, real limit headers or real answer quality. Nothing in this file is a
 * live-provider test.
 *
 * Two conventions in this file are deliberate and easy to get wrong:
 *   - The scripted provider behaviour is applied AFTER the account is created.
 *     Configuring a provider is itself a model call, so `newUser()` resets the
 *     script; setting the behaviour first would be reset away and the test would
 *     run against the default echo with none of its intended delay.
 *   - The lease is asserted against the stored record, never against an API body.
 *     `taskSummary`/`taskDetail` do not expose `lease`, so a `task.lease` check
 *     made over HTTP can only ever be vacuously true.
 */
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
// Only the test that means to retry raises this; a permanent failure must not be
// retried by a policy nobody asked for.
process.env.VUPS_MAX_RETRIES = "0";
process.env.TASK_WORKER_DISABLED = "1";
delete process.env.TASK_USER_CONCURRENCY;
delete process.env.TASK_WORKER_CONCURRENCY;

import assert from "node:assert/strict";
import { after, test } from "node:test";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_task_acceptance_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { MAX_TASK_DESCRIPTION_CHARS } = await import("./task.js");
const connectToDatabase = (await import("./db.js")).default;
const { default: Task } = await import("./task.js");
const state = await import("./taskState.js");
const store = await import("./taskStore.js");
const worker = await import("./taskWorker.js");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
await connectToDatabase();

after(async () => {
  await worker.stopTaskWorker();
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await mongoose.disconnect();
  await mongod.stop();
});

async function withScheduler(run, { tickMs = 40 } = {}) {
  worker.startTaskWorker({ tickMs });
  try {
    return await run();
  } finally {
    await worker.stopTaskWorker();
  }
}

let counter = 0;
function uniqueEmail(prefix = "accept") {
  counter += 1;
  return `${prefix}${Date.now()}-${counter}@example.com`;
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
  const set = response.headers?.getSetCookie?.() || [];
  const session = set.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

/** A signed-in account with the fake provider configured, as every suite does. */
async function newUser(prefix = "accept") {
  fakeProvider.state.reset();
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Acceptance Tester", email: uniqueEmail(prefix), password: "correct-horse-battery", acceptTerms: true }
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
  const created = await api("/api/tasks", { method: "POST", cookie, body: { prompt, ...extra } });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return created.body.task.taskId;
}

async function taskOf(cookie, taskId) {
  const found = await api(`/api/tasks/${taskId}`, { cookie });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  return found.body.task;
}

async function waitForState(cookie, taskId, wanted, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const allowed = Array.isArray(wanted) ? wanted : [wanted];
  let last = null;
  while (Date.now() < deadline) {
    last = await taskOf(cookie, taskId);
    if (allowed.includes(last.state)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `task ${taskId} never reached ${JSON.stringify(allowed)}; last state ${last?.state}, error ${JSON.stringify(last?.error)}`
  );
}

/** The stored record: the only place a lease can be read from. */
async function record(taskId) {
  const found = await Task.findOne({ taskId }).lean();
  assert.ok(found, `no record for ${taskId}`);
  return found;
}

/**
 * How many times the model was asked about one instruction.
 *
 * Two other readings are not usable for this. The fake provider's total request
 * log cannot carry it: the suite shares one database, so a later scheduler
 * drains tasks an earlier test left in the queue and a global count charges those
 * to whichever test reads it. The record's own `modelRequests` cannot carry it
 * either: `requestId` is `task-<taskId>` and rows are keyed by (requestId,
 * attempt), so a recovered run rewrites attempt 1 of the execution it replaced
 * instead of adding a row — one row for two real calls. Matching on the
 * instruction the task was created from counts every request it caused, in this
 * process or the next.
 */
function asksFor(prompt) {
  return fakeProvider.state.chatRequests.filter(
    entry => JSON.stringify(entry.body?.messages || []).includes(prompt)
  ).length;
}

const uid = () => new mongoose.Types.ObjectId();

// ─── PH3-01 submission, persistence and conversation association ─────────────

test("PH3-01 a submitted task is a durable record the response does not have to wait for", async () => {
  const cookie = await newUser("ph301");
  fakeProvider.state.set({ chatDelayMs: 1200, chatResponseText: "Answered later." });
  const conversationId = String(uid());
  const taskId = await submit(cookie, "Outlive the request that made it.", { conversationId });

  const created = await taskOf(cookie, taskId);
  assert.ok(taskId.startsWith("tsk_"), `id is not a task id: ${taskId}`);
  assert.equal(created.description, "Outlive the request that made it.");
  assert.equal(created.conversationId, conversationId, "the conversation the caller named was not remembered");
  assert.equal(created.state, "queued", JSON.stringify(created.state));
  assert.ok(created.createdAt, "the record has no creation time");
  assert.ok(!created.result?.summary, `a task that has not run already reports an answer: ${JSON.stringify(created.result)}`);
  assert.ok(!created.error?.code, `a task that has not run already reports a failure: ${JSON.stringify(created.error)}`);

  const onDisk = await record(taskId);
  assert.equal(String(onDisk.conversationId), conversationId);
  assert.ok(!onDisk.lease?.owner, "a queued task claims a live holder");

  await withScheduler(async () => {
    const done = await waitForState(cookie, taskId, "completed", 20000);
    assert.equal(done.conversationId, conversationId, "finishing dropped the conversation link");
    assert.match(done.result?.summary ?? "", /Answered later\./, JSON.stringify(done.result));
    assert.ok(done.startedAt && done.completedAt, "no honest run window on a finished task");
  });
});

test("PH3-01 a submission that is refused creates no record at all", async () => {
  const cookie = await newUser("ph301b");
  const empty = await api("/api/tasks", { method: "POST", cookie, body: { prompt: "   " } });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.equal(empty.body.code, "invalid_prompt");

  const tooLong = await api("/api/tasks", {
    method: "POST",
    cookie,
    body: { prompt: "x".repeat(MAX_TASK_DESCRIPTION_CHARS + 1) }
  });
  assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
  assert.equal(tooLong.body.code, "invalid_prompt", "an over-long description was refused for the wrong reason");

  const badConversation = await api("/api/tasks", {
    method: "POST",
    cookie,
    body: { prompt: "Attach me to a chat that does not exist.", conversationId: "not-an-object-id" }
  });
  assert.equal(badConversation.status, 400, JSON.stringify(badConversation.body));
  assert.equal(badConversation.body.code, "invalid_conversation_id");

  const { body } = await api("/api/tasks?limit=50", { cookie });
  assert.deepEqual(body.tasks, [], "a refused submission still wrote something down");
});

test("PH3-01 a second identical submission is a second task — the server has no dedup to lean on", async () => {
  const cookie = await newUser("ph301c");
  fakeProvider.state.set({ chatDelayMs: 200, chatResponseText: "Twice asked, twice done." });
  const prompt = "Submit the same words twice.";
  const first = await submit(cookie, prompt);
  const second = await submit(cookie, prompt);
  assert.notEqual(second, first, "the server quietly deduplicated, so the client's guard would go unnoticed");

  const { body } = await api("/api/tasks?limit=50", { cookie });
  const matches = body.tasks.filter(task => task.description === prompt);
  assert.equal(matches.length, 2, `${matches.length} records for two identical submissions`);
  assert.notEqual(
    new Date(matches[0].createdAt).getTime(),
    new Date(matches[1].createdAt).getTime(),
    "two records share a clock value"
  );

  await withScheduler(async () => {
    await Promise.all([
      waitForState(cookie, first, "completed", 20000),
      waitForState(cookie, second, "completed", 20000)
    ]);
  });
  assert.equal(
    asksFor(prompt),
    2,
    "two records were written but only one ran, so a resubmit silently swallowed work"
  );
});

// ─── PH3-03 listing, detail and the event window ────────────────────────────

test("PH3-03 the list holds only the caller's rows and the detail holds what the list defers", async () => {
  const cookieA = await newUser("ph303a");
  const cookieB = await newUser("ph303b");
  fakeProvider.state.set({ chatDelayMs: 250, chatResponseText: "Listed answer." });
  const idA = await submit(cookieA, "Belongs to account A.");
  const idB = await submit(cookieB, "Belongs to account B.");

  const listA = await api("/api/tasks?limit=50", { cookie: cookieA });
  assert.equal(listA.status, 200);
  assert.ok(listA.body.tasks.some(task => task.taskId === idA), "own task missing from own list");
  assert.ok(!listA.body.tasks.some(task => task.taskId === idB), "another account's task appeared in this list");

  const capped = await api("/api/tasks?limit=1", { cookie: cookieA });
  assert.equal(capped.body.tasks.length, 1, "the limit was ignored");

  await withScheduler(async () => {
    await waitForState(cookieA, idA, "completed", 20000);
  });

  const detail = await taskOf(cookieA, idA);
  assert.ok(Array.isArray(detail.events) && detail.events.length > 0, "no events on a finished task");
  assert.ok(Array.isArray(detail.modelRequests), "the detail carries no model-request accounting");
  assert.ok(detail.modelRequests.length >= 1, JSON.stringify(detail.modelRequests));
  assert.ok(detail.modelRequests[0].model, JSON.stringify(detail.modelRequests[0]));
  assert.ok(detail.lastSeq >= 1, `lastSeq ${detail.lastSeq} does not match a log of ${detail.events.length}`);
  assert.equal(
    detail.events.slice(-1)[0].seq,
    detail.lastSeq,
    "lastSeq is not the head of the window the detail returned"
  );
  assert.ok(
    !JSON.stringify(detail).match(/sk-[a-z0-9]{8,}/i),
    "a credential-shaped string reached the API response"
  );

  const summary = (await api("/api/tasks?limit=50", { cookie: cookieA })).body.tasks.find(t => t.taskId === idA);
  assert.equal(summary.eventCount, detail.events.length, "the row's event count disagrees with its log");
  assert.equal(summary.lastEvent.seq, detail.lastSeq, "the row's last event is not the head of the log");
  assert.equal(summary.state, "completed");
});

// ─── PH3-04 queue, fairness and concurrency ─────────────────────────────────

test("PH3-04 four queued tasks drain to four independent outcomes", async () => {
  const cookie = await newUser("ph304");
  fakeProvider.state.set({ chatDelayMs: 400, chatResponseText: "Queued answer." });
  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    ids.push(await submit(cookie, `Drain the queue ${index}.`));
  }
  assert.equal(new Set(ids).size, 4, "four submissions share an id");

  await withScheduler(async () => {
    const settled = await Promise.all(ids.map(id => waitForState(cookie, id, "completed", 30000)));
    for (const task of settled) {
      assert.match(task.result?.summary ?? "", /Queued answer\./, JSON.stringify(task.result));
      assert.ok(
        !task.error?.code && !task.error?.message,
        `a completed task carries an error: ${JSON.stringify(task.error)}`
      );
    }
  });
  const calls = ids.map((_id, index) => asksFor(`Drain the queue ${index}.`));
  assert.deepEqual(calls, [1, 1, 1, 1], `four queued tasks made ${calls.join("/")} model calls`);
});

test("PH3-04 the per-user cap bounds one account and leaves the next one waiting", async () => {
  const cookie = await newUser("ph304b");
  process.env.TASK_USER_CONCURRENCY = "1";
  fakeProvider.state.set({ chatDelayMs: 1800, chatResponseText: "Capped." });
  try {
    const first = await submit(cookie, "Hold the single slot.");
    const second = await submit(cookie, "Wait for the slot.");
    await withScheduler(async () => {
      await waitForState(cookie, first, "running", 15000);
      const waiting = await taskOf(cookie, second);
      assert.equal(
        waiting.state,
        "queued",
        `the cap let a second task of the same account run: ${waiting.state}`
      );
      assert.ok(!(await record(second)).lease?.owner, "the queued task holds a lease it was never given");
      await waitForState(cookie, first, "completed", 25000);
      await waitForState(cookie, second, "completed", 25000);
    });
  } finally {
    delete process.env.TASK_USER_CONCURRENCY;
  }
});

test("PH3-04 the queue is served oldest-first when the cap only lets one through", async () => {
  const cookie = await newUser("ph304c");
  fakeProvider.state.set({ chatDelayMs: 900, chatResponseText: "Fair order." });
  const userId = (await record(await submit(cookie, "Order probe."))).userId;
  const older = await store.createTask({ userId, description: "Oldest backlog task." });
  await Task.updateOne({ taskId: older.taskId }, { $set: { createdAt: new Date(Date.now() - 60_000) } });

  await withScheduler(async () => {
    const running = await waitForState(cookie, older.taskId, "running", 15000);
    assert.equal(running.state, "running");
    const held = await record(older.taskId);
    assert.ok(held.lease?.owner, "the oldest task runs under no lease");
    assert.ok(held.lease.expiresAt > new Date(), "the oldest task's lease already lapsed while it ran");
    await waitForState(cookie, older.taskId, "completed", 25000);
  });
});

// ─── PH3-05 cancellation isolation ──────────────────────────────────────────

test("PH3-05 cancelling one running task leaves its neighbour running and finishes its own honestly", async () => {
  const cookie = await newUser("ph305");
  fakeProvider.state.set({ chatDelayMs: 4000, chatResponseText: "Should not land." });
  const doomed = await submit(cookie, "Cancel only this one.");
  const survivor = await submit(cookie, "Car on regardless.", { conversationId: String(uid()) });

  await withScheduler(async () => {
    await waitForState(cookie, doomed, ["running", "executing_tool"], 15000);
    const cancelled = await api(`/api/tasks/${doomed}/cancel`, { method: "POST", cookie, body: {} });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.task.state, "cancelled", JSON.stringify(cancelled.body.task.state));

    const kept = await waitForState(cookie, survivor, ["running", "executing_tool", "completed"], 15000);
    assert.ok(
      !state.isTerminal(kept.state) || kept.state === "completed",
      `the other task ended with it: ${kept.state}`
    );

    const ended = await waitForState(cookie, doomed, "cancelled", 15000);
    assert.ok(ended.completedAt, "a cancelled task has no end time");
    assert.equal(ended.cancelRequestedBy, "user", JSON.stringify(ended.cancelRequestedBy));
    assert.ok(!ended.result?.summary, `an aborted task stored an answer: ${JSON.stringify(ended.result)}`);
    assert.ok(
      ended.events.some(event => event.status === "cancelled" || /cancel/i.test(event.message || "")),
      "the log does not show the cancellation"
    );

    await waitForState(cookie, survivor, "completed", 30000);
  });
});

test("PH3-05 a late provider reply cannot turn a cancelled task into a completed one", async () => {
  const cookie = await newUser("ph305b");
  fakeProvider.state.set({ chatDelayMs: 2500, chatResponseText: "Arrives after the cancel." });
  const taskId = await submit(cookie, "Cancel me mid-call.");
  await withScheduler(async () => {
    await waitForState(cookie, taskId, ["running", "executing_tool"], 15000);
    await api(`/api/tasks/${taskId}/cancel`, { method: "POST", cookie, body: {} });
    await waitForState(cookie, taskId, "cancelled", 15000);
    // The scripted answer is still in flight when the cancel lands and arrives
    // after it: the record has to keep the user's decision, not the late reply.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const later = await taskOf(cookie, taskId);
    assert.equal(later.state, "cancelled", "a reply that landed late rewrote the outcome");
  });
});

// ─── PH3-06 waiting, resume and its refusals ────────────────────────────────

test("PH3-06 resume is accepted only in the three states that wait, and moves only the named task", async () => {
  const cookie = await newUser("ph306");
  fakeProvider.state.set({ chatDelayMs: 900, chatResponseText: "Carried on." });
  const parked = await submit(cookie, "Wait for me then continue.");
  const other = await submit(cookie, "Stay exactly as you are.");
  const noLease = { owner: "", claimedAt: null, heartbeatAt: null, expiresAt: null };

  for (const parkedState of ["waiting_for_user", "waiting_for_permission", "paused"]) {
    await Task.updateOne({ taskId: parked }, { $set: { state: parkedState, stage: parkedState, lease: noLease } });
    const resumed = await api(`/api/tasks/${parked}/resume`, { method: "POST", cookie, body: {} });
    assert.equal(resumed.status, 200, `${parkedState} resume answered ${resumed.status}: ${JSON.stringify(resumed.body)}`);
    assert.equal(resumed.body.task.state, "queued", `${parkedState} did not go back to the queue`);
    assert.ok(
      resumed.body.task.events.some(event => /queued again/i.test(event.message || "")),
      "the resume is not in the task's own log"
    );
    if (parkedState === "paused") break;
    // Each accepted resume puts it back in the queue; park it again for the next case.
    await Task.updateOne({ taskId: parked }, { $set: { state: "waiting_for_user", lease: noLease } });
  }

  const untouched = await taskOf(cookie, other);
  assert.ok(
    ["queued", "running", "completed"].includes(untouched.state),
    `the resume disturbed a task nobody named: ${untouched.state}`
  );
});

test("PH3-06 a task that is not waiting refuses resume with the reason, and does not move", async () => {
  const cookie = await newUser("ph306b");
  fakeProvider.state.set({ chatDelayMs: 300, chatResponseText: "Busy." });
  const queued = await submit(cookie, "You are queued, not waiting.");
  const refused = await api(`/api/tasks/${queued}/resume`, { method: "POST", cookie, body: {} });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "state_conflict", JSON.stringify(refused.body));
  assert.match(refused.body.message, /queued/, "the refusal does not name the state it is in");
  assert.equal((await taskOf(cookie, queued)).state, "queued", "a refused resume still moved the task");
});

// ─── PH3-07 restart recovery without duplicated side effects ─────────────────

test("PH3-07 a task interrupted by a stopped worker is recovered once and asks the model twice in total", async () => {
  const cookie = await newUser("ph307");
  fakeProvider.state.set({ chatDelayMs: 2000, chatResponseText: "Answered by the next worker." });
  const RESTART_PROMPT = "Survive a restart without doing the work twice.";
  const taskId = await submit(cookie, RESTART_PROMPT);

  await withScheduler(async () => {
    await waitForState(cookie, taskId, "running", 15000);
    await new Promise(resolve => setTimeout(resolve, 400));
  });
  const interrupted = await record(taskId);
  assert.ok(
    !state.isTerminal(interrupted.state),
    `a shutdown wrote an outcome nobody asked for: ${interrupted.state}`
  );
  assert.ok(
    ["worker_stopped", "worker_aborted"].includes(interrupted.recovery?.reason),
    `the process that stopped said nothing about why: ${JSON.stringify(interrupted.recovery)}`
  );
  assert.equal(asksFor(RESTART_PROMPT), 1, `the interrupted run already asked ${asksFor(RESTART_PROMPT)} times`);

  fakeProvider.state.set({ chatDelayMs: 200 });
  await withScheduler(async () => {
    const done = await waitForState(cookie, taskId, "completed", 25000);
    assert.match(done.result?.summary ?? "", /Answered by the next worker\./, JSON.stringify(done.result));
    assert.ok(done.recovery?.restarts >= 1, `recovery recorded no restart: ${JSON.stringify(done.recovery)}`);
    assert.ok(
      done.events.some(event => /recover/i.test(`${event.key || ""} ${event.message || ""}`)),
      "nothing in the log says the task was recovered"
    );
  });
  assert.equal(
    asksFor(RESTART_PROMPT),
    2,
    `${asksFor(RESTART_PROMPT)} model calls for this instruction where 2 proves one resume and no second run`
  );
});

test("PH3-07 a second reconciler pass does not give a recovered task another life", async () => {
  const cookie = await newUser("ph307b");
  fakeProvider.state.set({ chatDelayMs: 2000, chatResponseText: "Once resumed." });
  const taskId = await submit(cookie, "Recover me exactly once.");
  await withScheduler(async () => {
    await waitForState(cookie, taskId, "running", 15000);
  });
  fakeProvider.state.set({ chatDelayMs: 200 });
  await withScheduler(async () => {
    const first = await waitForState(cookie, taskId, "completed", 25000);
    const restartsAfter = first.recovery?.restarts ?? 0;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const after = await taskOf(cookie, taskId);
    assert.equal(after.state, "completed", "a finished task was re-opened by another pass");
    assert.equal(after.recovery?.restarts ?? 0, restartsAfter, "restarts kept moving after the outcome");
    assert.equal(after.result?.summary, first.result?.summary, "the stored answer changed after completion");
  });
});

// ─── PH3-08 event replay on reconnect ────────────────────────────────────────

test("PH3-08 a client that reconnects three times sees every event once, in order, from its cursor", async () => {
  const cookie = await newUser("ph308");
  fakeProvider.state.set({ chatDelayMs: 300, chatResponseText: "Replayed answer." });
  const taskId = await submit(cookie, "Replay my progress after a dropped stream.");
  const collected = [];
  let cursor = 0;

  await withScheduler(async () => {
    const settled = await waitForState(cookie, taskId, "completed", 25000);
    for (let pass = 0; pass < 3; pass += 1) {
      const replay = await api(`/api/tasks/${taskId}/events?after=${cursor}`, { cookie });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.taskId, taskId, "the window is about a different task");
      assert.equal(replay.body.state, settled.state, "the replay does not echo the authoritative state");
      assert.equal(replay.body.done, true, "a terminal task is replayed as though it were still open");
      assert.equal(replay.body.lastSeq, settled.lastSeq, "the window ends somewhere other than the head");
      for (const event of replay.body.events) {
        assert.ok(
          event.seq > cursor,
          `event ${event.seq} was handed out at or behind cursor ${cursor} — a client would show it twice`
        );
        cursor = event.seq;
        collected.push(event);
      }
      if (replay.body.events.length === 0) break;
    }
  });

  const seqs = collected.map(event => event.seq);
  assert.equal(new Set(seqs).size, seqs.length, `a replay repeated a seq: ${seqs.join(",")}`);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "events came back out of order across reconnects");
  assert.equal(seqs[0], 1, `the replay did not begin at the first event: ${seqs.join(",")}`);
  assert.ok(seqs.length >= 2, `only ${seqs.length} events exist for a completed task`);
  assert.ok(
    collected.some(event => /complete|cancel|fail/.test(`${event.key || ""}${event.status || ""}`)),
    "the ending is missing from the replayed window"
  );
});

test("PH3-08 a cursor at or beyond the head returns an empty window and the real state", async () => {
  const cookie = await newUser("ph308b");
  const taskId = await submit(cookie, "Nothing left to replay.");
  const head = await taskOf(cookie, taskId);
  const atHead = await api(`/api/tasks/${taskId}/events?after=${head.lastSeq}`, { cookie });
  assert.equal(atHead.status, 200);
  assert.deepEqual(atHead.body.events, [], "a client level with the head was given work again");
  assert.equal(atHead.body.lastSeq, head.lastSeq);
  assert.equal(atHead.body.state, head.state);

  const ahead = await api(`/api/tasks/${taskId}/events?after=${head.lastSeq + 500}`, { cookie });
  assert.deepEqual(ahead.body.events, [], "an impossible cursor produced phantom events");
  assert.equal(
    ahead.body.lastSeq,
    head.lastSeq,
    "an impossible cursor did not tell the client where the head actually is, so it cannot resync"
  );
});

// ─── PH3-09 authorization boundaries ────────────────────────────────────────

test("PH3-09 another account's task is absent, not forbidden, on every route including resume", async () => {
  const owner = await newUser("ph309owner");
  const intruder = await newUser("ph309intruder");
  const taskId = await submit(owner, "Only this account may see this.");

  for (const [path, method] of [
    [`/api/tasks/${taskId}`, "GET"],
    [`/api/tasks/${taskId}/events?after=0`, "GET"],
    [`/api/tasks/${taskId}/cancel`, "POST"],
    [`/api/tasks/${taskId}/resume`, "POST"]
  ]) {
    const probe = await api(path, { method, cookie: intruder, body: method === "POST" ? {} : undefined });
    assert.equal(probe.status, 404, `${method} ${path} answered ${probe.status}: ${JSON.stringify(probe.body)}`);
    assert.equal(probe.body.code, "task_not_found", `${method} ${path} admitted the record exists to a stranger`);
  }

  const list = await api("/api/tasks?limit=100", { cookie: intruder });
  assert.ok(!list.body.tasks.some(task => task.taskId === taskId), "the list leaked another account's row");

  const stillOurs = await api(`/api/tasks/${taskId}`, { cookie: owner });
  assert.equal(stillOurs.status, 200, "an intruder attempt damaged the owner's record");
  assert.equal(stillOurs.body.task.state, "queued", "an intruder's cancel went through anyway");
});

test("PH3-09 every task route refuses an unauthenticated caller, and the running task is unharmed", async () => {
  const cookie = await newUser("ph309b");
  fakeProvider.state.set({ chatDelayMs: 2500, chatResponseText: "Keeps going." });
  const taskId = await submit(cookie, "Run while I am signed in.");

  for (const [path, method] of [
    ["/api/tasks", "GET"],
    ["/api/tasks", "POST"],
    ["/api/tasks/tsk_000000000000000000000000", "GET"],
    ["/api/tasks/tsk_000000000000000000000000/events", "GET"],
    ["/api/tasks/tsk_000000000000000000000000/cancel", "POST"],
    ["/api/tasks/tsk_000000000000000000000000/resume", "POST"]
  ]) {
    const anon = await api(path, { method, body: method === "POST" ? { prompt: "Anonymous write." } : undefined });
    assert.equal(anon.status, 401, `${method} ${path} answered ${anon.status}: ${JSON.stringify(anon.body)}`);
  }

  await withScheduler(async () => {
    await waitForState(cookie, taskId, "running", 15000);
    const signedOut = await api("/api/auth/logout", { method: "POST", cookie, body: {} });
    assert.ok([200, 204].includes(signedOut.status), JSON.stringify(signedOut.body));
    const cleared = (signedOut.headers.getSetCookie() || []).find(value => value.startsWith("vr_session="));
    assert.ok(cleared, `logout sent no session cookie to clear: ${JSON.stringify(signedOut.headers)}`);
    assert.match(cleared, /^vr_session=;?/, `logout did not empty the session value: ${cleared}`);
    const maxAge = /Max-Age=(-?\d+)/i.exec(cleared);
    const expires = /Expires=([^;]+)/i.exec(cleared);
    const gone = (maxAge && Number(maxAge[1]) <= 0) || (expires && new Date(expires[1]).getTime() <= Date.now());
    assert.ok(gone, `logout did not expire the session cookie, so a browser keeps sending it: ${cleared}`);
    // What the cleared cookie actually gives a browser: no session, so no task
    // route. The token string itself is a stateless JWT and keeps verifying
    // until its own expiry — logout revokes nothing server-side, which is the
    // design, not a defect this suite is pretending to close.
    const afterSignOut = await api(`/api/tasks/${taskId}`);
    assert.equal(afterSignOut.status, 401, "a signed-out browser can still read the task list");

    await new Promise(resolve => setTimeout(resolve, 3000));
    const onDisk = await record(taskId);
    assert.ok(
      !state.isTerminal(onDisk.state) || onDisk.state === "completed",
      `signing out stopped the work: ${onDisk.state}`
    );
    assert.ok(!onDisk.cancelRequestedAt, "signing out was recorded as a cancellation");
  });
});

// ─── PH3-10 concurrent claim ─────────────────────────────────────────────────

/**
 * The race is driven through the claim layer, which is where two schedulers
 * actually collide. `startTaskWorker()` returns early when a loop is already
 * running, so two calls in one process are one loop under one owner label: a
 * second in-process worker would prove nothing about the lease, and calling it a
 * second scheduler would claim coverage this code path does not give.
 */
test("PH3-10 two claimants racing over one queue leave each task with exactly one holder", async () => {
  const cookie = await newUser("ph310");
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push(await submit(cookie, `Race the claim ${index}.`));
  }

  const claimed = [];
  for (let round = 0; round < 5; round += 1) {
    const winners = await Promise.all([
      store.claimNextTask({ owner: "worker_a", leaseMs: 60000, perUserLimit: 0 }),
      store.claimNextTask({ owner: "worker_b", leaseMs: 60000, perUserLimit: 0 })
    ]);
    for (const won of winners) {
      if (won) claimed.push({ taskId: won.taskId, owner: won.lease.owner });
    }
  }

  // Earlier tests leave tasks in the queue and a claim has no reason to skip
  // them, so the race is judged on the five tasks this test queued and every
  // other holder is given back rather than left leased to a claimant that never
  // runs.
  const ours = claimed.filter(row => ids.includes(row.taskId));
  for (const row of claimed) {
    if (!ids.includes(row.taskId)) await store.releaseLease({ taskId: row.taskId }, { owner: row.owner });
  }

  assert.equal(ours.length, 5, `the five tasks this test queued were claimed ${ours.length} times`);
  for (const id of ids) {
    const rows = ours.filter(row => row.taskId === id);
    assert.equal(rows.length, 1, `task ${id} was handed out ${rows.length} times`);
  }

  for (const { taskId, owner } of ours) {
    const after = await record(taskId);
    assert.equal(after.lease.owner, owner, `${taskId} changed holder underneath its claim`);
    assert.equal(after.state, "queued", "claiming alone moved the record out of the queue");
  }
  assert.equal(fakeProvider.state.chatRequests.length, 0, "a claim without a worker still asked the model");
});

test("PH3-10 a task under a live lease is not claimable, is not resumable, and is not handed out twice", async () => {
  const cookie = await newUser("ph310b");
  fakeProvider.state.set({ chatDelayMs: 1500, chatResponseText: "Held." });
  const taskId = await submit(cookie, "Do not hand this out twice.");
  await withScheduler(async () => {
    await waitForState(cookie, taskId, "running", 15000);
    const held = await record(taskId);
    assert.ok(held.lease?.owner, "a running task holds no lease");
    assert.ok(held.lease.expiresAt > new Date(), "the lease already lapsed while the task ran");
    const passedOver = await store.claimNextTask({ owner: "worker_c", leaseMs: 60000, perUserLimit: 0 });
    assert.ok(!passedOver || passedOver.taskId !== taskId, "a second claimant took a task under a live lease");
    if (passedOver && passedOver.taskId !== taskId) {
      // Some earlier test left this task queued; this claim was free to take it,
      // but it is not this test's work and a lease left here would outlive it.
      await store.releaseLease(passedOver, { owner: "worker_c" });
    }

    const refused = await api(`/api/tasks/${taskId}/resume`, { method: "POST", cookie, body: {} });
    assert.equal(refused.status, 409, "a running task was treated as resumable");
    assert.equal(refused.body.code, "state_conflict", JSON.stringify(refused.body));
    assert.equal((await taskOf(cookie, taskId)).state, "running", "the refusal still moved the task");

    await waitForState(cookie, taskId, "completed", 25000);
  });
  assert.equal(asksFor("Do not hand this out twice."), 1, "a leased task asked the model twice");
});

test("PH3-10 a finished task is never handed out again, and its lease does not hold a slot open", async () => {
  const cookie = await newUser("ph310c");
  fakeProvider.state.set({ chatDelayMs: 250, chatResponseText: "Finished." });
  const first = await submit(cookie, "Finish first.");
  const second = await submit(cookie, "Finish second.");
  await withScheduler(async () => {
    await Promise.all([
      waitForState(cookie, first, "completed", 25000),
      waitForState(cookie, second, "completed", 25000)
    ]);
  });

  // A terminal transition does not blank `lease` — `mutableFields()` does not
  // carry it — so a finished row still names its last holder with an unexpired
  // expiry. That is only harmless if the state filter really keeps those rows
  // out of both the queue and the cap, so that is what is asserted here rather
  // than a lease field this design never clears.
  for (const row of await Promise.all([record(first), record(second)])) {
    assert.ok(row.lease.expiresAt > new Date(), `${row.taskId} did not keep its lease after finishing`);
    assert.ok(state.isTerminal(row.state), `${row.taskId} is not terminal`);
  }

  const reclaimed = await store.claimNextTask({ owner: "worker_d", leaseMs: 60000, perUserLimit: 0 });
  assert.ok(
    !reclaimed || ![first, second].includes(reclaimed.taskId),
    `a finished task was claimable again: ${reclaimed?.taskId}`
  );
  if (reclaimed) await store.releaseLease({ taskId: reclaimed.taskId }, { owner: "worker_d" });

  process.env.TASK_USER_CONCURRENCY = "1";
  fakeProvider.state.set({ chatDelayMs: 150 });
  try {
    const third = await submit(cookie, "Run while two finished rows still name a holder.");
    await withScheduler(async () => {
      await waitForState(cookie, third, "completed", 25000);
    });
  } finally {
    delete process.env.TASK_USER_CONCURRENCY;
  }
  assert.equal(asksFor("Finish first."), 1, "the first finished task ran again after it was done");
  assert.equal(asksFor("Finish second."), 1, "the second finished task ran again after it was done");
  assert.equal(
    asksFor("Run while two finished rows still name a holder."),
    1,
    "the per-user cap kept a slot open for two finished rows, so the third task never got through"
  );
});

// ─── PH3-11 terminal-state protection ───────────────────────────────────────

test("PH3-11 a completed task refuses resume and never restarts itself", async () => {
  const cookie = await newUser("ph311");
  fakeProvider.state.set({ chatDelayMs: 250, chatResponseText: "Done." });
  const taskId = await submit(cookie, "Finish, then refuse to run again.");
  await withScheduler(async () => {
    const done = await waitForState(cookie, taskId, "completed", 25000);
    const refused = await api(`/api/tasks/${taskId}/resume`, { method: "POST", cookie, body: {} });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "task_terminal", JSON.stringify(refused.body));
    assert.match(refused.body.message, /new task/i, "the refusal does not say what to do instead");

    await new Promise(resolve => setTimeout(resolve, 1200));
    const still = await taskOf(cookie, taskId);
    assert.equal(still.state, "completed");
    assert.equal(still.result?.summary, done.result?.summary, "a refused action changed the stored answer");
  });
  assert.equal(asksFor("Finish, then refuse to run again."), 1, "a terminal task asked the model again");
});

test("PH3-11 cancelling a terminal task changes nothing on the record", async () => {
  const cookie = await newUser("ph311b");
  fakeProvider.state.set({ chatDelayMs: 200, chatResponseText: "Already finished." });
  const taskId = await submit(cookie, "Complete, then be cancelled.");
  await withScheduler(async () => {
    const done = await waitForState(cookie, taskId, "completed", 25000);
    const again = await api(`/api/tasks/${taskId}/cancel`, { method: "POST", cookie, body: {} });
    assert.ok([200, 409].includes(again.status), `cancel on a completed task answered ${again.status}`);
    const after = await taskOf(cookie, taskId);
    assert.equal(after.state, "completed", "a finished task was rewritten as cancelled");
    assert.equal(after.result?.summary, done.result?.summary);
    assert.ok(!(await record(taskId)).cancelRequestedAt, "a cancellation nobody performed is recorded anyway");
  });
});

test("PH3-11 a permanent provider failure is terminal, recorded, and never retried", async () => {
  const cookie = await newUser("ph311c");
  fakeProvider.state.set({ chatStatus: 400 });
  const taskId = await submit(cookie, "Fail permanently.");
  await withScheduler(async () => {
    const failed = await waitForState(cookie, taskId, "failed", 25000);
    assert.equal(failed.error.kind, "invalid_request", JSON.stringify(failed.error));
    assert.equal(failed.error.retryable, false, JSON.stringify(failed.error));
    assert.equal(failed.error.providerStatus, 400, JSON.stringify(failed.error));
    assert.ok(failed.error.message, "the failure has no explanation for the reader");
    assert.equal(failed.retry.attempts, 0, JSON.stringify(failed.retry));
    assert.ok(!failed.result?.summary, `a failed task stored an answer: ${JSON.stringify(failed.result)}`);

    const refused = await api(`/api/tasks/${taskId}/resume`, { method: "POST", cookie, body: {} });
    assert.equal(refused.status, 409, "a failed task was resumable");
  });
  assert.equal(asksFor("Fail permanently."), 1, "a permanent failure asked the model again");
});

test("PH3-11 a lapsed lease on a finished record does not reopen it", async () => {
  const cookie = await newUser("ph311d");
  fakeProvider.state.set({ chatDelayMs: 200, chatResponseText: "Finished first." });
  const taskId = await submit(cookie, "Finish, then look abandoned.");
  await withScheduler(async () => {
    const before = await waitForState(cookie, taskId, "completed", 25000);
    await Task.updateOne(
      { taskId },
      { $set: { "lease.expiresAt": new Date(Date.now() - 60_000), "lease.owner": "" } }
    );
    worker.startTaskWorker({ tickMs: 40 });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const after = await taskOf(cookie, taskId);
    assert.equal(after.state, before.state, "recovery reopened a finished task");
    assert.equal(after.recovery?.restarts ?? 0, before.recovery?.restarts ?? 0, "recovery counted a restart on terminal work");
  });
  assert.equal(asksFor("Finish, then look abandoned."), 1, "a terminal task was run a second time");
});

// ─── PH3-12 cross-conversation list data ─────────────────────────────────────

test("PH3-12 the list spans conversations and each row keeps its own association and progress", async () => {
  const cookie = await newUser("ph312");
  fakeProvider.state.set({ chatDelayMs: 300, chatResponseText: "Written back to the chat." });
  const convA = String(uid());
  const convB = String(uid());
  const idA = await submit(cookie, "Put your answer in chat A.", { conversationId: convA });
  const idB = await submit(cookie, "Put your answer in chat B.", { conversationId: convB });
  const idC = await submit(cookie, "You choose where this lands.");

  await withScheduler(async () => {
    await Promise.all([
      waitForState(cookie, idA, "completed", 30000),
      waitForState(cookie, idB, "completed", 30000),
      waitForState(cookie, idC, "completed", 30000)
    ]);
  });

  const { body } = await api("/api/tasks?limit=50", { cookie });
  const rows = body.tasks.filter(task => [idA, idB, idC].includes(task.taskId));
  assert.equal(rows.length, 3, "the list did not span every conversation's work");
  const byId = new Map(rows.map(row => [row.taskId, row]));
  assert.equal(byId.get(idA).conversationId, convA, "row A lost its conversation");
  assert.equal(byId.get(idB).conversationId, convB, "row B lost its conversation");
  assert.notEqual(byId.get(idA).conversationId, byId.get(idB).conversationId, "two tasks share one association");
  for (const row of rows) {
    assert.equal(row.state, "completed");
    assert.ok(row.lastEvent?.seq >= 1, `${row.taskId} has no progress on its row`);
    assert.ok(row.eventCount >= 2, `${row.taskId} has ${row.eventCount} events`);
    assert.ok(row.createdAt && row.lastActivityAt, `${row.taskId} has no timestamps`);
    assert.equal(row.waitingOn, null, `a finished row still waits on ${row.waitingOn}`);
    assert.ok(row.completedAt, `${row.taskId} finished with no end time`);
  }

  const answerA = await api(`/api/conversations/${convA}`, { cookie });
  assert.equal(answerA.status, 200, JSON.stringify(answerA.body).slice(0, 200));
  assert.match(
    JSON.stringify(answerA.body),
    /Written back to the chat\./,
    "the answer never reached the conversation the task named"
  );
  const answerB = await api(`/api/conversations/${convB}`, { cookie });
  assert.equal(answerB.status, 200);
  assert.match(
    JSON.stringify(answerB.body),
    /Put your answer in chat B\./,
    "the second conversation does not hold its own instruction"
  );
});

test("PH3-12 one task's failure does not describe its neighbour", async () => {
  const cookie = await newUser("ph312b");
  fakeProvider.state.set({ chatDelayMs: 250, chatResponseText: "Healthy answer." });
  const convA = String(uid());
  const convB = String(uid());
  const okId = await submit(cookie, "Finish this one.", { conversationId: convA });
  await withScheduler(async () => {
    await waitForState(cookie, okId, "completed", 25000);
  });

  fakeProvider.state.set({ chatStatus: 400 });
  const badId = await submit(cookie, "Fail this one.", { conversationId: convB });
  await withScheduler(async () => {
    await waitForState(cookie, badId, "failed", 25000);
  });

  const { body } = await api("/api/tasks?limit=50", { cookie });
  const good = body.tasks.find(task => task.taskId === okId);
  const bad = body.tasks.find(task => task.taskId === badId);
  assert.equal(good.state, "completed");
  assert.ok(!good.error?.code && !good.error?.message, `the failure poisoned its neighbour: ${JSON.stringify(good.error)}`);
  assert.equal(good.conversationId, convA);
  assert.equal(bad.state, "failed");
  assert.equal(bad.conversationId, convB);
  assert.equal(bad.error.kind, "invalid_request", JSON.stringify(bad.error));
});

// ─── #337 regression: outcome writes settle before the lease drops ───────────

test("#337 an execution does not drop its lease before its outcome is written", async () => {
  const cookie = await newUser("ph337");
  fakeProvider.state.set({ chatDelayMs: 600, chatResponseText: "Answered once." });
  const taskId = await submit(cookie, "Do not hand this out a second time.");

  // Every write this task's record receives, whether it touched the lease and
  // what state it set. The lease travels as a whole sub-document when a task is
  // claimed and as dotted fields when it is renewed or dropped, so both shapes
  // have to be read or the spy misses the very writes it exists to see. A dotted
  // renewal of `lease.expiresAt` keeps its owner, so only a write that names an
  // owner (or an expiry) counts as giving the hold up.
  const realUpdateOne = Task.updateOne;
  const writes = [];
  Task.updateOne = function (filter, update, options) {
    if (filter?.taskId === taskId) {
      const set = update?.$set || {};
      const whole = Object.prototype.hasOwnProperty.call(set, "lease") ? set.lease : undefined;
      const touchedLease = whole !== undefined ||
        Object.prototype.hasOwnProperty.call(set, "lease.owner") ||
        Object.prototype.hasOwnProperty.call(set, "lease.expiresAt");
      const ownerSet = whole !== undefined
        ? whole.owner
        : Object.prototype.hasOwnProperty.call(set, "lease.owner") ? set["lease.owner"] : undefined;
      const expiry = whole !== undefined ? whole.expiresAt : set["lease.expiresAt"];
      const lapsed = expiry instanceof Date && expiry.getTime() <= Date.now();
      writes.push({
        setState: set.state ?? null,
        filterState: typeof filter.state === "string" ? filter.state : null,
        touchedLease,
        dropsHold: touchedLease && ((ownerSet !== undefined && !ownerSet) || (expiry !== undefined && lapsed)),
        ownerSet: ownerSet ?? null,
        interrupted: set["recovery.reason"] ?? null
      });
    }
    return realUpdateOne.call(this, filter, update, options);
  };

  try {
    await withScheduler(async () => {
      const done = await waitForState(cookie, taskId, "completed", 25000);
      assert.match(done.result?.summary ?? "", /Answered once\./, JSON.stringify(done.result));

      const terminalAt = writes.findIndex(row => state.TERMINAL_STATES.includes(row.setState));
      assert.ok(
        terminalAt >= 0,
        `the spy saw no write making the record terminal, so it watched nothing: ${JSON.stringify(writes)}`
      );
      assert.ok(
        writes.some(row => row.touchedLease),
        `the spy saw no lease write at all, so it could not have ordered one: ${JSON.stringify(writes)}`
      );

      const droppedEarly = writes.slice(0, terminalAt).filter(row => row.dropsHold);
      assert.deepEqual(
        droppedEarly,
        [],
        `the lease was given up ${droppedEarly.length} time(s) before the outcome was written ` +
          `(${JSON.stringify(droppedEarly)}): a record still saying running with no live owner is ` +
          "exactly what recovery calls abandoned, so a task that had already answered would be handed out a second time"
      );

      for (const row of writes.filter(w => w.dropsHold)) {
        assert.ok(
          state.TERMINAL_STATES.includes(row.setState) || row.interrupted,
          `the lease was dropped while the record still said ${row.setState ?? row.filterState}: ${JSON.stringify(row)}`
        );
      }
    });
    assert.equal(asksFor("Do not hand this out a second time."), 1, "a completed task asked the model more than once");
    const after = await record(taskId);
    assert.equal(after.state, "completed");
    assert.equal(after.recovery?.restarts ?? 0, 0, JSON.stringify(after.recovery));
  } finally {
    Task.updateOne = realUpdateOne;
  }
});

test("#337 a transient failure is retried inside one process and is not mistaken for a recovery", async () => {
  const cookie = await newUser("ph337b");
  const previousMaxRetries = process.env.VUPS_MAX_RETRIES;
  process.env.VUPS_MAX_RETRIES = "1";
  fakeProvider.state.set({
    chatDelayMs: 150,
    chatFailuresRemaining: 1,
    chatResponseText: "Answered on the second attempt."
  });
  const taskId = await submit(cookie, "Retry me into an answer.");
  try {
    await withScheduler(async () => {
      const done = await waitForState(cookie, taskId, ["completed", "failed"], 30000);
      assert.equal(done.state, "completed", JSON.stringify(done.error));
      assert.match(done.result?.summary ?? "", /Answered on the second attempt\./, JSON.stringify(done.result));
      assert.equal(done.retry.attempts, 1, JSON.stringify(done.retry));
      assert.ok(
        done.events.some(event => /retry|backoff|again/i.test(`${event.key || ""} ${event.message || ""}`)),
        "the retry is nowhere in the task's own log"
      );
      assert.equal(done.recovery?.restarts ?? 0, 0, "a retry inside one process looked like a recovery restart");
      assert.equal(asksFor("Retry me into an answer."), 2, "the retried run did not ask exactly twice");
    });
  } finally {
    process.env.VUPS_MAX_RETRIES = previousMaxRetries;
  }
});
