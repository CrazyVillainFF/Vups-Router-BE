import assert from "node:assert/strict";
import { after, test } from "node:test";

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

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_desktop_progress_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const { default: TaskRun, MAX_PROGRESS_EVENTS } = await import("./taskRun.js");
const {
  appendRunEvents,
  describeToolCall,
  progressText,
  settleToolResults,
  toolCallEvents
} = await import("./taskEvents.js");

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await fakeProvider.close();
  await mongoose.disconnect();
  await mongod.stop();
});

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `progress${Date.now()}-${counter}@example.com`;
}

function runId(label) {
  counter += 1;
  return `progress_${label}_${Date.now()}_${counter}`;
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

async function newUser() {
  fakeProvider.state.reset();
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Progress Tester", email: uniqueEmail(), password: "correct-horse-battery", acceptTerms: true }
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

const WORKSPACE = "C:\\Projects\\demo-app";
const FILE_BODY = "export default function App(){return <div>SECRETFILEBODY</div>}";

function replayMessage(step) {
  const messages = [
    {
      role: "assistant",
      content: null,
      tool_calls: step.calls.map((call, index) => ({
        id: call.id || `fake_call_${index}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
      }))
    }
  ];
  for (const result of step.results ?? []) {
    messages.push({ role: "tool", tool_call_id: result.callId, content: JSON.stringify(result.payload) });
  }
  return messages;
}

/**
 * One round of the desktop tool loop, shaped exactly like the Windows app sends
 * it: the whole history replayed, the calls the model asked for this round, and
 * the folder the app has bound to the turn.
 */
async function toolRound({
  run,
  cookie,
  workspacePath = WORKSPACE,
  userText = "Build the app file.",
  assistantMessageId,
  steps = [],
  calls = null,
  ...provider
}) {
  fakeProvider.state.set({ toolCalls: calls ?? null, ...provider });
  const messages = [{ role: "user", content: userText }];
  for (const step of steps) messages.push(...replayMessage(step));
  return api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: run,
      messages,
      ...(workspacePath ? { workspacePath } : {}),
      ...(assistantMessageId ? { assistantMessageId } : {})
    }
  });
}

function rows(response) {
  return Array.isArray(response?.events) ? response.events : [];
}

test("a tool round reports the call the model really made, without the file it carried", async () => {
  const cookie = await newUser();
  const response = await toolRound({
    run: runId("callrow"),
    cookie,
    calls: [{ id: "call_1", name: "write_file", args: { path: `${WORKSPACE}\\src\\App.jsx`, content: FILE_BODY } }]
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.type, "tool_calls");
  const events = rows(response.body);
  assert.ok(events.length >= 3, `expected a task, a provider and a tool row, got ${JSON.stringify(events)}`);

  assert.equal(events[0].phase, "task");
  assert.equal(events[0].path, WORKSPACE);
  assert.match(events[0].message, /Working in /);

  const providerRow = events.find(event => event.phase === "provider");
  assert.equal(providerRow.status, "running");
  assert.equal(events[1].seq, 2, "events are numbered from one, in order");

  const toolRow = events.at(-1);
  assert.equal(toolRow.phase, "tool");
  assert.equal(toolRow.tool, "write_file");
  assert.equal(toolRow.callId, "call_1");
  assert.equal(toolRow.status, "running", "a call is only finished when the app reports it");
  assert.equal(toolRow.path, `${WORKSPACE}\\src\\App.jsx`);
  assert.ok(events.every(event => event.at), "every row carries its own timestamp");

  const dump = JSON.stringify(events);
  assert.doesNotMatch(dump, /SECRETFILEBODY/, "file contents never belong in a progress row");
  assert.doesNotMatch(dump, new RegExp(FAKE_API_KEY, "i"));
});

test("the run state is durable in the database, not process memory", async () => {
  const cookie = await newUser();
  const run = runId("durable");
  await toolRound({
    run,
    cookie,
    calls: [{ id: "call_1", name: "list_directory", args: { path: `${WORKSPACE}\\src` } }]
  });

  const stored = await TaskRun.findOne({ runId: run }).lean();
  assert.ok(stored, "the round budget and its log must outlive this request");
  assert.equal(stored.runId, run);
  assert.equal(stored.steps, 1);
  assert.equal(stored.busy, false, "a finished round never leaves the run locked");
  assert.deepEqual(
    stored.pending.map(call => call.id),
    ["call_1"],
    "the calls handed to the app are recorded so their results can be paired"
  );
  assert.equal(stored.events.at(-1).tool, "list_directory");
  assert.equal(stored.workspacePath, WORKSPACE);
  assert.ok(stored.expiresAt instanceof Date);
});

test("a reported result settles its own row and is never recorded twice on replay", async () => {
  const cookie = await newUser();
  const run = runId("pairing");
  const writeCall = { id: "call_1", name: "write_file", args: { path: `${WORKSPACE}\\App.jsx` } };
  const readCall = { id: "call_2", name: "read_file", args: { path: `${WORKSPACE}\\index.html` } };

  const first = await toolRound({ run, cookie, calls: [writeCall] });
  assert.equal(first.body.type, "tool_calls");

  const second = await toolRound({
    run,
    cookie,
    // The client replays the whole history every round, so the first call and
    // its result are still in the messages while the second call is issued.
    steps: [{ calls: [writeCall], results: [{ callId: "call_1", payload: { ok: true, data: { path: `${WORKSPACE}\\App.jsx`, bytes: 12 } } }] }],
    calls: [readCall]
  });
  assert.equal(second.status, 200);
  const settled = rows(second.body).filter(event => event.callId === "call_1");
  assert.equal(settled.length, 1, "one outcome per call, however often the history is replayed");
  assert.equal(settled[0].status, "completed");
  assert.equal(settled[0].tool, "write_file");
  assert.match(settled[0].message, /write_file completed/);

  const third = await toolRound({
    run,
    cookie,
    steps: [
      { calls: [writeCall], results: [{ callId: "call_1", payload: { ok: true, data: { path: `${WORKSPACE}\\App.jsx` } } }] },
      { calls: [readCall], results: [{ callId: "call_2", payload: { ok: true, data: { path: `${WORKSPACE}\\index.html`, content: "<html>" } } }] }
    ],
    chatResponseText: "Both files are in place."
  });
  assert.equal(third.status, 200);
  assert.equal(third.body.type, "final");
  const reported = rows(third.body).filter(event => event.callId);
  assert.deepEqual(
    reported.map(event => `${event.callId}:${event.status}`),
    ["call_2:completed"],
    "the replayed first result is not recorded a second time"
  );
  assert.equal(await TaskRun.findOne({ runId: run }), null, "a completed run is cleaned up once the turn is saved");
});

test("work the app did before the model was asked is still in the log", async () => {
  const cookie = await newUser();
  const run = runId("fastpath");
  const locateCall = { id: "fast_locate", name: "get_windows_known_folder", args: { name: "downloads" } };
  const listCall = { id: "fast_read", name: "list_recent_files", args: { path: "C:\\Users\\Vishnu\\Downloads", limit: 5 } };
  const steps = [
    {
      calls: [locateCall],
      results: [{ callId: "fast_locate", payload: { ok: true, data: { path: "C:\\Users\\Vishnu\\Downloads" } } }]
    },
    {
      calls: [listCall],
      results: [{ callId: "fast_read", payload: { ok: false, error: { code: "access_denied", message: "Windows refused the read." } } }]
    }
  ];

  const first = await toolRound({
    run,
    cookie,
    userText: "What are my five latest downloads?",
    steps,
    calls: [{ id: "call_1", name: "list_directory", args: { path: `${WORKSPACE}\\src` } }]
  });
  assert.equal(first.status, 200);
  const firstRows = first.body.events;
  const locate = firstRows.find(event => event.callId === "fast_locate");
  assert.equal(locate.phase, "tool", "a real operation is a tool row, not a note");
  assert.equal(locate.status, "completed");
  assert.equal(locate.tool, "get_windows_known_folder");
  assert.equal(locate.path, "C:\\Users\\Vishnu\\Downloads");
  const listed = firstRows.find(event => event.callId === "fast_read");
  assert.equal(listed.status, "failed", "the payload decides the outcome, not the run's optimism");
  assert.equal(listed.code, "access_denied");

  const second = await toolRound({
    run,
    cookie,
    userText: "What are my five latest downloads?",
    steps: [...steps, { calls: [{ id: "call_1", name: "list_directory", args: { path: `${WORKSPACE}\\src` } }], results: [{ callId: "call_1", payload: { ok: true, data: { path: `${WORKSPACE}\\src` } } }] }],
    chatResponseText: "Windows refused to list the folder."
  });
  assert.equal(second.body.type, "final");
  assert.deepEqual(
    rows(second.body).filter(event => event.callId).map(event => `${event.callId}:${event.status}`),
    ["call_1:completed"],
    "the fast path rows already in the log are not written again by the next round"
  );

  const stored = await TaskRun.findOne({ runId: run }).lean();
  assert.equal(stored, null, "the run is cleaned up once its turn is saved");
  const loaded = await api(`/api/conversations/${second.body.conversationId}`, { cookie });
  const answer = loaded.body.conversation.messages.find(message => message.role === "assistant");
  const toolRows = answer.progress.filter(event => event.phase === "tool");
  assert.deepEqual(
    toolRows.map(event => `${event.callId}:${event.status}`),
    ["fast_locate:completed", "fast_read:failed", "call_1:completed"],
    "the saved turn keeps one honest line per operation the app really ran"
  );
});

test("a refused operation is reported as a failure with its real code", async () => {
  const cookie = await newUser();
  const run = runId("denied");
  const deleteCall = { id: "call_1", name: "delete_path", args: { path: "C:\\Windows\\System32\\x.dat" } };
  await toolRound({ run, cookie, userText: "Delete this file.", calls: [deleteCall] });

  const second = await toolRound({
    run,
    cookie,
    userText: "Delete this file.",
    steps: [
      {
        calls: [deleteCall],
        results: [{ callId: "call_1", payload: { ok: false, error: { code: "outside_workspace", message: "Outside the workspace." } } }]
      }
    ],
    chatResponseText: "That delete was refused."
  });

  const failed = rows(second.body).find(event => event.callId === "call_1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, "outside_workspace");
  assert.match(failed.message, /delete_path failed: outside_workspace/);
  assert.doesNotMatch(JSON.stringify(rows(second.body)), /delete_path completed/);
});

test("the saved answer carries the real step log so a reload can replay it", async () => {
  const cookie = await newUser();
  const run = runId("replay");
  const assistantMessageId = String(new mongoose.Types.ObjectId());
  const userText = "Make a src folder in my project.";
  const createCall = { id: "call_1", name: "create_directory", args: { path: `${WORKSPACE}\\src` } };

  const first = await toolRound({
    run,
    cookie,
    userText,
    assistantMessageId,
    calls: [createCall]
  });
  assert.equal(first.body.type, "tool_calls");

  const second = await toolRound({
    run,
    cookie,
    userText,
    assistantMessageId,
    steps: [
      { calls: [createCall], results: [{ callId: "call_1", payload: { ok: true, data: { path: `${WORKSPACE}\\src`, created: true } } }] }
    ],
    chatResponseText: "Created C:\\Projects\\demo-app\\src."
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.type, "final");
  const conversationId = second.body.conversationId;
  assert.ok(conversationId);

  const loaded = await api(`/api/conversations/${conversationId}`, { cookie });
  assert.equal(loaded.status, 200);
  const assistant = loaded.body.conversation.messages.find(message => message.role === "assistant");
  assert.ok(Array.isArray(assistant.progress), "the reloaded message carries its steps");
  const seqs = assistant.progress.map(event => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "the log replays in the order it happened");
  assert.deepEqual(
    assistant.progress.map(event => event.phase),
    ["task", "provider", "tool", "provider", "answer"],
    `unexpected log shape: ${JSON.stringify(assistant.progress)}`
  );
  const created = assistant.progress.find(event => event.tool === "create_directory");
  assert.equal(created.status, "completed");
  assert.equal(created.path, `${WORKSPACE}\\src`);
  assert.doesNotMatch(JSON.stringify(assistant.progress), /secret|apiKey/i);
});

test("progress can be polled for a running task and is owner scoped", async () => {
  const owner = await newUser();
  const other = await newUser();
  const run = runId("poll");
  await toolRound({
    run,
    cookie: owner,
    calls: [{ id: "call_1", name: "search_files", args: { directory: WORKSPACE, query: "note" } }]
  });

  const mine = await api(`/api/chat/desktop-tools/events?runId=${run}`, { cookie: owner });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.busy, false);
  assert.equal(mine.body.steps, 1);
  assert.ok(mine.body.events.length >= 3);
  assert.equal(mine.body.events[0].phase, "task");

  const cursor = await api(`/api/chat/desktop-tools/events?runId=${run}&after=1`, { cookie: owner });
  assert.equal(cursor.status, 200);
  assert.equal(cursor.body.events.length, mine.body.events.length - 1, "the cursor returns only newer rows");

  const foreign = await api(`/api/chat/desktop-tools/events?runId=${run}`, { cookie: other });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, "run_not_found");

  const bad = await api("/api/chat/desktop-tools/events?runId=short", { cookie: owner });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "invalid_run_id");
});

test("a second round cannot spend the same run while the model is still answering", async () => {
  const cookie = await newUser();
  const run = runId("busy");
  const inflight = toolRound({
    run,
    cookie,
    chatDelayMs: 600,
    calls: [{ id: "call_1", name: "list_directory", args: { path: WORKSPACE } }]
  });
  await new Promise(resolve => setTimeout(resolve, 200));

  const concurrent = await toolRound({
    run,
    cookie,
    calls: [{ id: "call_2", name: "list_directory", args: { path: WORKSPACE } }]
  });
  assert.equal(concurrent.status, 409);
  assert.equal(concurrent.body.code, "run_busy");

  const first = await inflight;
  assert.equal(first.status, 200);
  const stored = await TaskRun.findOne({ runId: run }).lean();
  assert.equal(stored.busy, false, "the lock is released whatever the round did");
});

test("an idle-expired run starts a fresh budget instead of inheriting half a task", async () => {
  const cookie = await newUser();
  const run = runId("expired");
  await toolRound({ run, cookie, calls: [{ id: "call_1", name: "list_directory", args: { path: WORKSPACE } }] });
  await TaskRun.updateOne(
    { runId: run },
    { $set: { lastUsedAt: Date.now() - 20 * 60 * 1000, expiresAt: new Date(Date.now() - 60 * 1000) } }
  );

  const gone = await api(`/api/chat/desktop-tools/events?runId=${run}`, { cookie });
  assert.equal(gone.status, 404, "an expired task is not offered as if it were still running");

  const fresh = await toolRound({ run, cookie, calls: [{ id: "call_2", name: "list_directory", args: { path: WORKSPACE } }] });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.steps, 1, "a new run of the same id starts from a clean round budget");
  assert.equal(rows(fresh.body)[0].seq, 1, "and its log starts over instead of carrying the old one");
});

test("a provider failure is recorded as a failure and leaves the log readable", async () => {
  const cookie = await newUser();
  const run = runId("providerfail");
  const listCall = { id: "call_1", name: "list_directory", args: { path: WORKSPACE } };
  await toolRound({ run, cookie, calls: [listCall] });

  const failed = await toolRound({
    run,
    cookie,
    chatStatus: 503,
    steps: [{ calls: [listCall], results: [{ callId: "call_1", payload: { ok: true, data: { path: WORKSPACE } } }] }]
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "provider_unavailable");

  const stored = await TaskRun.findOne({ runId: run }).lean();
  const last = stored.events.at(-1);
  assert.equal(last.phase, "provider");
  assert.equal(last.status, "failed");
  assert.equal(last.code, "provider_unavailable");
  assert.doesNotMatch(JSON.stringify(stored.events), /Provider failure\./, "raw provider text is not copied into the log");
  const polled = await api(`/api/chat/desktop-tools/events?runId=${run}`, { cookie });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.busy, false, "a failed round does not leave the run locked");
});

test("rows are bounded, numbered, and only ever describe payloads the route already received", async () => {
  const run = { runId: "unit_run", events: [], pending: [] };
  for (let index = 0; index < MAX_PROGRESS_EVENTS + 20; index += 1) {
    appendRunEvents(run, [{ phase: "tool", status: "completed", tool: "read_file", message: `step ${index}` }]);
  }
  assert.equal(run.events.length, MAX_PROGRESS_EVENTS, "the log keeps a bounded window");
  assert.equal(run.events.at(-1).seq, MAX_PROGRESS_EVENTS + 20, "the sequence keeps counting past the window");
  assert.equal(run.events[0].seq, 21, "the oldest rows are the first to be dropped");

  const described = describeToolCall({
    id: "call_9",
    function: { name: "write_file", arguments: JSON.stringify({ path: "C:\\a\\b.txt", content: "x".repeat(5000) }) }
  });
  assert.deepEqual(described, { id: "call_9", tool: "write_file", path: "C:\\a\\b.txt" });

  assert.equal(progressText("a\u0000b\n  c"), "a b c", "control characters and line breaks are flattened");
  assert.equal(progressText("y".repeat(400)).length, 180);
  assert.ok(progressText("z".repeat(400)).endsWith("…"));

  const events = toolCallEvents([
    { id: "call_1", function: { name: "run_command", arguments: JSON.stringify({ command: "npm test" }) } }
  ]);
  assert.equal(events[0].message, "run_command npm test");
  assert.equal(events[0].status, "running");

  const unitRun = {
    runId: "unit_run",
    pending: [{ id: "call_1", tool: "run_command", path: "npm test" }],
    events: [...events]
  };
  const paired = settleToolResults(unitRun, [
    { role: "tool", tool_call_id: "call_1", content: "{ not json" }
  ]);
  assert.equal(paired.events[0].status, "failed");
  assert.equal(paired.events[0].code, "unknown", "an unparseable result is not silently a success");
  assert.equal(unitRun.events.length, 1, "the outcome settles the call's own row instead of adding a second line");
  assert.deepEqual(paired.remaining, [], "the call is settled either way so it cannot be reported twice");
});

test("a skill step is only ever a fact about a payload the app already returned", () => {
  const settle = (payload, tool = "use_skill") => {
    const events = toolCallEvents([{ id: "call_s", function: { name: tool, arguments: '{"id":"qa"}' } }]);
    const run = { runId: "unit_skill", pending: [{ id: "call_s", tool, path: "qa" }], events: [...events] };
    const paired = settleToolResults(run, [{ role: "tool", tool_call_id: "call_s", content: JSON.stringify(payload) }]);
    return { run, paired };
  };
  const skillRows = run => run.events.filter(event => event.phase === "skill");

  const loaded = settle({
    ok: true,
    data: { id: "qa", name: "QA Inspector", version: "1.0.0", bytes: 1420, references: ["checklist.md"], path: "C:\Skills\qa" }
  });
  assert.equal(skillRows(loaded.run).length, 1, "a read instruction file is one recorded step");
  assert.equal(skillRows(loaded.run)[0].status, "completed");
  assert.equal(skillRows(loaded.run)[0].tool, "use_skill");
  assert.equal(
    loaded.run.events.filter(event => event.phase === "tool").length,
    1,
    "the tool outcome and the skill step stay two separate rows"
  );

  for (const code of ["skill_not_installed", "skill_disabled", "skill_invalid_manifest", "approval_denied", "outside_workspace"]) {
    const refused = settle({ ok: false, error: { code, message: "Nothing was read." } });
    assert.equal(skillRows(refused.run).length, 0, `${code} loaded no instructions, so it is not a used skill`);
    assert.equal(refused.run.events[0].status, "failed", `${code} keeps its own failure row`);
    assert.equal(refused.run.events[0].code, code);
  }

  const unnamed = settle({ ok: true, data: {} });
  assert.equal(skillRows(unnamed.run).length, 0, "a payload that names no skill cannot be reported as one");

  const listed = settle({ ok: true, data: { skills: [{ id: "qa" }] } }, "list_skills");
  assert.equal(skillRows(listed.run).length, 0, "listing what is installed is not using a skill");

  const reference = settle(
    { ok: true, data: { id: "qa", name: "QA Inspector", reference: "checklist.md", bytes: 300 } },
    "read_skill_reference"
  );
  assert.equal(skillRows(reference.run).length, 1, "a reference file that was read is a real step");
  assert.match(skillRows(reference.run)[0].message, /checklist\.md/);
});
