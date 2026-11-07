import assert from "node:assert/strict";
import { after, test } from "node:test";

// Phase 3 — the queue: who may run, how many at once, and what happens when two
// schedulers reach for the same task. A durable task system that lets one user's
// backlog fill the whole worker pool is not chat-independent in any useful sense:
// everyone else waits. So the scheduler needs a per-owner cap, fairness across
// owners, and a claim that cannot hand one task to two processes.
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
// A failing model in a queue test has to fail once and stay failed; patience
// belongs to the retry suite, not here.
process.env.VUPS_MAX_RETRIES = "0";
process.env.TASK_WORKER_DISABLED = "1";
delete process.env.TASK_USER_CONCURRENCY;
delete process.env.TASK_WORKER_CONCURRENCY;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_task_queue_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const connectToDatabase = (await import("./db.js")).default;
const { default: Task } = await import("./task.js");
const state = await import("./taskState.js");
const store = await import("./taskStore.js");
const worker = await import("./taskWorker.js");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
// Several tests drive the store directly, before any HTTP request would have
// opened the connection.
await connectToDatabase();

// The worker is started only by the tests that mean to drive it. A running
// scheduler would claim the hand-written queue rows the claim tests rely on.
// `tickMs` is how often it looks for work: a very short tick makes overlapping
// claim passes likely, which is what the per-user cap has to survive.
async function withScheduler(run, { tickMs = 40 } = {}) {
  worker.startTaskWorker({ tickMs });
  try {
    return await run();
  } finally {
    await worker.stopTaskWorker();
  }
}

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
  return `queue${Date.now()}-${counter}@example.com`;
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

async function newUser() {
  fakeProvider.state.reset();
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Queue Tester", email: uniqueEmail(), password: "correct-horse-battery", acceptTerms: true }
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

async function waitForState(cookie, taskId, wanted, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await taskOf(cookie, taskId);
    if ((Array.isArray(wanted) ? wanted : [wanted]).includes(last.state)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`task ${taskId} never reached ${JSON.stringify(wanted)}; last state ${last?.state}`);
}

async function waitForAllTerminal(cookie, taskIds, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let tasks = [];
  while (Date.now() < deadline) {
    tasks = await Promise.all(taskIds.map(id => taskOf(cookie, id)));
    if (tasks.every(task => state.isTerminal(task.state))) return tasks;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`tasks never all ended: ${JSON.stringify(tasks.map(task => [task.taskId, task.state]))}`);
}

const uid = () => new mongoose.Types.ObjectId();

/**
 * Queued tasks created straight on the record, with an explicit creation order.
 * The scheduler sorts on createdAt alone, and two tasks created in the same
 * millisecond have no defined order, so a test that claims to show first-in
 * first-out has to set the clock rather than hope the inserts land apart.
 */
async function queueTasks(userId, count, sinceMs = Date.now()) {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const task = await store.createTask({ userId, description: `Queued task ${index + 1} for the scheduler.` });
    await Task.updateOne({ taskId: task.taskId }, { $set: { createdAt: new Date(sinceMs + index * 1000) } });
    created.push(task.taskId);
  }
  return created;
}

/** What the table says about how much of one user's work is held right now. */
function liveLeaseCount(userId) {
  return Task.countDocuments({
    userId,
    state: { $nin: [...state.TERMINAL_STATES] },
    "lease.expiresAt": { $gte: new Date() }
  });
}

async function removeTasks(taskIds) {
  for (const taskId of taskIds) await Task.deleteOne({ taskId });
}

function env(values, run) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  });
  try {
    return run();
  } finally {
    previous.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

test("4.1 the per-owner cap is configurable, bounded, and a bad value cannot disable fairness", () => {
  assert.equal(worker.taskUserConcurrency(), 2, "the documented default is two tasks per user");
  const cases = [
    ["0", 2],
    ["-4", 2],
    ["nonsense", 2],
    ["", 2],
    ["3", 3],
    ["10", 10]
  ];
  for (const [value, wanted] of cases) {
    const actual = env({ TASK_USER_CONCURRENCY: value }, () => worker.taskUserConcurrency());
    assert.equal(actual, wanted, `TASK_USER_CONCURRENCY=${JSON.stringify(value)} must read as ${wanted}`);
  }
});

test("4.2 a claim skips an owner already at its cap, so one backlog cannot take the pool", async () => {
  const heavy = uid();
  const light = uid();
  const start = Date.now();
  const [first, second, third] = await queueTasks(heavy, 3, start);
  // The other user's task is deliberately the newest thing in the queue: a plain
  // FIFO claim would leave it waiting behind the whole backlog.
  const [other] = await queueTasks(light, 1, start + 4000);
  try {
    const a = await store.claimNextTask({ owner: "worker_a", leaseMs: 60000, perUserLimit: 2 });
    const b = await store.claimNextTask({ owner: "worker_a", leaseMs: 60000, perUserLimit: 2 });
    assert.equal(a?.taskId, first, JSON.stringify(a));
    assert.equal(b?.taskId, second, JSON.stringify(b));
    assert.equal(await liveLeaseCount(heavy), 2);

    const crossed = await store.claimNextTask({ owner: "worker_b", leaseMs: 60000, perUserLimit: 2 });
    assert.equal(crossed?.taskId, other, "a capped owner's older task must not be claimed over another user's");
    assert.equal(crossed.userId.toString(), light.toString());

    // With both owners at cap there is nothing left for a third scheduler.
    const nothing = await store.claimNextTask({ owner: "worker_c", leaseMs: 60000, perUserLimit: 2 });
    assert.equal(nothing, null, JSON.stringify(nothing));

    // A released task is unfinished work, so it goes back to the head of its
    // owner's queue and the cap counts only what is held: freeing both slots
    // lets the same backlog move again in creation order, and stops the next
    // task at the cap rather than stranding it.
    await store.releaseLease({ taskId: first }, { owner: "worker_a" });
    await store.releaseLease({ taskId: second }, { owner: "worker_a" });
    const drained = [
      await store.claimNextTask({ owner: "worker_c", leaseMs: 60000, perUserLimit: 2 }),
      await store.claimNextTask({ owner: "worker_c", leaseMs: 60000, perUserLimit: 2 })
    ];
    assert.deepEqual(drained.map(task => task?.taskId), [first, second]);
    const waits = await store.claimNextTask({ owner: "worker_d", leaseMs: 60000, perUserLimit: 2 });
    assert.equal(waits, null, `the rest of a capped backlog waits, it is not skipped: ${JSON.stringify(waits)}`);

    // A slot freed by the other user is taken by that user's own task, never by
    // the older capped backlog. The waiting task keeps no lease and stays queued
    // until its owner drops below the cap, which is what 4.6 proves end to end.
    await store.releaseLease({ taskId: other }, { owner: "worker_b" });
    const reclaimed = await store.claimNextTask({ owner: "worker_d", leaseMs: 60000, perUserLimit: 2 });
    assert.equal(reclaimed?.taskId, other, `a capped backlog must not take a freed slot: ${JSON.stringify(reclaimed)}`);
    assert.equal(reclaimed.userId.toString(), light.toString());
    const waiting = await Task.findOne({ taskId: third }).lean();
    assert.equal(waiting?.state, "queued", JSON.stringify(waiting));
    assert.ok(!waiting?.lease?.owner, `a task waiting at the cap holds nothing: ${JSON.stringify(waiting?.lease)}`);
  } finally {
    await removeTasks([first, second, third, other]);
  }
});

test("4.3 a claim still takes the oldest task first when no cap applies", async () => {
  const one = uid();
  const [first, second] = await queueTasks(one, 2);
  try {
    const a = await store.claimNextTask({ owner: "worker_a", leaseMs: 60000 });
    const b = await store.claimNextTask({ owner: "worker_a", leaseMs: 60000 });
    assert.deepEqual([a?.taskId, b?.taskId], [first, second]);
  } finally {
    await removeTasks([first, second]);
  }
});

test("4.4 two schedulers racing for the same queue never get the same task", async () => {
  const ids = [];
  for (const user of [uid(), uid(), uid()]) ids.push(...(await queueTasks(user, 2)));
  try {
    // Eight claims in the same tick, three worker identities, six tasks: every
    // claim is a separate process reading the same table.
    const owners = ["worker_1", "worker_2", "worker_3", "worker_1", "worker_2", "worker_3", "worker_1", "worker_2"];
    const results = await Promise.all(owners.map(owner => store.claimNextTask({ owner, leaseMs: 60000 })));
    const claimed = results.filter(Boolean).map(task => task.taskId);
    assert.equal(new Set(claimed).size, claimed.length, `a task was claimed twice: ${JSON.stringify(claimed)}`);
    assert.equal(claimed.length, 6, `six queued tasks should each be claimed once, got ${claimed.length}`);
    // The record has to agree with the caller that got the answer back: the
    // owner written on the row is the owner the claim named, for every task.
    const pairs = results
      .map((task, index) => ({ owner: owners[index], taskId: task?.taskId }))
      .filter(pair => pair.taskId);
    const rows = await Task.find({ taskId: { $in: pairs.map(pair => pair.taskId) } }).lean();
    const ownerByTask = new Map(rows.map(row => [row.taskId, row.lease.owner]));
    for (const pair of pairs) {
      assert.equal(ownerByTask.get(pair.taskId), pair.owner, `${pair.taskId} was claimed by ${pair.owner} but is held by ${ownerByTask.get(pair.taskId)}`);
    }
  } finally {
    await removeTasks(ids);
  }
});

test("4.5 a task under a live lease is not claimable, and only a lapsed lease makes it available", async () => {
  const [taskId] = await queueTasks(uid(), 1);
  try {
    const held = await store.claimNextTask({ owner: "holder", leaseMs: 60000 });
    assert.equal(held.taskId, taskId);
    const thief = await store.claimNextTask({ owner: "thief", leaseMs: 60000 });
    assert.equal(thief, null, "a live lease is not an invitation");
    assert.equal((await Task.findOne({ taskId }).lean()).lease.owner, "holder");

    await Task.updateOne({ taskId }, { $set: { "lease.expiresAt": new Date(Date.now() - 1000) } });
    const taken = await store.claimNextTask({ owner: "thief", leaseMs: 60000 });
    assert.equal(taken?.taskId, taskId, JSON.stringify(taken));
    assert.equal((await Task.findOne({ taskId }).lean()).lease.owner, "thief");
  } finally {
    await removeTasks([taskId]);
  }
});

test("4.6 the worker runs at most the per-user cap of one user's tasks at once, then finishes them all", async () => {
  const cookie = await newUser();
  // A 1 ms tick is not a typo: claim passes overlap on purpose here, because a
  // cap that only holds when the scheduler happens to run one pass at a time is
  // not a cap.
  await withScheduler(async () => {
    process.env.TASK_WORKER_CONCURRENCY = "4";
    process.env.TASK_USER_CONCURRENCY = "2";
    fakeProvider.state.set({ chatDelayMs: 150, chatResponseText: "Done." });
    const ids = [];
    try {
      for (let index = 0; index < 5; index += 1) ids.push(await submit(cookie, `Queue task ${index + 1}, run it and answer.`));

      const userId = (await Task.findOne({ taskId: ids[0] }).lean()).userId;
      let peakRunning = 0;
      let peakHeld = 0;
      const deadline = Date.now() + 16000;
      while (Date.now() < deadline) {
        peakRunning = Math.max(peakRunning, worker.runningTaskIds().length);
        peakHeld = Math.max(peakHeld, await liveLeaseCount(userId));
        const tasks = await Promise.all(ids.map(id => taskOf(cookie, id)));
        if (tasks.every(task => state.isTerminal(task.state))) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const finished = await waitForAllTerminal(cookie, ids);

      // The durable check is the one that matters: whatever a single process
      // believes, the table must never show more than the cap being held.
      assert.equal(peakHeld, 2, `the per-user cap held: peak concurrently held was ${peakHeld}`);
      assert.ok(peakRunning <= 2, `this process ran more than the cap locally: ${peakRunning}`);
      assert.equal(finished.filter(task => task.state === "completed").length, 5, JSON.stringify(finished.map(t => t.state)));
    } finally {
      // Rows left behind here are older than the next test's rows, and the
      // store-level claim tests read the whole queue, so they belong to nobody.
      await removeTasks(ids);
      delete process.env.TASK_WORKER_CONCURRENCY;
      delete process.env.TASK_USER_CONCURRENCY;
    }
  }, { tickMs: 1 });
});

test("4.7 queued tasks reach independent outcomes: one model failure does not poison its neighbours", async () => {
  const cookie = await newUser();
  await withScheduler(async () => {
    process.env.TASK_USER_CONCURRENCY = "3";
    process.env.TASK_WORKER_CONCURRENCY = "3";
    fakeProvider.state.set({ failModel: "fake-model-pro", failModelStatus: 429, chatResponseText: "Answered fine." });
    const good = [
      await submit(cookie, "First of the healthy tasks, answer it."),
      await submit(cookie, "Second of the healthy tasks, answer it.")
    ];
    const broken = await submit(cookie, "This one asks for a model that is out of credits.", { model: "fake-model-pro" });

    try {
      const goodTasks = await waitForAllTerminal(cookie, good);
      const brokenTask = await waitForState(cookie, broken, "failed");
      assert.deepEqual(goodTasks.map(task => task.state), ["completed", "completed"]);
      assert.equal(brokenTask.state, "failed");
      assert.ok(brokenTask.error?.code, JSON.stringify(brokenTask.error));
      // Each task kept its own record: the healthy ones asked only their own model.
      const asked = await Task.find({ taskId: { $in: good } }).lean();
      assert.deepEqual(asked.map(task => task.modelRequests.map(row => row.model)).flat(), ["fake-model-mini", "fake-model-mini"]);
      assert.equal(fakeProvider.state.chatRequests.filter(row => row.body.model === "fake-model-pro").length, 1);
    } finally {
      await removeTasks([...good, broken]);
      fakeProvider.state.reset();
      delete process.env.TASK_USER_CONCURRENCY;
      delete process.env.TASK_WORKER_CONCURRENCY;
    }
  });
});

test("4.8 cancelling one running task leaves the others running and the scheduler still working", async () => {
  const cookie = await newUser();
  await withScheduler(async () => {
    process.env.TASK_USER_CONCURRENCY = "3";
    process.env.TASK_WORKER_CONCURRENCY = "3";
    fakeProvider.state.set({ chatDelayMs: 900, chatResponseText: "Answered after a wait." });
    const kept = await submit(cookie, "Keep running while the other one is cancelled.");
    const doomed = await submit(cookie, "Get cancelled in the middle.");
    let next = null;

    try {
      await waitForState(cookie, doomed, ["planning", "running"], 8000);
      await waitForState(cookie, kept, ["planning", "running"], 8000);
      const cancelled = await api(`/api/tasks/${doomed}/cancel`, { method: "POST", cookie });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

      const cancelledTask = await waitForState(cookie, doomed, "cancelled");
      const keptTask = await waitForState(cookie, kept, "completed");
      assert.equal(cancelledTask.state, "cancelled");
      assert.equal(keptTask.state, "completed");
      assert.match(keptTask.result?.summary ?? "", /Answered after a wait\./);

      // The scheduler is still alive afterwards: a new submission runs.
      fakeProvider.state.set({ chatDelayMs: 0, chatResponseText: "Scheduled again." });
      next = await submit(cookie, "A task submitted after the cancellation.");
      const nextTask = await waitForState(cookie, next, "completed");
      assert.match(nextTask.result?.summary ?? "", /Scheduled again\./);
    } finally {
      await removeTasks(next ? [kept, doomed, next] : [kept, doomed]);
      fakeProvider.state.reset();
      delete process.env.TASK_USER_CONCURRENCY;
      delete process.env.TASK_WORKER_CONCURRENCY;
    }
  });
});

test("4.9 a lease renewal tells the holder whether it still holds the task", async () => {
  const user = uid();
  const [taskId] = await queueTasks(user, 1);
  try {
    const claimed = await store.claimNextTask({ owner: "worker_a", leaseMs: 60000 });
    assert.equal(claimed?.taskId, taskId, JSON.stringify(claimed));
    assert.equal(
      await store.heartbeatTask(claimed, { owner: "worker_a", leaseMs: 60000 }),
      true,
      "the process that holds a task must be told its renewal landed"
    );

    // Another process takes the task over. From here on, this one's renewals
    // match nothing, and silence about that is what lets two workers run one
    // task at the same time.
    await Task.updateOne({ taskId }, { $set: { "lease.owner": "worker_b", "lease.expiresAt": new Date(Date.now() + 60000) } });
    assert.equal(
      await store.heartbeatTask(claimed, { owner: "worker_a", leaseMs: 60000 }),
      false,
      "a renewal by a process that no longer holds the task must say so"
    );
    const after = await Task.findOne({ taskId }).lean();
    assert.equal(after.lease.owner, "worker_b", `the lost holder moved the lease: ${JSON.stringify(after.lease)}`);
  } finally {
    await removeTasks([taskId]);
  }
});

test("4.10 only the holder may interrupt a task, and a finished task is never interrupted", async () => {
  const user = uid();
  const [mine, theirs] = await queueTasks(user, 2);
  try {
    const held = await store.claimNextTask({ owner: worker.workerId(), leaseMs: 60000 });
    assert.equal(held?.taskId, mine, JSON.stringify(held));
    await worker.markTaskInterrupted(held, "worker_stopped");
    const dropped = await Task.findOne({ taskId: mine }).lean();
    assert.equal(dropped.lease.owner, "", "a worker must still be able to drop its own claim");
    assert.ok(dropped.lease.expiresAt.getTime() < Date.now(), "an interrupted task is immediately recoverable");
    assert.equal(dropped.recovery.reason, "worker_stopped", JSON.stringify(dropped.recovery));

    // A terminal record is history. An interrupt that arrives after it finished
    // leaves it exactly as it was — state, recovery and the lease it ended with.
    const endedAt = (await Task.findOne({ taskId: mine }).lean()).recovery.interruptedAt;
    await Task.updateOne({ taskId: mine }, { $set: { state: "completed", "lease.owner": worker.workerId(), "lease.expiresAt": new Date(Date.now() + 60000) } });
    await worker.markTaskInterrupted({ taskId: mine, state: "running" }, "worker_aborted");
    const finished = await Task.findOne({ taskId: mine }).lean();
    assert.equal(finished.state, "completed", "interrupting a completed task must not change its state");
    assert.equal(finished.recovery.interruptedAt?.getTime(), endedAt.getTime(), `a late interrupt rewrote its history: ${JSON.stringify(finished.recovery)}`);
    assert.equal(finished.recovery.reason, "worker_stopped", JSON.stringify(finished.recovery));
    assert.equal(finished.recovery.stateBeforeInterruption, "queued", JSON.stringify(finished.recovery));
    assert.equal(finished.lease.owner, worker.workerId(), `a late interrupt moved the lease: ${JSON.stringify(finished.lease)}`);
    assert.ok(finished.lease.expiresAt.getTime() > Date.now(), JSON.stringify(finished.lease));

    // The only claimable row now belongs to another process. Saying "I was
    // interrupted" about it must not clear the lease that process is running
    // under — that hands the same task to a third worker while the second one
    // is still working.
    const taken = await store.claimNextTask({ owner: "other_process", leaseMs: 60000 });
    assert.equal(taken?.taskId, theirs, JSON.stringify(taken));
    await worker.markTaskInterrupted(taken, "worker_stopped");
    const stolen = await Task.findOne({ taskId: theirs }).lean();
    assert.equal(stolen.lease.owner, "other_process", `a stranger released the live lease: ${JSON.stringify(stolen.lease)}`);
    assert.ok(stolen.lease.expiresAt.getTime() > Date.now(), JSON.stringify(stolen.lease));
    assert.equal(stolen.recovery.reason, "", JSON.stringify(stolen.recovery));
  } finally {
    await removeTasks([mine, theirs]);
  }
});

test("4.11 a worker that loses the lease mid-run stops and leaves the record alone", async () => {
  const cookie = await newUser();
  const taskId = await submit(cookie, "Run this while another process takes it over.");
  fakeProvider.state.set({ chatDelayMs: 2000, chatResponseText: "Written by a worker that no longer owns this." });
  process.env.TASK_LEASE_MS = "1000";
  try {
    const claimed = await store.claimNextTask({ owner: worker.workerId(), leaseMs: 1000 });
    assert.equal(claimed?.taskId, taskId, JSON.stringify(claimed));
    const running = worker.executeTask(claimed);
    await waitForState(cookie, taskId, "running", 8000);

    // A second process takes the task over while this one is inside the model
    // call; its lease is live, so it is the only legitimate runner.
    await Task.updateOne({ taskId }, { $set: { "lease.owner": "other_process", "lease.expiresAt": new Date(Date.now() + 60000) } });
    const outcome = await running;

    assert.ok(!state.isTerminal(outcome.state), `a worker that lost its task decided its outcome: ${outcome.state}`);
    const after = await Task.findOne({ taskId }).lean();
    assert.equal(after.lease.owner, "other_process", `the interrupted worker cleared the new owner's lease: ${JSON.stringify(after.lease)}`);
    assert.ok(after.lease.expiresAt.getTime() > Date.now(), JSON.stringify(after.lease));
    assert.equal(after.state, "running", JSON.stringify(after));
    assert.equal(after.completedAt, null, JSON.stringify(after));
    assert.equal(after.recovery.reason, "", JSON.stringify(after.recovery));
    assert.ok(!after.events.some(event => event.phase === "answer"), "a task nobody owns anymore must not report an answer");
    assert.equal(fakeProvider.state.chatRequests.length, 1, "the interrupted worker must not ask the model again");
    fakeProvider.state.reset();
  } finally {
    delete process.env.TASK_LEASE_MS;
    await removeTasks([taskId]);
  }
});

test("4.12 a task this process is already running is never run a second time alongside it", async () => {
  const cookie = await newUser();
  await withScheduler(async () => {
    fakeProvider.state.set({ chatDelayMs: 1500, chatResponseText: "Answered once." });
    const taskId = await submit(cookie, "Run this while a stale write puts it back in the queue.");
    try {
      await waitForState(cookie, taskId, "running", 8000);
      // A whole-document write from a copy taken before the claim lands does
      // exactly this: the row goes back to queued with no lease while the
      // runner that already holds it is inside the model call. The table then
      // offers the same work to the same process a second time.
      await Task.updateOne({ taskId }, { $set: { state: "queued", "lease.owner": "", "lease.expiresAt": null } });

      // Long enough for many 40 ms claim passes to see that queued row, and
      // still inside the first run's 1500 ms model call. A count above one here
      // means two executions of one task are in the model at the same moment:
      // runningTaskIds() cannot witness that, because both register under the
      // same map key and the second simply replaces the first.
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(
        fakeProvider.state.chatRequests.length,
        1,
        `one task was asked ${fakeProvider.state.chatRequests.length} times at once`
      );
      assert.equal(worker.runningTaskIds().filter(id => id === taskId).length, 1);

      // What happens next is the lease contract, not a defect: the holder whose
      // row was rewound finds its state guard no longer matches, stops writing,
      // and the untouched-looking row is claimed again — so the work is done
      // once more, in sequence, and the answer arrives exactly once. Two runs
      // are the most this can ever produce; a claim loop that re-took the row
      // while a run was live would produce more, and would never finish.
      const done = await waitForState(cookie, taskId, ["completed", "failed", "cancelled"], 12000);
      assert.equal(done.state, "completed", JSON.stringify(done.error));
      assert.match(done.result?.summary ?? "", /Answered once\./, JSON.stringify(done.result));
      assert.equal(
        fakeProvider.state.chatRequests.length,
        2,
        `the rewound row was run ${fakeProvider.state.chatRequests.length} times, and a task that is really running must not be re-taken again`
      );
    } finally {
      await removeTasks([taskId]);
      fakeProvider.state.reset();
    }
  });
});

test("4.13 an execution does not drop its lease before its outcome is written, so recovery cannot re-run finished work", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({
    chatStatus: 400,
    chatErrorPayload: { error: { message: "Unsupported parameter: temperature." } },
    chatResponseText: "This answer must never be reached."
  });
  const taskId = await submit(cookie, "A permanent failure that has to cost exactly one request.");

  // The chain from issue #337: an execution ends, releases the lease while the
  // record still says "running", and a reconciliation pass — which any running
  // scheduler makes on boot and every thirty ticks — reads an open state with no
  // live lease as abandoned work, moves it to "recovering" and hands it back to
  // the queue. The same process then runs the same task a second time and asks
  // the model again, from attempt 1. The natural window is a few hundred
  // microseconds wide, which is why the stress harness needed 450 rounds to hit
  // it once; here the reconciliation the scheduler would have run anyway is run
  // at the instant the lease is dropped, so the race is decided every time.
  const droppedWhileExecuting = [];
  let reconciled = false;
  const realUpdateOne = Task.updateOne;
  Task.updateOne = async function instrumented(filter, update, options) {
    const dropsLease = update?.$set?.["lease.owner"] === "" && update.$set["lease.expiresAt"] === null;
    const result = await realUpdateOne.call(this, filter, update, options);
    if (!dropsLease || result.matchedCount !== 1 || filter.taskId !== taskId || reconciled) return result;
    reconciled = true;
    const row = await Task.findOne({ taskId }).lean();
    droppedWhileExecuting.push(row.state);
    if (state.EXECUTING_STATES.includes(row.state)) await store.reconcileInterruptedTasks();
    return result;
  };

  try {
    const failed = await withScheduler(() => waitForState(cookie, taskId, "failed", 12000), { tickMs: 40 });
    assert.deepEqual(
      droppedWhileExecuting,
      [],
      `the lease was released while the record still said ${JSON.stringify(droppedWhileExecuting)}: open work with no live owner is what recovery calls abandoned, so the task was handed out a second time`
    );
    assert.equal(
      fakeProvider.state.chatRequests.length,
      1,
      `a permanent failure asked the model ${fakeProvider.state.chatRequests.length} times`
    );
    assert.equal(failed.error.kind, "invalid_request", JSON.stringify(failed.error));
    assert.equal(failed.retry.attempts, 0, JSON.stringify(failed.retry));
    const after = await Task.findOne({ taskId }).lean();
    assert.equal(after.recovery?.restarts ?? 0, 0, `the record says it was recovered and re-run: ${JSON.stringify(after.recovery)}`);
    assert.equal(after.state, "failed", JSON.stringify(after.state));
  } finally {
    Task.updateOne = realUpdateOne;
    await removeTasks([taskId]);
    fakeProvider.state.reset();
  }
});

test("4.14 a worker that stops mid-run leaves the task recoverable and names the interruption itself", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ chatDelayMs: 1500, chatResponseText: "Answered by the next worker." });
  const taskId = await submit(cookie, "Stop the worker while this is being answered.");
  worker.startTaskWorker({ tickMs: 40 });
  try {
    await waitForState(cookie, taskId, "running", 8000);
    await worker.stopTaskWorker();

    const stopped = await Task.findOne({ taskId }).lean();
    assert.ok(!state.isTerminal(stopped.state), `a shutdown wrote an outcome nobody asked for: ${stopped.state}`);
    assert.ok(
      ["worker_stopped", "worker_aborted"].includes(stopped.recovery?.reason),
      `the process that stopped wrote nothing about it, leaving recovery to guess: ${JSON.stringify(stopped.recovery)}`
    );
    assert.ok(
      !stopped.lease.owner || stopped.lease.expiresAt.getTime() < Date.now(),
      `the shutdown left a live lease on work nobody is running: ${JSON.stringify(stopped.lease)}`
    );

    // A new worker reconciles on its first pass, so the interrupted run resumes
    // from its last safe point and answers once.
    worker.startTaskWorker({ tickMs: 40 });
    const done = await waitForState(cookie, taskId, "completed", 12000);
    assert.match(done.result?.summary ?? "", /Answered by the next worker\./, JSON.stringify(done.result));
    assert.equal(
      fakeProvider.state.chatRequests.length,
      2,
      `the aborted call and the resumed call should be the only two, got ${fakeProvider.state.chatRequests.length}`
    );
    const recovered = await Task.findOne({ taskId }).lean();
    assert.ok(recovered.recovery.restarts >= 1, JSON.stringify(recovered.recovery));
  } finally {
    await worker.stopTaskWorker();
    await removeTasks([taskId]);
    fakeProvider.state.reset();
  }
});
