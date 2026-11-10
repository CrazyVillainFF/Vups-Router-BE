/**
 * Phase 8 load harness for the two-backend split: `node scripts/bench-split.mjs`
 *
 * What this is: one process holding a Main app and an Executor app over loopback, an in-memory mongod
 * and the deterministic fake provider — the arrangement `src/serviceRole.test.js` uses, with traffic
 * instead of assertions. It measures the list the brief asks for: Main route latency, hand-off
 * latency, queue wait, task failure rate, duplicate executions, memory, CPU, database ops, provider
 * round trip and recovery time.
 *
 * What this is not: a measurement of Render. Nothing here cold-starts, sleeps, crosses an
 * availability zone, runs in 512 MB or waits on a real model, so every number describes this machine
 * and none of them is a statement about production capacity. The configuration is printed with it.
 *
 * Overrides: BENCH_SECONDS (300), BENCH_RPM (80), BENCH_USERS (200), BENCH_ACTIVE (100),
 * BENCH_PROVIDER_MS (1200), BENCH_LEASE_MS (5000), BENCH_SATURATION (16).
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "bench-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "bench-encryption-secret-with-at-least-32-chars";
// The deployed rate limits reject this traffic by design. The bench measures request handling, and
// the shipped values are in the caveats below rather than silently in force.
process.env.RATE_LIMIT_MAX = "100000";
process.env.CHAT_RATE_LIMIT_MAX = "100000";
process.env.SETTINGS_RATE_LIMIT_MAX = "100000";
process.env.AI_DAILY_QUOTA = "100000";
delete process.env.MONGODB_URI;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.VUPS_BASE_URL;
delete process.env.VUPS_API_KEY;
delete process.env.VUPS_UNDERLYING_MODEL;
process.env.VUPS_MAX_RETRIES = "0";
// No app starts a scheduler here; the run starts and stops the stand-in executor on purpose.
process.env.TASK_WORKER_DISABLED = "1";
delete process.env.TASK_USER_CONCURRENCY;
delete process.env.TASK_WORKER_CONCURRENCY;
delete process.env.SERVER_ROLE;
delete process.env.AI_EXECUTION_URL;
delete process.env.SERVICE_TO_SERVICE_SECRET;
delete process.env.AI_DISPATCH_TIMEOUT_MS;
// The lease is shortened so the recovery probe finishes inside the run. The production default is
// printed next to the measurement, because that is the number a crash is actually bounded by.
process.env.TASK_LEASE_MS = String(Number(process.env.BENCH_LEASE_MS || 5000));

import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";

const CONFIG = {
  // Five minutes at the brief's rate, because 80 req/min only puts ~12 submissions in each minute and
  // a shorter window measures almost nothing on the queue side.
  seconds: Number(process.env.BENCH_SECONDS || 300),
  rpm: Number(process.env.BENCH_RPM || 80),
  users: Number(process.env.BENCH_USERS || 200),
  active: Number(process.env.BENCH_ACTIVE || 100),
  providerMs: Number(process.env.BENCH_PROVIDER_MS || 1200),
  saturation: Number(process.env.BENCH_SATURATION || 16)
};
const PASSWORD = "correct-horse-battery";
const runId = Date.now();

const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_bench_split");

const { startFakeProvider, FAKE_API_KEY } = await import("../src/testUtils/fakeProvider.js");
const fake = await startFakeProvider();

const roleModule = await import("../src/serviceRole.js");
const connectToDatabase = (await import("../src/db.js")).default;
const { default: mongoose } = await import("mongoose");
const { default: Task } = await import("../src/task.js");
const { default: User } = await import("../src/user.js");
const { TERMINAL_STATES } = await import("../src/taskState.js");
const worker = await import("../src/taskWorker.js");
const { consentPolicyVersion, createToken, hashPassword } = await import("../src/auth.js");
const { getJwtSecret } = await import("../src/middleware.js");

const servers = [];
async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

// `index.js` decides its routes while the module is evaluated, and ESM caches by full specifier, so
// a query string gives a second independently role-configured app over the same database.
process.env.SERVER_ROLE = "main";
roleModule.resetServiceRole();
const mainApp = (await import("../src/index.js?role=main")).default;
process.env.SERVER_ROLE = "executor";
roleModule.resetServiceRole();
const executorApp = (await import("../src/index.js?role=executor")).default;
roleModule.resetServiceRole("main");

const mainURL = await listen(mainApp);
const executorURL = await listen(executorApp);
await connectToDatabase();

process.env.SERVICE_TO_SERVICE_SECRET = "bench-service-to-service-secret-with-at-least-32-characters";
process.env.AI_EXECUTION_URL = executorURL;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── measurement plumbing ────────────────────────────────────────────────────

const samples = new Map();
function note(label, ms, failed = false) {
  let entry = samples.get(label);
  if (!entry) samples.set(label, (entry = { ms: [], errors: 0 }));
  entry.ms.push(ms);
  if (failed) entry.errors += 1;
}

function sortedOf(values) {
  return values.filter(Number.isFinite).sort((a, b) => a - b);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

/** A number that survives an empty sample set, so a short run prints n/a rather than NaN. */
function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function report(label, width = 36) {
  const sorted = sortedOf(samples.get(label)?.ms || []);
  if (sorted.length === 0) {
    console.log(`  ${label.padEnd(width)} never fired`);
    return;
  }
  const errors = samples.get(label).errors ? `   errors ${samples.get(label).errors}` : "";
  console.log(
    `  ${label.padEnd(width)} n ${String(sorted.length).padStart(4)}   ` +
      `median ${percentile(sorted, 0.5).toFixed(1).padStart(8)} ms   ` +
      `p90 ${percentile(sorted, 0.9).toFixed(1).padStart(8)} ms   ` +
      `max ${sorted[sorted.length - 1].toFixed(1).padStart(8)} ms${errors}`
  );
}

function section(title) {
  console.log(`\n${title}`);
}

/** One timed HTTP call to the API under test, with the parsed body. */
async function hit(label, base, path, { method = "GET", body, token } = {}) {
  const started = performance.now();
  let status = 0;
  let payload = null;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    status = response.status;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
  } catch {
    status = 0;
  }
  const elapsed = performance.now() - started;
  const failed = method === "GET" ? status !== 200 : status >= 400;
  if (label) note(label, elapsed, failed);
  return { status, body: payload, ms: elapsed };
}

// mongod's own counters, read through the native handle: they cover every process talking to the
// database, including the two apps and the executor scheduler, which this process's driver cannot
// see from the outside. The bench reports the difference between two snapshots.
async function databaseLoad() {
  const native = mongoose.connection.getClient().db(mongoose.connection.name);
  try {
    const status = await native.command({ serverStatus: 1 });
    return {
      available: true,
      counters: status.opcounters,
      residentMb: status.mem?.resident ?? NaN,
      connections: status.connections?.current ?? NaN
    };
  } catch {
    return { available: false, counters: null, residentMb: NaN, connections: NaN };
  }
}

function databaseOps(snap) {
  if (!snap.available) return NaN;
  return Object.values(snap.counters).reduce((total, n) => total + n, 0);
}

function resources() {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return { userUs: cpu.user, systemUs: cpu.system, rssMb: memory.rss / 1048576, heapMb: memory.heapUsed / 1048576 };
}

// ─── accounts ────────────────────────────────────────────────────────────────

section("provisioning");
const provisionStart = performance.now();

// A cost-12 bcrypt hash is deliberately slow, and paying it per account would measure the KDF
// instead of the service. The bulk accounts share one digest — every one of them still authenticates
// with a real password check — while a handful of genuine signups and sign-ins are timed on their own.
const sharedDigest = await hashPassword(PASSWORD);
const inserted = await User.insertMany(
  Array.from({ length: CONFIG.users }, (_unused, index) => ({
    name: `Bench ${index}`,
    email: `bench-${runId}-${index}@example.com`,
    passwordHash: sharedDigest,
    termsAcceptedAt: new Date(),
    termsVersion: consentPolicyVersion(undefined)
  }))
);
const jwtSecret = getJwtSecret();
// A session token minted by the same `createToken` the sign-in route uses, so every request below
// carries a real session; only the bcrypt step of signing in is skipped, and it is timed separately.
const accounts = inserted.map(user => ({ email: user.email, token: createToken(user, jwtSecret) }));

for (let i = 0; i < 5; i += 1) {
  const created = await hit("POST /auth/signup (bcrypt 12)", mainURL, "/api/auth/signup", {
    method: "POST",
    body: { name: "Bench Signup", email: `bench-signup-${runId}-${i}@example.com`, password: PASSWORD, acceptTerms: true }
  });
  assert.equal(created.status, 201, `timed signup failed with ${created.status}`);
}
for (let i = 0; i < 3; i += 1) {
  const again = await hit("POST /auth/signin (bcrypt 12)", mainURL, "/api/auth/signin", {
    method: "POST",
    body: { email: accounts[i].email, password: PASSWORD }
  });
  assert.equal(again.status, 200, `timed signin failed with ${again.status}`);
}

const configured = [];
for (const account of accounts.slice(0, CONFIG.active)) {
  const saved = await hit(null, mainURL, "/api/settings/provider", {
    method: "PUT",
    token: account.token,
    body: { provider: "Fake OpenAI-compatible", baseUrl: fake.baseUrl, apiKey: FAKE_API_KEY, model: "fake-model-mini" }
  });
  assert.equal(saved.status, 200, `provider configuration failed with ${saved.status}`);
  configured.push(account);
}
console.log(
  `  ${CONFIG.users} registered, ${CONFIG.active} with a provider configured over HTTP, in ` +
    `${((performance.now() - provisionStart) / 1000).toFixed(1)}s`
);

fake.state.reset();
fake.state.set({ chatDelayMs: CONFIG.providerMs, chatResponseText: "Bench answer." });

// ─── mixed traffic ───────────────────────────────────────────────────────────

const known = [];
const inFlightTaskIds = new Set();
let submits = 0;
let cancelled = 0;
let cancelRefused = 0;
let deferred = 0;

async function submitTask(account, label) {
  const prompt = `bench ${runId} task ${submits} ${account.email}`;
  const created = await hit(label, mainURL, "/api/tasks", { method: "POST", token: account.token, body: { prompt } });
  if (created.status === 202) {
    submits += 1;
    const taskId = created.body.task.taskId;
    known.push({ taskId, token: account.token });
    inFlightTaskIds.add(taskId);
  }
  return created;
}

/** A task this account still has open, for the cancellation leg. */
function openTaskOf(token) {
  return known.find(entry => entry.token === token && inFlightTaskIds.has(entry.taskId));
}

/** The newest task this token owns, which is the only one its own reads may address. */
function ownedTaskOf(token) {
  for (let i = known.length - 1; i >= 0; i -= 1) {
    if (known[i].token === token) return known[i];
  }
  return null;
}

// Submissions come from a rotating account, so most readers do not own a task yet within one cycle.
// A read leg then takes a task from the round-robin and asks as *its owner*, because a read made as a
// non-owner is a 404 by design: it would measure the refusal rather than the route.
let readCursor = 0;
function readableTask(account) {
  return ownedTaskOf(account.token) || (known.length ? known[readCursor++ % known.length] : null);
}

async function oneRequest(kind, account) {
  switch (kind) {
    case "me":
      return hit("GET /auth/me", mainURL, "/api/auth/me", { token: account.token });
    case "list":
      return hit("GET /tasks?limit=20", mainURL, "/api/tasks?limit=20", { token: account.token });
    case "settings":
      return hit("GET /settings/provider", mainURL, "/api/settings/provider", { token: account.token });
    case "detail": {
      const pick = readableTask(account);
      if (!pick) {
        deferred += 1;
        return oneRequest("me", account);
      }
      return hit("GET /tasks/:id", mainURL, `/api/tasks/${pick.taskId}`, { token: pick.token });
    }
    case "events": {
      const pick = readableTask(account);
      if (!pick) {
        deferred += 1;
        return oneRequest("me", account);
      }
      return hit("GET /tasks/:id/events", mainURL, `/api/tasks/${pick.taskId}/events`, { token: pick.token });
    }
    case "submit":
      return submitTask(account, "POST /tasks (submit)");
    case "cancel": {
      const open = openTaskOf(account.token) || known.find(entry => inFlightTaskIds.has(entry.taskId));
      if (!open) {
        deferred += 1;
        return oneRequest("me", account);
      }
      const result = await hit(null, mainURL, `/api/tasks/${open.taskId}/cancel`, {
        method: "POST",
        token: open.token,
        body: {}
      });
      // Cancelling a record that already finished answers 200 with that record unchanged: the route is
      // idempotent, so the state is what says whether this request actually stopped anything.
      note("POST /tasks/:id/cancel", result.ms, result.status >= 500 || result.status === 0);
      inFlightTaskIds.delete(open.taskId);
      if (result.body?.task?.state === "cancelled") cancelled += 1;
      else cancelRefused += 1;
      return result;
    }
    default:
      throw new Error(`unknown bench request kind "${kind}"`);
  }
}

// Deterministic mix, so a rerun is comparable: the weights are the share of each hundred requests.
// Submission leads the cycle because the read legs need a task to read — a mix that put them first
// would spend every short run's detail and events calls waiting for a record that has not landed.
const MIX = [
  ["submit", 12],
  ["detail", 15],
  ["events", 15],
  ["me", 30],
  ["list", 20],
  ["settings", 5],
  ["cancel", 3]
];
function kindFor(index) {
  const bucket = index % 100;
  let walked = 0;
  for (const [kind, weight] of MIX) {
    walked += weight;
    if (bucket < walked) return kind;
  }
  return "me";
}

section("mixed traffic");
console.log(
  `  ${CONFIG.rpm} req/min for ${CONFIG.seconds}s against Main, which hands off to the executor over loopback; ` +
    `simulated provider think time ${CONFIG.providerMs} ms`
);
const dbBefore = await databaseLoad();
const cpuBefore = resources();
let peakRssMb = cpuBefore.rssMb;
let peakHeapMb = cpuBefore.heapMb;
const trafficStart = Date.now();
worker.startTaskWorker();

const pending = new Set();
let issued = 0;
let peakClientConcurrency = 0;
let nextAt = Date.now();
const stopAt = trafficStart + CONFIG.seconds * 1000;
while (Date.now() < stopAt) {
  const run = oneRequest(kindFor(issued), configured[issued % configured.length])
    .catch(() => note("client-side failures", 0, true))
    .finally(() => pending.delete(run));
  pending.add(run);
  peakClientConcurrency = Math.max(peakClientConcurrency, pending.size);
  issued += 1;
  if (issued % 25 === 0) {
    const now = resources();
    peakRssMb = Math.max(peakRssMb, now.rssMb);
    peakHeapMb = Math.max(peakHeapMb, now.heapMb);
  }
  nextAt += 60000 / CONFIG.rpm;
  const wait = nextAt - Date.now();
  if (wait > 0) await sleep(wait);
}
await Promise.allSettled([...pending]);
const trafficSeconds = (Date.now() - trafficStart) / 1000;
const cpuAfter = resources();
const dbAfter = await databaseLoad();
const dbOps =
  dbAfter.available && dbBefore.available ? databaseOps(dbAfter) - databaseOps(dbBefore) : NaN;

// Drain so the census below describes the whole run rather than a moment inside it.
const drainDeadline = Date.now() + 120000;
while (Date.now() < drainDeadline) {
  const open = await Task.countDocuments({ state: { $nin: [...TERMINAL_STATES, "waiting_for_user", "waiting_for_permission"] } });
  if (open === 0) break;
  await sleep(500);
}

section("Main route latency (measured at the client)");
for (const label of [
  "GET /auth/me",
  "GET /tasks?limit=20",
  "GET /tasks/:id",
  "GET /tasks/:id/events",
  "GET /settings/provider",
  "POST /tasks (submit)",
  "POST /tasks/:id/cancel",
  "POST /auth/signup (bcrypt 12)",
  "POST /auth/signin (bcrypt 12)"
]) {
  report(label);
}
console.log(
  `  ${issued} requests in ${trafficSeconds.toFixed(1)}s = ${((issued / trafficSeconds) * 60).toFixed(1)} req/min, ` +
    `peak concurrent client requests ${peakClientConcurrency}, ` +
    `legs deferred for want of a task ${deferred}, cancellations that stopped a task ${cancelled}, ` +
    `cancellations that found a finished record ${cancelRefused}`
);

// ─── queue, hand-off, duplicates ─────────────────────────────────────────────

const since = new Date(trafficStart - 5000);
const bench = await Task.find(
  { createdAt: { $gte: since } },
  { state: 1, createdAt: 1, startedAt: 1, completedAt: 1, lease: 1, dispatch: 1, recovery: 1, events: 1 }
).lean();

function stamp(value) {
  // A Date must go through getTime(): `Date.parse(date)` stringifies first, and that string has no
  // milliseconds, which quantises every duration in this report to a whole second.
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

function span(from, to) {
  return from && to ? stamp(to) - stamp(from) : NaN;
}
samples.set("hand-off receipt (created -> dispatch.lastAt)", {
  ms: bench.map(task => span(task.createdAt, task.dispatch?.lastAt)),
  errors: 0
});
samples.set("queue wait (created -> lease.claimedAt)", {
  ms: bench.map(task => span(task.createdAt, task.lease?.claimedAt)),
  errors: 0
});
samples.set("execution (startedAt -> completedAt)", {
  ms: bench.map(task => span(task.startedAt, task.completedAt)),
  errors: 0
});

const census = await Task.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$state", n: { $sum: 1 } } }]);
const byState = Object.fromEntries(census.map(row => [row._id, row.n]));
const failedTasks = byState.failed || 0;
const multiAttempt = bench.filter(task => (task.dispatch?.attempts || 0) > 1).length;
const recoveredTasks = bench.filter(task => (task.recovery?.restarts || 0) > 0).length;

// Every submission carries a unique marker, so the provider's own log says how often the machine
// behind a task was really asked. One ask per task is the requirement; anything above it is a
// duplicate execution this run caused.
const asksPerTask = new Map();
for (const entry of fake.state.chatRequests) {
  const match = JSON.stringify(entry.body?.messages || "").match(/bench \d+ task (\d+)/);
  if (!match) continue;
  asksPerTask.set(match[1], (asksPerTask.get(match[1]) || 0) + 1);
}
const repeatedTasks = [...asksPerTask.values()].filter(n => n > 1).length;
const extraAsks = [...asksPerTask.values()].reduce((total, n) => total + Math.max(0, n - 1), 0);

const seqRepeats = await Task.aggregate([
  { $match: { createdAt: { $gte: since } } },
  { $project: { n: { $size: { $ifNull: ["$events", []] } }, u: { $size: { $setUnion: [{ $ifNull: ["$events.seq", []] }, []] } } } },
  { $match: { $expr: { $gt: ["$n", "$u"] } } },
  { $count: "tasks" }
]);
const rowsPerTask = sortedOf(bench.map(task => (task.events || []).length));

section("queue, hand-off and duplicates");
for (const label of [
  "hand-off receipt (created -> dispatch.lastAt)",
  "queue wait (created -> lease.claimedAt)",
  "execution (startedAt -> completedAt)"
]) {
  report(label, 44);
}
console.log(`  task states at the end: ${JSON.stringify(byState)}`);
console.log(
  `  failure rate: ${(bench.length ? (failedTasks / bench.length) * 100 : 0).toFixed(1)}% ` +
    `(${failedTasks} failed of ${bench.length} recorded in this run)`
);
console.log(`  hand-offs recorded more than once for one task: ${multiAttempt}`);
console.log(`  instructions the provider was asked about more than once: ${repeatedTasks} (extra requests ${extraAsks})`);
console.log(`  tasks that needed a recovery pass: ${recoveredTasks}`);
console.log(
  `  progress rows per task: median ${fmt(percentile(rowsPerTask, 0.5), 0)}, max ${rowsPerTask[rowsPerTask.length - 1] ?? 0}; ` +
    `tasks whose replay repeated a sequence number: ${seqRepeats[0]?.tasks ?? 0}`
);
console.log(`  provider requests served: ${fake.state.chatRequests.length}, peak concurrent ${fake.state.chatMaxInFlight}`);

// Ownership is checked on the shared collection, because both roles read the same documents: a task
// created by one account has to be invisible to every other, or splitting the services would widen
// the audience for somebody's prompts. A 200 here would be the finding, so the run stops on it.
if (known.length > 1) {
  const victim = known[known.length - 1];
  const stranger = accounts.find(entry => entry.token !== victim.token);
  const probes = [
    await hit(null, mainURL, `/api/tasks/${victim.taskId}`, { token: stranger.token }),
    await hit(null, mainURL, `/api/tasks/${victim.taskId}/events`, { token: stranger.token }),
    await hit(null, mainURL, `/api/tasks/${victim.taskId}/cancel`, { method: "POST", token: stranger.token, body: {} })
  ];
  const leaked = probes.filter(result => result.status === 200).length;
  console.log(
    `  a stranger reading or cancelling another account's task: ${probes.map(r => r.status).join("/")} ` +
      `(${leaked === 0 ? "all refused" : `${leaked} LEAKED`})`
  );
  assert.equal(leaked, 0, `cross-account task access returned 200: ${JSON.stringify(probes.map(r => r.status))}`);
  const stillOpen = await Task.findOne({ taskId: victim.taskId }).select("state").lean();
  console.log(`  the probed task is still in state ${stillOpen?.state}, unchanged by the refused cancellation`);
}

// ─── saturation: one account, a whole backlog at once ────────────────────────

section("saturation probe (one account, every task queued at once)");
const busy = configured[0];
const satStart = Date.now();
const satIds = [];
for (let i = 0; i < CONFIG.saturation; i += 1) {
  const created = await hit("POST /tasks (submit, saturated)", mainURL, "/api/tasks", {
    method: "POST",
    token: busy.token,
    body: { prompt: `bench ${runId} saturate ${i} ${busy.email}` }
  });
  if (created.status === 202) satIds.push(created.body.task.taskId);
}
worker.startTaskWorker();
const satDeadline = Date.now() + 120000;
let drainedAt = null;
while (Date.now() < satDeadline) {
  const open = await Task.countDocuments({
    taskId: { $in: satIds },
    state: { $nin: [...TERMINAL_STATES, "waiting_for_user", "waiting_for_permission"] }
  });
  if (open === 0) {
    drainedAt = Date.now();
    break;
  }
  await sleep(250);
}
const satTasks = await Task.find({ taskId: { $in: satIds } }, { createdAt: 1, lease: 1 }).lean();
const satQueue = sortedOf(satTasks.map(task => span(task.createdAt, task.lease?.claimedAt)));
report("POST /tasks (submit, saturated)", 44);
console.log(
  `  ${satIds.length}/${CONFIG.saturation} accepted; drain ${drainedAt ? `${((drainedAt - satStart) / 1000).toFixed(1)}s` : "not reached in 120s"}; ` +
    `queue wait median ${fmt(percentile(satQueue, 0.5), 0)} ms, worst ${fmt(satQueue[satQueue.length - 1], 0)} ms`
);
console.log(
  `  caps in force: ${worker.taskUserConcurrency()} per account and ${worker.taskWorkerConcurrency()} in the pool, ` +
    `so one chat's backlog cannot become everybody else's queue`
);

// ─── recovery: the runner stops while it holds work ──────────────────────────

section("recovery probe (graceful runner restart with tasks in flight)");
const heldIds = [];
for (let i = 0; i < 4; i += 1) {
  const created = await submitTask(configured[i + 1], null);
  if (created.status === 202) heldIds.push(created.body.task.taskId);
}
const holdDeadline = Date.now() + 15000;
while (Date.now() < holdDeadline && worker.runningTaskIds().length === 0) await sleep(25);
const stoppedAt = Date.now();
await worker.stopTaskWorker();
const interrupted = await Task.countDocuments({ taskId: { $in: heldIds }, "recovery.interruptedAt": { $ne: null } });
await sleep(1000);
const restartedAt = Date.now();
worker.startTaskWorker();
const recoverDeadline = Date.now() + 60000;
let allRecoveredAt = null;
while (Date.now() < recoverDeadline) {
  const open = await Task.countDocuments({
    taskId: { $in: heldIds },
    state: { $nin: [...TERMINAL_STATES, "waiting_for_user", "waiting_for_permission"] }
  });
  if (open === 0) {
    allRecoveredAt = Date.now();
    break;
  }
  await sleep(100);
}
const heldStates = await Task.aggregate([
  { $match: { taskId: { $in: heldIds } } },
  { $group: { _id: "$state", n: { $sum: 1 } } }
]);
// `recovery.restarts` is incremented only by the reconciliation pass, not by the stop itself.
const restarts = await Task.countDocuments({ taskId: { $in: heldIds }, "recovery.restarts": { $gt: 0 } });
console.log(
  `  ${heldIds.length} tasks held; ${interrupted} marked interrupted by the stop; ${restarts} counted a restart by the ` +
    `reconciliation pass; runner down ${restartedAt - stoppedAt} ms; ` +
    `restart -> all terminal ${allRecoveredAt ? `${allRecoveredAt - restartedAt} ms` : "not reached in 60s"}`
);
console.log(`  states after recovery: ${JSON.stringify(Object.fromEntries(heldStates.map(row => [row._id, row.n])))}`);
console.log(
  `  this is a graceful stop, which releases the lease on the record. A hard kill is bounded by the lease: ` +
    `${process.env.TASK_LEASE_MS} ms here, 30000 ms by default in production, plus one ${worker.taskTickMs()} ms poll. ` +
    `Correctness of the crash path is asserted by SR-18, not measured here.`
);

// ─── provider, process, database ─────────────────────────────────────────────

section("provider, process and database");
fake.state.set({ chatDelayMs: 0 });
const direct = [];
for (let i = 0; i < 10; i += 1) {
  const started = performance.now();
  const response = await fetch(`${fake.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FAKE_API_KEY}` },
    body: JSON.stringify({ model: "fake-model-mini", messages: [{ role: "user", content: "ping" }] })
  });
  await response.arrayBuffer();
  direct.push(performance.now() - started);
}
const directSorted = sortedOf(direct);
console.log(
  `  provider round trip over loopback with no think time: median ${percentile(directSorted, 0.5).toFixed(1)} ms, ` +
    `max ${directSorted[directSorted.length - 1].toFixed(1)} ms (the task path added ${CONFIG.providerMs} ms of simulated thinking)`
);

const userMs = (cpuAfter.userUs - cpuBefore.userUs) / 1000;
const systemMs = (cpuAfter.systemUs - cpuBefore.systemUs) / 1000;
console.log(
  `  node during the traffic phase: ${userMs.toFixed(0)} ms user + ${systemMs.toFixed(0)} ms system over ` +
    `${(trafficSeconds * 1000).toFixed(0)} ms wall = ${(((userMs + systemMs) / (trafficSeconds * 1000)) * 100).toFixed(1)}% of one core`
);
console.log(
  `  rss ${cpuBefore.rssMb.toFixed(0)} -> ${cpuAfter.rssMb.toFixed(0)} MB (peak ${peakRssMb.toFixed(0)}), heap ` +
    `${cpuBefore.heapMb.toFixed(0)} -> ${cpuAfter.heapMb.toFixed(0)} MB (peak ${peakHeapMb.toFixed(0)}) in one process holding both roles, the API and the database`
);
const dbBreakdown = dbAfter.available && dbBefore.available
  ? Object.entries(dbAfter.counters).map(([name, n]) => `${name} ${n - dbBefore.counters[name]}`).join(", ")
  : "serverStatus unavailable";
console.log(
  `  database operations during the traffic phase: ${fmt(dbOps, 0)} counted by mongod = ` +
    `${fmt(dbOps / trafficSeconds, 1)}/s (${dbBreakdown})`
);
try {
  const stats = await mongoose.connection.db.command({ dbStats: 1 });
  console.log(
    `  database size: ${(stats.dataSize / 1048576).toFixed(2)} MB of data in ${stats.objects} documents, ` +
      `${stats.indexes} indexes, ${stats.storageSize ? (stats.storageSize / 1048576).toFixed(2) : "n/a"} MB allocated`
  );
} catch {
  console.log("  dbStats is unavailable on this mongod, so storage size was not measured");
}
console.log(
  `  mongod resident ${fmt(dbBefore.residentMb, 0)} -> ${fmt(dbAfter.residentMb, 0)} MB, ` +
    `connections open ${fmt(dbBefore.connections, 0)} -> ${fmt(dbAfter.connections, 0)}`
);
const docSize = await Task.aggregate([
  { $match: { createdAt: { $gte: since } } },
  { $project: { bytes: { $bsonSize: "$$ROOT" } } },
  { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: "$bytes" }, max: { $max: "$bytes" } } }
]);
if (docSize[0]) {
  console.log(
    `  task document size: avg ${(docSize[0].avg / 1024).toFixed(1)} KB, max ${(docSize[0].max / 1024).toFixed(1)} KB ` +
      `across ${docSize[0].n} docs (progress rows live inside the task document)`
  );
}

section("caveats");
console.log(
  "  1. One process, loopback network, in-memory mongod, fake provider: these are handling costs, not Render capacity.\n" +
    "  2. Render Free sleeps when unattended, and its cold start dominates a real first request. Nothing here measures it.\n" +
    "  3. Rate limits and the daily quota were raised for this run; the deployed values bite far below these numbers.\n" +
    "  4. A real provider answers in hundreds of ms to tens of seconds, rate-limits and fails; the fake only delays.\n" +
    "  5. The split was exercised in one process, which cannot show cross-region latency or a second instance's memory.\n" +
    "  6. No persistent filesystem is modelled, and this code path uses none.\n" +
    "  7. Recovery here is a graceful stop; the hard-kill bound is the lease TTL printed above."
);

await worker.stopTaskWorker();
for (const server of servers) await new Promise(resolve => server.close(resolve));
await fake.close();
await mongoose.disconnect();
await mongod.stop();
