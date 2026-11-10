/**
 * Two-backend split: the role and service-to-service suite (Phases 2 and 3).
 *
 * Same house style as the other task suites — a real HTTP server per role over
 * `mongodb-memory-server`, the real routes, the real claim/lease/worker code and the deterministic
 * fake provider — with one trick that needs explaining.
 *
 * `index.js` decides which routes to mount while the module is being evaluated, and ESM caches a
 * module by its full specifier. Adding a query string therefore produces a second, independently
 * configured copy of the app from the same file, while every store, schema and lease rule stays
 * shared: which is exactly the arrangement two Render services pointed at one database have, minus
 * the second process. Two consequences a reader should not trip over:
 *   - The role is a process-wide cache, so only one role's *request handling* is honest at a time.
 *     Tests that drive Main set the cache to `main`; the executor's own behaviour is exercised
 *     through its mounted endpoints and its scheduler, which do not consult the cache.
 *   - There is one scheduler in this process. It stands for the executor's, because a `main` role
 *     never starts one and that is asserted separately.
 *
 * Nothing here talks to a real provider or a real deployment.
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
process.env.VUPS_MAX_RETRIES = "0";
// No app instance starts a scheduler in this file: the suite starts the one it means to, when it
// means to, so a test can always say which role was holding a task.
process.env.TASK_WORKER_DISABLED = "1";
delete process.env.TASK_USER_CONCURRENCY;
delete process.env.TASK_WORKER_CONCURRENCY;
// The three switches under test start unset, because an unset SERVER_ROLE is the deployed
// single-service configuration and the first thing that has to be proven is that it still works.
delete process.env.SERVER_ROLE;
delete process.env.AI_EXECUTION_URL;
delete process.env.SERVICE_TO_SERVICE_SECRET;
delete process.env.AI_DISPATCH_TIMEOUT_MS;

import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_service_role_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const roleModule = await import("./serviceRole.js");
const connectToDatabase = (await import("./db.js")).default;
const { default: mongoose } = await import("mongoose");
const { default: Task } = await import("./task.js");
const taskState = await import("./taskState.js");
const store = await import("./taskStore.js");
const worker = await import("./taskWorker.js");

const appAll = (await import("./index.js")).default;
process.env.SERVER_ROLE = "main";
roleModule.resetServiceRole();
const appMain = (await import("./index.js?role=main")).default;
process.env.SERVER_ROLE = "executor";
roleModule.resetServiceRole();
const appExecutor = (await import("./index.js?role=executor")).default;
// Everything after this point is written from the point of view of the submitting service.
roleModule.resetServiceRole("main");

const servers = [];
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  servers.push(server);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const all = await listen(appAll);
const main = await listen(appMain);
const executor = await listen(appExecutor);
const allURL = all.url;
const mainURL = main.url;
const executorURL = executor.url;
await connectToDatabase();

const SERVICE_SECRET = "test-service-to-service-secret-with-at-least-32-characters";

after(async () => {
  await worker.stopTaskWorker();
  for (const server of servers) {
    await new Promise(resolve => server.close(resolve));
  }
  await fakeProvider.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail(prefix = "role") {
  counter += 1;
  return `${prefix}${Date.now()}-${counter}@example.com`;
}

async function api(base, path, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
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

/** A signed-in account whose provider is the fake, configured through Main like a user would. */
async function newUser(prefix = "role") {
  fakeProvider.state.reset();
  const signup = await api(mainURL, "/api/auth/signup", {
    method: "POST",
    body: {
      name: "Role Tester",
      email: uniqueEmail(prefix),
      password: "correct-horse-battery",
      acceptTerms: true
    }
  });
  assert.equal(signup.status, 201, JSON.stringify(signup.body));
  const cookie = sessionCookie(signup);
  const configured = await api(mainURL, "/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "Fake OpenAI-compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-mini"
    }
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  fakeProvider.state.reset();
  return cookie;
}

async function submit(base, cookie, prompt) {
  const created = await api(base, "/api/tasks", { method: "POST", cookie, body: { prompt } });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  return created.body.task;
}

async function waitForState(cookie, taskId, wanted, { timeoutMs = 15000, base = mainURL } = {}) {
  const allowed = Array.isArray(wanted) ? wanted : [wanted];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const found = await api(base, `/api/tasks/${taskId}`, { cookie });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    last = found.body.task;
    if (allowed.includes(last.state)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `task ${taskId} never reached ${JSON.stringify(allowed)}; last state ${last?.state}, error ${JSON.stringify(last?.error)}`
  );
}

/** The hand-off is written after the 202, so a reader has to wait for it rather than assume it. */
async function waitForDispatch(cookie, taskId, wanted, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const found = await api(mainURL, `/api/tasks/${taskId}`, { cookie });
    last = found.body.task;
    if (last?.dispatch?.status === wanted) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`task ${taskId} never recorded dispatch ${wanted}; last ${JSON.stringify(last?.dispatch)}`);
}

async function record(taskId) {
  const found = await Task.findOne({ taskId }).lean();
  assert.ok(found, `no record for ${taskId}`);
  return found;
}

/** How many upstream calls one instruction caused; see the note in taskAcceptance.test.js. */
function asksFor(prompt) {
  return fakeProvider.state.chatRequests.filter(
    entry => JSON.stringify(entry.body?.messages || []).includes(prompt)
  ).length;
}

/**
 * Wait until an instruction's request is actually at the provider.
 *
 * A task leaves `queued` a moment before its model request arrives, so a test that wants to interrupt
 * a run in progress has to wait for the second thing, not the first — otherwise a cancellation that
 * wins that gap leaves nothing to interrupt, and an assertion about the attempts that followed reads
 * zero as a failure of the rule instead of an absence of the case.
 */
async function waitForAsk(prompt, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (asksFor(prompt) > 0) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`"${prompt}" never reached the provider`);
}

/**
 * Wait until the scheduler is holding `wanted` tasks at the same moment.
 *
 * A test about concurrency has to observe the overlap instead of infer it from two results that
 * happened to arrive, because a serialized queue would produce exactly the same answers.
 */
async function waitForRunning(wanted, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (worker.runningTaskIds().length >= wanted) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

/** A port nothing is listening on, for the "the peer never answered" cases. */
async function closedPort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/**
 * A peer that takes the notification and answers late.
 *
 * The scheduler in this process still stands in for the runner's, so the work really is done; what
 * this peer is for is the answer arriving after Main's own deadline, which is the branch where a
 * hand-off looks lost while the task is perfectly healthy.
 */
async function slowRunner(delayMs) {
  const peer = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      setTimeout(() => {
        // Main gives up before this lands, so the socket is usually gone by now.
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, code: "claim_pass_started" }));
      }, delayMs).unref?.();
    });
  });
  await new Promise(resolve => peer.listen(0, "127.0.0.1", resolve));
  servers.push(peer);
  return `http://127.0.0.1:${peer.address().port}`;
}

// ─── SR-01..SR-04 the role itself ────────────────────────────────────────────

test("SR-01 no SERVER_ROLE means the whole app, and only the three documented roles are accepted", () => {
  const savedRole = process.env.SERVER_ROLE;
  assert.equal(roleModule.parseServiceRole(""), "all");
  assert.equal(roleModule.parseServiceRole("   "), "all");
  delete process.env.SERVER_ROLE;
  assert.equal(roleModule.parseServiceRole(undefined), "all", "an unset variable must not become a guess");
  if (savedRole !== undefined) process.env.SERVER_ROLE = savedRole;
  assert.equal(roleModule.parseServiceRole("MAIN"), "main");
  assert.equal(roleModule.parseServiceRole(" Executor "), "executor");
  assert.equal(roleModule.parseServiceRole("all"), "all");
  // A typo is a refused boot, not a silent fallback: a service that quietly came up as the wrong
  // half would drain nothing or serve everything, and either way the queue would be broken.
  assert.throws(() => roleModule.parseServiceRole("worker"), /SERVER_ROLE must be one of/);
  assert.throws(() => roleModule.parseServiceRole("main,executor"), /SERVER_ROLE must be one of/);
});

test("SR-02 a role's two capabilities are the exact complement of each other except for all", () => {
  const table = {
    all: [true, true],
    main: [true, false],
    executor: [false, true]
  };
  for (const [value, [serves, runs]] of Object.entries(table)) {
    assert.equal(roleModule.servesUserApi(value), serves, `servesUserApi(${value})`);
    assert.equal(roleModule.canRunTaskWorker(value), runs, `canRunTaskWorker(${value})`);
  }
});

test("SR-03 a shared secret shorter than the other boot secrets is treated as absent", () => {
  delete process.env.SERVICE_TO_SERVICE_SECRET;
  assert.equal(roleModule.serviceToServiceSecret(), null);
  assert.equal(roleModule.serviceAuthConfigured(), false);
  process.env.SERVICE_TO_SERVICE_SECRET = "x".repeat(31);
  assert.equal(roleModule.serviceToServiceSecret(), null, "a 31-character secret must not count");
  assert.equal(roleModule.serviceAuthConfigured(), false);
  process.env.SERVICE_TO_SERVICE_SECRET = `  ${SERVICE_SECRET}  `;
  assert.equal(roleModule.serviceToServiceSecret(), SERVICE_SECRET, "surrounding whitespace is not part of it");
  assert.equal(roleModule.serviceAuthConfigured(), true);
  delete process.env.SERVICE_TO_SERVICE_SECRET;
});

test("SR-04 a wrong service key is refused, and a key of any length refuses without throwing", () => {
  const request = value => ({ get: () => value });
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  assert.equal(roleModule.isServiceRequest(request(SERVICE_SECRET)), true);
  assert.equal(roleModule.isServiceRequest(request(`${SERVICE_SECRET}x`)), false);
  assert.equal(roleModule.isServiceRequest(request("a")), false, "a one-character key must not reach a length-mismatched compare");
  assert.equal(roleModule.isServiceRequest(request("")), false);
  assert.equal(roleModule.isServiceRequest(request(undefined)), false);
  assert.equal(roleModule.isServiceRequest(request("x".repeat(4096))), false, "an oversized key must not throw either");
  delete process.env.SERVICE_TO_SERVICE_SECRET;
  assert.equal(
    roleModule.isServiceRequest(request("anything")),
    false,
    "with no secret configured no caller is a service, however correct its key looks"
  );
});

test("SR-05 the runner's address is HTTPS in production, loopback for a local run, and never plain elsewhere", () => {
  const at = (value, env = {}) => roleModule.executorDispatchUrl({ AI_EXECUTION_URL: value, ...env });
  assert.equal(at(""), null);
  assert.equal(at(undefined), null);
  assert.equal(at("not a url"), null);
  assert.equal(
    at("https://vups-router-be-1.onrender.com/"),
    "https://vups-router-be-1.onrender.com",
    "a trailing slash would double one in the path"
  );
  assert.equal(at("http://127.0.0.1:4000"), "http://127.0.0.1:4000", "a two-process local run has to be possible");
  assert.equal(at("http://localhost:4000"), "http://localhost:4000");
  assert.equal(at("http://vups-router-be-1.onrender.com"), null, "plain HTTP to a public host is never a peer");
  assert.equal(
    at("http://127.0.0.1:4000", { NODE_ENV: "production" }),
    null,
    "loopback is not a production peer either, so a mis-set variable cannot silently talk to itself"
  );
  assert.equal(at("https://vups-router-be-1.onrender.com", { NODE_ENV: "production" }), "https://vups-router-be-1.onrender.com");
  assert.equal(at("ftp://127.0.0.1:4000"), null);
});

test("SR-06 a hand-off is only configured when both the address and the secret are there", () => {
  const saved = { url: process.env.AI_EXECUTION_URL, secret: process.env.SERVICE_TO_SERVICE_SECRET };
  process.env.AI_EXECUTION_URL = "https://runner.example.com";
  delete process.env.SERVICE_TO_SERVICE_SECRET;
  assert.equal(roleModule.dispatchConfigured(), false, "an address with no key is not a hand-off");
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  assert.equal(roleModule.dispatchConfigured(), true);
  delete process.env.AI_EXECUTION_URL;
  assert.equal(roleModule.dispatchConfigured(), false, "a key with no address is not a hand-off");
  Object.assign(process.env, saved);
});

test("SR-07 the hand-off timeout is bounded so no peer can hold a submission open", () => {
  delete process.env.AI_DISPATCH_TIMEOUT_MS;
  assert.equal(roleModule.dispatchTimeoutMs(), 3000);
  process.env.AI_DISPATCH_TIMEOUT_MS = "1200";
  assert.equal(roleModule.dispatchTimeoutMs(), 1200);
  process.env.AI_DISPATCH_TIMEOUT_MS = "50";
  assert.equal(roleModule.dispatchTimeoutMs(), 3000, "a value below the floor is not honoured");
  process.env.AI_DISPATCH_TIMEOUT_MS = "banana";
  assert.equal(roleModule.dispatchTimeoutMs(), 3000);
  delete process.env.AI_DISPATCH_TIMEOUT_MS;
});

// ─── SR-08..SR-11 what each role actually serves ─────────────────────────────

test("SR-08 health names the role and what this process is allowed to do", async () => {
  const cases = [
    { base: allURL, role: "all", servesUserApi: true },
    { base: mainURL, role: "main", servesUserApi: true },
    { base: executorURL, role: "executor", servesUserApi: false }
  ];
  for (const item of cases) {
    const health = await api(item.base, "/api/health");
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.role, item.role);
    assert.equal(health.body.execution.servesUserApi, item.servesUserApi);
    // No url, no key, no identity: a public health endpoint may say which half this is, and nothing
    // about where the other half lives.
    assert.ok(!JSON.stringify(health.body).includes(SERVICE_SECRET), "health must never carry the service key");
    assert.ok(!/onrender\.com/.test(JSON.stringify(health.body)), "health must never name the peer");
  }
  assert.equal((await api(mainURL, "/api/health")).body.execution.internalEndpoint, "absent");
});

test("SR-09 an executor mounts no browser route at all, so it cannot be used as a copy of the API", async () => {
  const cookie = await newUser("sr09");
  assert.equal((await api(mainURL, "/api/auth/me", { cookie })).status, 200, "the same session works on Main");
  const paths = [
    "/api/auth/me",
    "/api/settings/provider",
    "/api/conversations",
    "/api/tasks",
    "/api/combo",
    "/api/plugins",
    "/api/admin/shared-model"
  ];
  for (const path of paths) {
    const onExecutor = await api(executorURL, path, { cookie });
    assert.equal(onExecutor.status, 404, `${path} answered on an executor: ${JSON.stringify(onExecutor.body)}`);
  }
  // Writes are refused the same way, with the session presented, which is the case that matters:
  // nothing about a Main-minted cookie is accepted here, because there is no handler to accept it.
  const signup = await api(executorURL, "/api/auth/signup", {
    method: "POST",
    body: { name: "Nope", email: uniqueEmail("sr09x"), password: "correct-horse-battery", acceptTerms: true }
  });
  assert.equal(signup.status, 404, "an executor must not be able to create accounts");
  const submitted = await api(executorURL, "/api/tasks", { method: "POST", cookie, body: { prompt: "no" } });
  assert.equal(submitted.status, 404, "an executor must not accept a submission");
  const index = await api(executorURL, "/api");
  assert.equal(index.body.role, "executor");
  assert.deepEqual(index.body.routes, [], "the index must not advertise routes this role does not have");
});

test("SR-10 a main never answers the internal path, even to a caller holding the key", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  const cookie = await newUser("sr10");
  const task = await submit(mainURL, cookie, "Stays queued on main.");
  const onMain = await api(mainURL, "/api/internal/tasks/wake", {
    method: "POST",
    body: { taskId: task.taskId },
    headers: { [roleModule.SERVICE_ROLE_HEADER]: SERVICE_SECRET }
  });
  assert.equal(onMain.status, 404, `a main mounted the internal endpoint: ${JSON.stringify(onMain.body)}`);
  // The single-service deployment still mounts it — it is the same process — but with no key it is
  // indistinguishable from a route that does not exist.
  delete process.env.SERVICE_TO_SERVICE_SECRET;
  const unconfigured = await api(allURL, "/api/internal/tasks/wake", { method: "POST", body: { taskId: task.taskId } });
  assert.equal(unconfigured.status, 404);
  assert.equal(unconfigured.body.code, "not_found", "no key configured must not advertise the endpoint");
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  const noKey = await api(executorURL, "/api/internal/tasks/wake", { method: "POST", body: { taskId: task.taskId } });
  assert.equal(noKey.status, 401, `a keyless call was not refused: ${JSON.stringify(noKey.body)}`);
  assert.equal(noKey.body.code, "service_unauthorized");
  const wrongKey = await api(executorURL, "/api/internal/tasks/wake", {
    method: "POST",
    body: { taskId: task.taskId },
    headers: { [roleModule.SERVICE_ROLE_HEADER]: "wrong-service-key-of-the-same-shape" }
  });
  assert.equal(wrongKey.status, 401);
  const shortKey = await api(executorURL, "/api/internal/tasks/wake", {
    method: "POST",
    body: { taskId: task.taskId },
    headers: { [roleModule.SERVICE_ROLE_HEADER]: "a" }
  });
  assert.equal(shortKey.status, 401, "an undersized key must be refused, not crash the compare");
  // A user session is not a service credential, and is answered the same as any other stranger:
  // the authority that can create a task is not the authority that can wake a runner.
  const asUser = await api(executorURL, "/api/internal/tasks/wake", {
    method: "POST",
    body: { taskId: task.taskId },
    cookie
  });
  assert.equal(asUser.status, 401, "a signed-in user must never reach an internal endpoint");
  const malformed = await api(executorURL, "/api/internal/tasks/wake", {
    method: "POST",
    body: { taskId: "tsk_not_a_real_id" },
    headers: { [roleModule.SERVICE_ROLE_HEADER]: SERVICE_SECRET }
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid_task_id");
  await api(mainURL, `/api/tasks/${task.taskId}/cancel`, { method: "POST", cookie });
  delete process.env.SERVICE_TO_SERVICE_SECRET;
});

test("SR-11 a role that cannot run tasks leaves the work queued and says why nothing was sent", async () => {
  const saved = { url: process.env.AI_EXECUTION_URL, secret: process.env.SERVICE_TO_SERVICE_SECRET };
  delete process.env.AI_EXECUTION_URL;
  delete process.env.SERVICE_TO_SERVICE_SECRET;
  const cookie = await newUser("sr11");

  const plain = await submit(mainURL, cookie, "Nobody is running me yet.");
  assert.equal(plain.state, "queued");
  await new Promise(resolve => setTimeout(resolve, 400));
  const idle = await api(mainURL, `/api/tasks/${plain.taskId}`, { cookie });
  assert.equal(idle.body.task.state, "queued", "a main ran a task it is not allowed to run");
  assert.equal(idle.body.task.dispatch.status, "", "a single-service deployment recorded a hand-off");
  assert.equal(asksFor("Nobody is running me yet."), 0, "a queued task caused an upstream call");

  // The same deployment with an address and no key is a different situation, and has to look like
  // one: a split that was configured halfway silently never hands anything over.
  process.env.AI_EXECUTION_URL = "https://runner.invalid-for-tests.example";
  process.env.SERVICE_TO_SERVICE_SECRET = "too-short-to-count";
  const half = await submit(mainURL, cookie, "A half-configured split.");
  const shown = await waitForDispatch(cookie, half.taskId, "not_configured");
  assert.equal(shown.state, "queued", "a half-configured split still ran the task here");

  for (const taskId of [plain.taskId, half.taskId]) {
    await api(mainURL, `/api/tasks/${taskId}/cancel`, { method: "POST", cookie });
  }
  Object.assign(process.env, saved);
});

// ─── SR-12..SR-17 the split working end to end ───────────────────────────────

test("SR-12 Main hands a task to the runner over real HTTP and the answer returns through Main", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const cookie = await newUser("sr12");
  // This process's scheduler stands in for the runner: the only one here, and never Main's.
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 600, chatResponseText: "Answered by the runner." });

  const task = await submit(mainURL, cookie, "Do this in the other service.");
  assert.equal(task.state, "queued", "a submission must not wait for the work");
  await waitForDispatch(cookie, task.taskId, "accepted");
  const done = await waitForState(cookie, task.taskId, "completed");

  assert.ok(done.dispatch.attempts >= 1, "the hand-off was never recorded");
  assert.match(done.result.summary, /Answered by the runner./);
  assert.equal(asksFor("Do this in the other service."), 1, "one task caused more than one upstream call");
  assert.equal((await api(executorURL, `/api/tasks/${task.taskId}`, { cookie })).status, 404);

  const stored = await record(task.taskId);
  assert.equal(stored.state, "completed");
  assert.equal(stored.dispatch.status, "accepted");
  const replay = await api(mainURL, `/api/tasks/${task.taskId}/events`, { cookie });
  assert.equal(replay.status, 200);
  assert.ok(replay.body.events.length >= 3, "the runner wrote nothing Main can show");
  const phases = replay.body.events.map(event => event.phase);
  assert.ok(phases.includes("task") && phases.includes("provider"), `progress phases: ${phases.join(",")}`);
  const seqs = replay.body.events.map(event => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "progress rows came back unordered");
  assert.equal(new Set(seqs).size, seqs.length, "a progress row appeared twice");

  await worker.stopTaskWorker();
});

test("SR-13 a hand-off that never connects costs a delay, not the task", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = `http://127.0.0.1:${await closedPort()}`;
  const cookie = await newUser("sr13");
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 600, chatResponseText: "Answered from the queue." });

  const task = await submit(mainURL, cookie, "Reach a peer that is not there.");
  await waitForDispatch(cookie, task.taskId, "unreachable");
  const done = await waitForState(cookie, task.taskId, "completed");

  assert.equal(done.state, "completed", "an unreachable runner lost the work");
  assert.match(done.result.summary, /Answered from the queue./);
  assert.equal(asksFor("Reach a peer that is not there."), 1);
  await worker.stopTaskWorker();
});

test("SR-14 a replayed notification does not start the same task twice", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const cookie = await newUser("sr14");
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 500, chatResponseText: "Once only." });

  const task = await submit(mainURL, cookie, "Wake me as often as you like.");
  for (let index = 0; index < 4; index += 1) {
    const woke = await api(executorURL, "/api/internal/tasks/wake", {
      method: "POST",
      body: { taskId: task.taskId },
      headers: { [roleModule.SERVICE_ROLE_HEADER]: SERVICE_SECRET }
    });
    assert.equal(woke.status, 202, JSON.stringify(woke.body));
    assert.ok(["claim_pass_started", "claim_pass_unavailable"].includes(woke.body.code), JSON.stringify(woke.body));
  }
  const done = await waitForState(cookie, task.taskId, "completed");
  assert.equal(done.state, "completed");
  assert.equal(asksFor("Wake me as often as you like."), 1, "a repeated notification became repeated work");

  await worker.stopTaskWorker();
});

test("SR-15 cancelling through the internal endpoint stops the run that holds the task", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const cookie = await newUser("sr15");
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 2500, chatResponseText: "Should never finish." });

  const task = await submit(mainURL, cookie, "Stop this one while it runs.");
  await waitForState(cookie, task.taskId, ["running", "planning", "executing_tool"], { timeoutMs: 8000 });
  // The claim here is that a cancellation stops the *next* attempt, so there has to be one in flight
  // to stop: a task can be moved out of `queued` a moment before its request reaches the provider, and
  // under a loaded machine a cancel written at that instant lands first and nothing is ever asked.
  // Waiting for the request makes the precondition observable instead of assumed.
  await waitForAsk("Stop this one while it runs.");
  // The record is the authority, so cancellation is written first and the notification only
  // shortens the wait. `cancelTask` is called through the store rather than Main's route because
  // that route also aborts in-process, which would test this process instead of the endpoint.
  const stored = await record(task.taskId);
  await store.cancelTask({ taskId: task.taskId, userId: stored.userId });
  const cancelled = await api(executorURL, "/api/internal/tasks/cancel", {
    method: "POST",
    body: { taskId: task.taskId },
    headers: { [roleModule.SERVICE_ROLE_HEADER]: SERVICE_SECRET }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.held, true, "the runner said it was not holding a task it was running");
  assert.equal(cancelled.body.code, "abort_signalled");

  const stopped = await waitForState(cookie, task.taskId, "cancelled");
  assert.ok(!stopped.result?.summary, `a cancelled task reported an answer: ${JSON.stringify(stopped.result)}`);
  assert.equal(asksFor("Stop this one while it runs."), 1, "a cancellation was followed by another attempt");
  await worker.stopTaskWorker();
});

test("SR-16 a cancellation no notification carried is still noticed by the holder's heartbeat", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = `http://127.0.0.1:${await closedPort()}`;
  const savedLease = process.env.TASK_LEASE_MS;
  // A short lease is what makes the renewal frequent enough to watch: the heartbeat interval is a
  // third of it, floored at a second, so the record is re-read about once a second here.
  process.env.TASK_LEASE_MS = "3000";
  const cookie = await newUser("sr16");
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 20000, chatResponseText: "Should never finish either." });

  const task = await submit(mainURL, cookie, "Stop me with no notification at all.");
  await waitForState(cookie, task.taskId, ["running", "planning", "executing_tool"], { timeoutMs: 8000 });
  assert.ok(worker.runningTaskIds().includes(task.taskId), "the task is not being held by this scheduler");
  await waitForAsk("Stop me with no notification at all.");

  // Only the row changes. Nothing aborts in this process and no peer is reachable, so the single
  // way the run can stop is the renewal that reads the same record the user cancelled.
  const stored = await record(task.taskId);
  await store.cancelTask({ taskId: task.taskId, userId: stored.userId });
  const deadline = Date.now() + 6000;
  while (worker.runningTaskIds().includes(task.taskId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(
    !worker.runningTaskIds().includes(task.taskId),
    "the holder never looked at the cancellation written without a notification"
  );
  const final = await api(mainURL, `/api/tasks/${task.taskId}`, { cookie });
  assert.equal(final.body.task.state, "cancelled");
  assert.ok(!final.body.task.result?.summary, `a cancelled task reported an answer: ${JSON.stringify(final.body.task.result)}`);
  assert.equal(asksFor("Stop me with no notification at all."), 1, "the interrupted run was started again");

  await worker.stopTaskWorker();
  if (savedLease === undefined) delete process.env.TASK_LEASE_MS;
  else process.env.TASK_LEASE_MS = savedLease;
});

test("SR-17 a SERVER_ROLE nobody documented stops the boot instead of guessing a role", async () => {
  process.env.SERVER_ROLE = "worker";
  roleModule.resetServiceRole();
  await assert.rejects(
    () => import("./index.js?role=invalid"),
    /SERVER_ROLE must be one of/,
    "a misspelled role came up as something else"
  );
  delete process.env.SERVER_ROLE;
  roleModule.resetServiceRole();
  assert.equal(roleModule.serviceRole(), "all");
  roleModule.resetServiceRole("main");
});

// ─── SR-18..SR-19 what a split survives ──────────────────────────────────────

test("SR-18 a runner that dies mid-task leaves the work to the next one, with one answer", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const cookie = await newUser("sr18");
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 4000, chatResponseText: "Answered after the restart." });

  const task = await submit(mainURL, cookie, "Finish even if the runner dies.");
  await waitForAsk("Finish even if the runner dies.");
  // The process that held the task goes away inside a provider request. Nothing cancels the work:
  // the record stays open with a lease nobody renews, which is the shape recovery exists for.
  await worker.stopTaskWorker();
  const abandoned = await api(mainURL, `/api/tasks/${task.taskId}`, { cookie });
  assert.ok(
    !["completed", "failed", "cancelled"].includes(abandoned.body.task.state),
    `a task whose runner died ended as ${abandoned.body.task.state}`
  );
  assert.ok(!abandoned.body.task.result?.summary, "a task whose runner died reported an answer");

  // A runner boots, finds the abandoned work and finishes it. The wake hint is not involved any more:
  // this half of the recovery is the queue, which is the point of it being the authority.
  worker.startTaskWorker({ tickMs: 25 });
  const done = await waitForState(cookie, task.taskId, "completed");
  assert.match(done.result.summary, /Answered after the restart./);
  assert.equal(
    asksFor("Finish even if the runner dies."),
    2,
    "the recovered run either never re-asked the model or asked more than the one replacement request"
  );

  const stored = await record(task.taskId);
  assert.equal(stored.dispatch.status, "accepted", "the hand-off receipt did not survive the restart");
  // Which interruption word lands here is whichever pass notices first — the holder's own goodbye or
  // the reconcile that finds a lapsed lease — and the durability promise does not depend on that.
  // What has to be on the record is that a run was interrupted and a second one replaced it.
  assert.ok(stored.recovery?.reason, `recovery recorded nothing: ${JSON.stringify(stored.recovery)}`);
  assert.equal(stored.recovery.stateBeforeInterruption, "running");
  assert.ok(stored.recovery.restarts >= 1, `restarts: ${stored.recovery.restarts}`);
  const replay = await api(mainURL, `/api/tasks/${task.taskId}/events`, { cookie });
  const seqs = replay.body.events.map(event => event.seq);
  assert.equal(new Set(seqs).size, seqs.length, "a progress row appeared twice across the recovery");
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    "the recovered run's progress was not chronological"
  );
  assert.equal(
    replay.body.events.filter(event => event.phase === "answer").length,
    1,
    "the answer was reported more than once after a recovery"
  );

  await worker.stopTaskWorker();
});

test("SR-19 a hand-off the runner answers late is a timeout on Main, not a second run", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_DISPATCH_TIMEOUT_MS = "250";
  process.env.AI_EXECUTION_URL = await slowRunner(1500);
  const cookie = await newUser("sr19");
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 600, chatResponseText: "Answered once." });

  const task = await submit(mainURL, cookie, "Answer the nudge too late.");
  await waitForDispatch(cookie, task.taskId, "timeout");
  const done = await waitForState(cookie, task.taskId, "completed");

  assert.ok(done.dispatch.attempts >= 1, "a timed-out hand-off left no trace at all");
  assert.match(done.result.summary, /Answered once./);
  assert.equal(asksFor("Answer the nudge too late."), 1, "a notification that timed out became a second run");

  await worker.stopTaskWorker();
  delete process.env.AI_DISPATCH_TIMEOUT_MS;
});

/**
 * A peer that answers the notification with a status and a body of your choosing.
 *
 * Scenarios 3 and 4 of the failure list are answers, not silences: the runner is up and says no. The
 * bodies below are the shapes this server really returns — the internal route's 401 code, and the
 * generic origin-guard and error-handler responses that carry a message but no code at all — because
 * the second shape is the one where a receipt has to be built from the status alone.
 */
async function refusingRunner(status, body) {
  const peer = http.createServer((req, res) => {
    req.resume();
    req.once("end", () => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => peer.listen(0, "127.0.0.1", resolve));
  servers.push(peer);
  return `http://127.0.0.1:${peer.address().port}`;
}

// ─── SR-20..SR-21 the split through a restart and through two accounts ───────

test("SR-20 the submitting service restarting mid-run loses nothing the other service is doing", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const cookie = await newUser("sr20");
  worker.startTaskWorker({ tickMs: 25 });
  fakeProvider.state.set({ chatDelayMs: 900, chatResponseText: "Answered while Main was down." });

  // Two listeners of the same role: the one that takes the submission is shut down while the run is
  // in flight, and the one that replaces it is what reads the record afterwards. The shared `mainURL`
  // stays up because the rest of the file is still using it.
  const before = await listen(appMain);
  const after = await listen(appMain);

  const task = await submit(before.url, cookie, "Keep running while the API restarts.");
  await waitForState(cookie, task.taskId, ["running", "planning", "executing_tool"], { timeoutMs: 8000, base: before.url });
  await waitForAsk("Keep running while the API restarts.");

  // The instance that took the request goes away. Nothing tells the runner: the record already holds
  // the work, and the process reading it is a different one.
  const offline = new Promise(resolve => before.server.close(resolve));
  before.server.closeIdleConnections?.();
  before.server.closeAllConnections?.();
  await offline;

  const midRun = await api(after.url, `/api/tasks/${task.taskId}`, { cookie });
  assert.equal(midRun.status, 200, JSON.stringify(midRun.body));
  assert.ok(
    ["running", "planning", "executing_tool", "verifying", "completed"].includes(midRun.body.task.state),
    `a restarted Main saw the task as ${midRun.body.task.state}`
  );
  const whileDown = await api(after.url, `/api/tasks/${task.taskId}/events`, { cookie });
  assert.ok(whileDown.body.events.length >= 2, "a restarted Main could read no progress the runner wrote");

  const done = await waitForState(cookie, task.taskId, "completed", { timeoutMs: 15000, base: after.url });
  assert.match(done.result.summary, /Answered while Main was down./);
  assert.equal(asksFor("Keep running while the API restarts."), 1, "a restart of the API became a second run");

  const replay = await api(after.url, `/api/tasks/${task.taskId}/events`, { cookie });
  const seqs = replay.body.events.map(event => event.seq);
  assert.equal(new Set(seqs).size, seqs.length, "a restarted Main replayed a row twice");
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "the replay was not chronological");
  assert.equal(replay.body.events.filter(event => event.phase === "answer").length, 1);

  await worker.stopTaskWorker();
});

test("SR-21 two accounts running at once stay two separate runs", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const first = await newUser("sr21a");
  const second = await newUser("sr21b");
  worker.startTaskWorker({ tickMs: 25 });
  // One instruction, one answer, chosen from the prompt itself: a response that came back with the
  // wrong account's sentence would be the leak this test is looking for.
  fakeProvider.state.set({
    chatDelayMs: 900,
    chatResponder: body =>
      JSON.stringify(body.messages || "").includes("Count the files for account one.")
        ? "Account one has its own answer."
        : "Account two has its own answer."
  });

  const one = await submit(mainURL, first, "Count the files for account one.");
  const two = await submit(mainURL, second, "Count the files for account two.");
  await waitForDispatch(first, one.taskId, "accepted");
  await waitForDispatch(second, two.taskId, "accepted");

  // Real concurrency, not two queues: the claim pass may hold both because the cap is per account.
  const overlapped = await waitForRunning(2, 8000);
  assert.ok(overlapped, `the two accounts never ran together (${worker.runningTaskIds().join(",")})`);

  const doneOne = await waitForState(first, one.taskId, "completed");
  const doneTwo = await waitForState(second, two.taskId, "completed");
  assert.match(doneOne.result.summary, /Account one has its own answer./);
  assert.match(doneTwo.result.summary, /Account two has its own answer./);
  assert.equal(asksFor("Count the files for account one."), 1);
  assert.equal(asksFor("Count the files for account two."), 1);

  // Each conversation belongs to the account that started it.
  const mineOne = await api(mainURL, `/api/tasks/${one.taskId}`, { cookie: first });
  assert.equal(mineOne.body.task.conversationId, doneOne.conversationId);
  const stolen = await api(mainURL, `/api/tasks/${two.taskId}`, { cookie: first });
  assert.equal(stolen.status, 404, "another account's task was readable");
  const stolenEvents = await api(mainURL, `/api/tasks/${two.taskId}/events`, { cookie: first });
  assert.equal(stolenEvents.status, 404, "another account's progress was readable");

  const theirChat = await api(mainURL, `/api/conversations/${doneTwo.conversationId}`, { cookie: first });
  assert.equal(theirChat.status, 404, "the runner wrote one account's answer into another account's chat");

  await worker.stopTaskWorker();
});

// ─── SR-22 the peer answers, and says no ─────────────────────────────────────

test("SR-22 a runner that refuses the hand-off leaves a refusal on the record, not a failed task", async () => {
  const cases = [
    {
      status: 401,
      body: { ok: false, code: "service_unauthorized", message: "Service credentials are required." },
      recordedCode: "service_unauthorized"
    },
    {
      status: 403,
      body: { message: "Request blocked: origin not allowed." },
      recordedCode: "rejected"
    },
    {
      status: 500,
      body: { message: "Something went wrong. Please try again." },
      recordedCode: "rejected"
    }
  ];
  for (const scenario of cases) {
    process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
    process.env.AI_EXECUTION_URL = await refusingRunner(scenario.status, scenario.body);
    const cookie = await newUser("sr22");
    worker.startTaskWorker({ tickMs: 25 });
    fakeProvider.state.set({ chatDelayMs: 300, chatResponseText: "Answered despite the refusal." });

    const prompt = `Refuse me with ${scenario.status}.`;
    const task = await submit(mainURL, cookie, prompt);
    const shown = await waitForDispatch(cookie, task.taskId, "rejected");
    assert.deepEqual(
      Object.keys(shown.dispatch).sort(),
      ["attempts", "lastAt", "status"],
      "the hand-off summary grew a field nobody documented"
    );
    assert.doesNotMatch(
      JSON.stringify(shown),
      /service_unauthorized|origin not allowed|Something went wrong|Simulated/,
      "a peer's own wording reached the browser"
    );

    const done = await waitForState(cookie, task.taskId, "completed");
    assert.match(done.result.summary, /Answered despite the refusal./);
    assert.equal(asksFor(prompt), 1, "a refusal became a repeated run");

    const stored = await record(task.taskId);
    assert.equal(stored.dispatch.status, "rejected");
    assert.equal(stored.dispatch.httpStatus, scenario.status);
    assert.equal(stored.dispatch.code, scenario.recordedCode);
    assert.equal(stored.dispatch.attempts, 1, "one submission retried a refused hand-off more than once");
    assert.ok(!JSON.stringify(stored.dispatch).includes(SERVICE_SECRET), "the service key was stored with the receipt");

    await worker.stopTaskWorker();
  }
});

// ─── SR-23 the runner asks, and nobody is holding the answer ──────────────────

test("SR-23 a question the runner asks is served, answered and resumed from the record", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const cookie = await newUser("sr23");
  const prompt = "Write the release notes for the next cut.";
  const question = "Which branch is this release cut from?";
  fakeProvider.state.set({ toolCalls: [{ name: "ask_user", args: { question } }] });
  worker.startTaskWorker({ tickMs: 25 });

  const task = await submit(mainURL, cookie, prompt);
  await waitForDispatch(cookie, task.taskId, "accepted");
  const parked = await waitForState(cookie, task.taskId, "waiting_for_user");

  // Main wrote nothing here; it is reading a question the other service asked. A truncated or absent
  // `pendingClarification` is the failure this half of the split would otherwise hide.
  assert.equal(parked.pendingClarification?.question, question);
  assert.equal(parked.activeOperation.kind, "clarification");
  const waiting = await record(task.taskId);
  assert.equal(waiting.lease.owner, "", "the runner kept its lease while it waited for a person");
  const parkedEvents = await api(mainURL, `/api/tasks/${task.taskId}/events`, { cookie });
  assert.ok(
    parkedEvents.body.events.some(event => event.key === "clarification"),
    "Main's progress replay had no row for the question"
  );

  // Now the runner goes away, which is what a sleeping Render instance does while somebody reads a
  // question. The answer must land as durable state and survive with nothing on the other side.
  await worker.stopTaskWorker();
  fakeProvider.state.set({ toolCalls: null, chatResponseText: "Release notes written for release/2.1." });
  const answered = await api(
    mainURL,
    `/api/tasks/${task.taskId}/clarifications/${parked.pendingClarification.clarificationId}/answer`,
    { method: "POST", cookie, body: { answer: "release/2.1" } }
  );
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.task.state, "queued");
  assert.equal(answered.body.task.pendingClarification, null, "the answered task still advertised a question");

  const queued = await record(task.taskId);
  assert.equal(queued.state, "queued", "an answer with no runner awake was not written to the queue");
  assert.equal(queued.dispatch.status, "accepted", "the resume did not hand the task back to the runner");

  // The runner comes back with no memory of the task it parked, and finds it in the database.
  worker.startTaskWorker({ tickMs: 25 });
  const done = await waitForState(cookie, task.taskId, "completed");
  assert.match(done.result.summary, /Release notes written for release\/2\.1\./);

  const requests = fakeProvider.state.chatRequests.filter(
    entry => JSON.stringify(entry.body?.messages || []).includes(prompt)
  );
  assert.equal(requests.length, 2, "one park-and-resume asked the model more than twice");
  assert.ok(
    JSON.stringify(requests[1].body.messages).includes("release/2.1"),
    "the resumed run was rebuilt from a transcript that never received the answer"
  );

  const whole = await api(mainURL, `/api/tasks/${task.taskId}/events`, { cookie });
  const seqs = whole.body.events.map(event => event.seq);
  assert.equal(new Set(seqs).size, seqs.length, "a park-and-resume replayed a row twice");
  const asked = whole.body.events.find(event => event.key === "clarification");
  const replied = whole.body.events.find(event => event.key === "clarification_answered");
  assert.ok(asked && replied, "the question or its answer is missing from the replay");
  assert.ok(asked.seq < replied.seq, "the answer was recorded before the question");
  assert.equal(whole.body.events.filter(event => event.phase === "answer").length, 1);

  await worker.stopTaskWorker();
});

// ─── SR-24 two runners, one database ─────────────────────────────────────────

/**
 * The case the split actually creates in production: two processes that may both execute, reading
 * and writing the same task rows.
 *
 * A second import of the scheduler module under its own specifier is a second runner here — its own
 * worker label, its own in-flight set, its own tick — while the Task model, the connection and every
 * claim, lease and transition rule stay shared. That is the whole arrangement except for the process
 * boundary, so a task that ran twice in this test would run twice with two Render services, and a
 * duplicated answer here would be a duplicated message in somebody's chat.
 */
test("SR-24 two runners sharing the database never run one task twice", async () => {
  process.env.SERVICE_TO_SERVICE_SECRET = SERVICE_SECRET;
  process.env.AI_EXECUTION_URL = executorURL;
  const runnerB = await import("./taskWorker.js?runner=b");
  assert.notEqual(
    runnerB.workerId(),
    worker.workerId(),
    "the two scheduler copies share a label, so this test would be measuring one runner"
  );

  const first = await newUser("sr24a");
  const second = await newUser("sr24b");
  const prompts = [
    "Contention between runners one.",
    "Contention between runners two.",
    "Contention between runners three.",
    "Contention between runners four."
  ];
  // Each prompt carries its own sentence back, so a run that was started twice, or an answer that
  // landed in the wrong conversation, is visible in the record rather than merely possible.
  fakeProvider.state.set({
    chatDelayMs: 1200,
    chatResponder: body => {
      const text = JSON.stringify(body?.messages || []);
      const index = prompts.findIndex(prompt => text.includes(prompt));
      return index === -1 ? "Nobody's prompt." : `Runner answered prompt ${index + 1}.`;
    }
  });

  // Two tasks per account: each runner's pool would take all four on its own, so the per-account cap
  // is what leaves work that the second runner can only reach by claiming it first.
  const tasks = [
    await submit(mainURL, first, prompts[0]),
    await submit(mainURL, first, prompts[1]),
    await submit(mainURL, second, prompts[2]),
    await submit(mainURL, second, prompts[3])
  ];
  const cookies = new Map([
    [tasks[0].taskId, first],
    [tasks[1].taskId, first],
    [tasks[2].taskId, second],
    [tasks[3].taskId, second]
  ]);

  worker.startTaskWorker({ tickMs: 25 });
  runnerB.startTaskWorker({ tickMs: 25 });

  const ids = tasks.map(task => task.taskId);
  const bothLabels = new Set([worker.workerId(), runnerB.workerId()]);
  const ownersSeen = new Set();
  let sawTwoHolders = false;
  const deadline = Date.now() + 45000;
  for (;;) {
    const rows = await Task.find({ taskId: { $in: ids } }).select("state lease.owner").lean();
    const holders = rows
      .filter(row => !["completed", "failed", "cancelled"].includes(row.state))
      .map(row => row.lease?.owner)
      .filter(Boolean);
    for (const owner of holders) ownersSeen.add(owner);
    if (new Set(holders).size >= 2) sawTwoHolders = true;
    if (rows.length === ids.length && rows.every(row => ["completed", "failed", "cancelled"].includes(row.state))) break;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  await worker.stopTaskWorker();
  await runnerB.stopTaskWorker();

  // Contention has to be observed, not inferred: two results that arrived is also what a serialized
  // queue produces, so an overlap in the leases is the only proof two runners were really competing.
  assert.ok(sawTwoHolders, `the two runners never held two of these tasks at the same moment (${[...ownersSeen].join(",")})`);
  assert.deepEqual(
    [...ownersSeen].sort(),
    [...bothLabels].sort(),
    `a holder outside the two runners appeared, or one of them claimed nothing: ${[...ownersSeen].join(",")}`
  );

  for (const [index, task] of tasks.entries()) {
    const found = await api(mainURL, `/api/tasks/${task.taskId}`, { cookie: cookies.get(task.taskId) });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    const final = found.body.task;
    assert.equal(final.state, "completed", `task ${index + 1} finished as ${final.state}: ${JSON.stringify(final.error)}`);
    assert.equal(asksFor(prompts[index]), 1, `${prompts[index]} reached the provider ${asksFor(prompts[index])} times`);
    assert.match(final.result.summary, new RegExp(`Runner answered prompt ${index + 1}\\.`));

    const stored = await record(task.taskId);
    // Not "the lease is blank": `mutableFields` has never carried `lease`, so a finished row keeps
    // the last holder's owner and an unexpired expiry stamp. What has to hold is that no runner can
    // claim it again whatever the lease says, which the state clause in the claim filter provides and
    // the check after this loop proves.
    assert.ok(
      !taskState.CLAIMABLE_STATES.includes(stored.state),
      `a completed task is still a claim candidate: ${stored.state}`
    );
    assert.ok(!stored.recovery?.interruptedAt, `a task was interrupted by the other runner: ${JSON.stringify(stored.recovery)}`);

    const replay = await api(
      mainURL,
      `/api/tasks/${task.taskId}/events`,
      { cookie: cookies.get(task.taskId) }
    );
    const seqs = replay.body.events.map(event => event.seq);
    assert.equal(new Set(seqs).size, seqs.length, `task ${index + 1} replayed a progress row twice`);
    assert.equal(
      replay.body.events.filter(event => event.phase === "answer").length,
      1,
      `task ${index + 1} reported its answer more than once`
    );

    // The durable side of the same run: one assistant message, and it is this account's.
    const chat = await api(mainURL, `/api/conversations/${final.conversationId}`, {
      cookie: cookies.get(task.taskId)
    });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    const messages = chat.body.conversation?.messages || chat.body.messages || [];
    const mine = messages.filter(message => (message.role || "").startsWith("assistant"));
    assert.equal(mine.length, 1, `task ${index + 1} wrote ${mine.length} assistant messages into one conversation`);
  }

  assert.equal(
    fakeProvider.state.chatRequests.length,
    prompts.length,
    `${fakeProvider.state.chatRequests.length} upstream calls for ${prompts.length} tasks`
  );
});
