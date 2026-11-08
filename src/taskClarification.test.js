/**
 * Phase 4 acceptance suite: mid-task clarification (issue #312, design T-1..T-13).
 *
 * The harness is the one every other task suite uses — a real HTTP server on a
 * loopback port over `mongodb-memory-server`, real sessions, the real routes, the
 * real claim/lease/transition code and the deterministic fake provider. Nothing
 * here talks to a real model, so what these tests prove is what the task system
 * records and refuses, not how well a real model asks.
 *
 * Two rules this file follows because the rest of the task layer does:
 *   - A parked task is produced by the feature, never written into the database.
 *     Every `waiting_for_user` below came from a real `ask_user` call, so a
 *     regression that stops parking cannot be hidden by a fixture.
 *   - The lease and the clarification rows are asserted against the stored
 *     record. The API bodies are a projection, and a projection can be edited to
 *     look right.
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
process.env.TASK_WORKER_DISABLED = "1";
delete process.env.TASK_USER_CONCURRENCY;
delete process.env.TASK_WORKER_CONCURRENCY;

import assert from "node:assert/strict";
import { after, test } from "node:test";

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_task_clarification_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");
const connectToDatabase = (await import("./db.js")).default;
const {
  CLARIFICATION_ID_PATTERN,
  MAX_CLARIFICATION_ANSWER_CHARS,
  MAX_CLARIFICATION_OPTIONS,
  MAX_CLARIFICATION_OPTION_CHARS,
  MAX_CLARIFICATION_QUESTION_CHARS,
  default: Task,
  newClarificationId,
  validClarificationId
} = await import("./task.js");
const { default: Conversation } = await import("./conversation.js");
const { usageForEmail } = await import("./usage.js");
const { toolTransportFor } = await import("./providerClient.js");
const { DESKTOP_TOOL_NAMES } = await import("./desktopTools.js");
const store = await import("./taskStore.js");
const worker = await import("./taskWorker.js");
const clarify = await import("./taskClarification.js");

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
function uniqueEmail(prefix = "ph4") {
  counter += 1;
  return `${prefix}${Date.now()}-${counter}@example.com`;
}

async function api(path, { method = "GET", body, cookie, raw } = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      ...(raw !== undefined ? { "Content-Type": "text/plain" } : body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
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

/** A signed-in account with the fake provider configured. */
async function newAccount(prefix = "ph4") {
  fakeProvider.state.reset();
  const email = uniqueEmail(prefix);
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Clarification Tester", email, password: "correct-horse-battery", acceptTerms: true }
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
  return { cookie, email };
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

async function record(taskId) {
  const found = await Task.findOne({ taskId }).lean();
  assert.ok(found, `no record for ${taskId}`);
  return found;
}

function asksFor(prompt) {
  return fakeProvider.state.chatRequests.filter(
    entry => JSON.stringify(entry.body?.messages || []).includes(prompt)
  ).length;
}

/**
 * Run one task until it genuinely parks, and leave the worker stopped.
 *
 * `toolCalls` is scripted after the account exists because configuring a provider
 * is itself a model call, and the fake's script is reset by that round trip.
 */
async function parkATask(prompt, question, args = {}) {
  const account = await newAccount("park");
  fakeProvider.state.set({ toolCalls: [{ name: "ask_user", args: { question, ...args } }] });
  const taskId = await withScheduler(async () => {
    const id = await submit(account.cookie, prompt);
    return await waitForState(account.cookie, id, "waiting_for_user");
  });
  const pending = taskId.pendingClarification;
  assert.ok(pending, `the parked task did not carry its question: ${JSON.stringify(taskId.clarifications)}`);
  return { ...account, prompt, taskId: taskId.taskId, clarification: pending };
}

function answerPath(taskId, clarificationId) {
  return `/api/tasks/${taskId}/clarifications/${clarificationId}/answer`;
}

async function answer(cookie, parked, body) {
  return api(answerPath(parked.taskId, parked.clarification.clarificationId), { method: "POST", cookie, body });
}

// ─── T-13 / O-1: who may be asked at all ─────────────────────────────────────

test("PH4-01 only native tool transports are offered the question, and the tool asks for one thing", () => {
  assert.equal(clarify.supportsClarificationTool("openai_chat"), true);
  assert.equal(clarify.supportsClarificationTool("openai_responses"), true);
  assert.equal(clarify.supportsClarificationTool("anthropic"), true);
  // The text protocol and the Qoder loop keep behaving exactly as they did
  // before this feature: neither is offered a tool it cannot be answered with.
  assert.equal(clarify.supportsClarificationTool("text"), false);
  assert.equal(clarify.supportsClarificationTool("qoder_custom"), false);

  // watsonx is the real case where the task layer falls back to the prose tool
  // protocol: it must never be offered ask_user.
  const watsonx = toolTransportFor({ baseUrl: "https://us-south.ml.cloud.ibm.com?project_id=p", providerType: "watsonx" }, "granite");
  assert.equal(watsonx, "text");
  assert.equal(clarify.supportsClarificationTool(watsonx), false);

  assert.equal(clarify.TASK_CLARIFY_TOOLS.length, 1);
  const fn = clarify.TASK_CLARIFY_TOOLS[0].function;
  assert.equal(fn.name, "ask_user");
  assert.deepEqual(fn.parameters.required, ["question"]);
  assert.equal(fn.parameters.additionalProperties, false);
  // A name the desktop registry already owns would make one tool mean two things.
  assert.equal(DESKTOP_TOOL_NAMES.includes("ask_user"), false);
});

// ─── T-2: the reading of a reply that means "I need to ask" ──────────────────

test("PH4-02 a question is one ask_user call and nothing else", () => {
  const call = (args, id = "c1") => ({ id, type: "function", function: { name: "ask_user", arguments: JSON.stringify(args) } });
  const named = name => ({ id: "c1", type: "function", function: { name, arguments: "{}" } });

  const parsed = clarify.parseClarificationCall(
    { content: "", toolCalls: [call({ question: " Which folder should I write to?" })] },
    { planStepIds: ["prepare", "model", "save"] }
  );
  assert.equal(parsed.question, "Which folder should I write to?", "the question kept its padding");
  assert.deepEqual(parsed.options, []);
  assert.deepEqual(parsed.blockedSteps, []);

  // Anything but exactly one ask_user call is not a question.
  assert.equal(clarify.parseClarificationCall({ content: "", toolCalls: [] }), null);
  assert.equal(clarify.parseClarificationCall({ content: "", toolCalls: [named("list_directory")] }), null);
  assert.equal(clarify.parseClarificationCall({ content: "", toolCalls: [call({ question: "A?" }), call({ question: "B?" })] }), null);
  assert.equal(clarify.parseClarificationCall({ content: "", toolCalls: [call({ question: "A?" }), named("read_file")] }), null);
  // A model that answered *and* asked answered; the task must not park on that.
  assert.equal(clarify.parseClarificationCall({ content: "Here is the work.", toolCalls: [call({ question: "A?" })] }), null);
  // A half-written argument list is not a question either — guessing one would
  // park the task on a sentence nobody wrote.
  assert.equal(clarify.parseClarificationCall({ content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "ask_user", arguments: "{\"question\":" } }] }), null);
  assert.equal(clarify.parseClarificationCall({ content: "", toolCalls: [call({ question: "   " })] }), null);

  // Bounds are applied here, at the store boundary, so an over-shipping provider
  // is trimmed rather than making the task fail on a schema error.
  const wide = clarify.parseClarificationCall({
    content: null,
    toolCalls: [call({
      question: "q".repeat(MAX_CLARIFICATION_QUESTION_CHARS + 500),
      options: Array.from({ length: MAX_CLARIFICATION_OPTIONS + 12 }, () => "o".repeat(MAX_CLARIFICATION_OPTION_CHARS + 100)),
      blocked_steps: ["model", "not-a-step"]
    })]
  }, { planStepIds: ["prepare", "model", "save"] });
  assert.equal(wide.question.length, MAX_CLARIFICATION_QUESTION_CHARS);
  assert.equal(wide.options.length, MAX_CLARIFICATION_OPTIONS);
  assert.ok(wide.options.every(option => option.length === MAX_CLARIFICATION_OPTION_CHARS));
  assert.deepEqual(wide.blockedSteps, ["model"], "a step id the plan never had was stored");
});

// ─── the ids and rows the API hands out ─────────────────────────────────────

test("PH4-03 a clarification id is minted by the server and recognised only in that shape", () => {
  const id = newClarificationId();
  assert.match(id, CLARIFICATION_ID_PATTERN);
  assert.equal(validClarificationId(id), true);
  assert.equal(validClarificationId("tsk_0123456789abcdef01234567"), false);
  assert.equal(validClarificationId("clr_short"), false);
  assert.equal(validClarificationId(""), false);

  const row = clarify.newClarificationRow({ question: "Which branch?", options: ["main", "dev"], blockedSteps: [] });
  assert.equal(row.status, "pending");
  assert.equal(row.answer, "");
  assert.equal(row.answeredAt, null);
  assert.match(row.askedMessageId, /^[0-9a-f]{24}$/);
  assert.match(row.answeredMessageId, /^[0-9a-f]{24}$/);
  assert.notEqual(row.askedMessageId, row.answeredMessageId);

  const list = clarify.clarificationPayload({ ...row, question: "x".repeat(400) }, { full: false });
  assert.ok(list.question.length < 400, "the short payload shipped the whole question");
  assert.equal(clarify.clarificationPayload(null), null);
});

// ─── T-1: parking ────────────────────────────────────────────────────────────

test("PH4-04 a task that needs a decision parks with the question and stops working", async () => {
  const parked = await parkATask("Deploy the queue changes.", "Which environment should this go to — staging or production?", {
    options: ["staging", "production"],
    blocked_steps: ["save"]
  });
  const onDisk = await record(parked.taskId);
  assert.equal(onDisk.state, "waiting_for_user");
  assert.equal(onDisk.stage, "awaiting_clarification");
  assert.equal(onDisk.clarifications.length, 1);
  assert.equal(onDisk.clarifications[0].status, "pending");
  assert.equal(onDisk.clarifications[0].question, "Which environment should this go to — staging or production?");
  assert.deepEqual([...onDisk.clarifications[0].options], ["staging", "production"]);
  assert.match(String(onDisk.clarifications[0].clarificationId), CLARIFICATION_ID_PATTERN);
  assert.equal(onDisk.activeOperation.kind, "clarification");
  assert.equal(onDisk.activeOperation.operationId, onDisk.clarifications[0].clarificationId);

  // A parked task is held by nobody: the worker released the lease on the way
  // out, so an answer can queue it without stepping on a running process.
  assert.equal(onDisk.lease.owner, "", "the worker kept its lease on a task it is not running");
  assert.ok(!onDisk.error?.code, `a parked task is not a failure: ${JSON.stringify(onDisk.error)}`);
  assert.ok(!onDisk.completedAt, "a parked task wrote a completion time");

  const asked = asksFor(parked.prompt);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(asksFor(parked.prompt), asked, "the parked task kept asking the model");

  const parkRow = (onDisk.events || []).filter(event => event.key === "clarification");
  assert.equal(parkRow.length, 1);
  assert.equal(parkRow[0].clarificationId, onDisk.clarifications[0].clarificationId);
  // The question is a task row, not a provider row: the model call it came from
  // is closed, and the tool phase — which this path never runs — is not left open.
  const open = (onDisk.events || []).filter(event => event.status === "running" && (event.phase === "provider" || event.phase === "tool"));
  assert.deepEqual(open.map(event => event.phase), []);

  // T-13 positive half: the question really was offered as a native tool, and the
  // model was told a question is a legitimate way to stop.
  const request = fakeProvider.state.chatRequests.find(
    entry => JSON.stringify(entry.body?.messages || []).includes(parked.prompt)
  );
  assert.ok(request, "no provider request carried this task");
  assert.deepEqual(request.body.tools.map(tool => tool.function.name), ["ask_user"]);
  assert.equal(request.body.tool_choice, undefined, "the task asked the provider to force a tool call");
  assert.ok(
    request.body.messages[0].content.includes("call ask_user"),
    "the instruction that makes asking legitimate was not sent"
  );
});

test("PH4-05 an unexpected tool call is still not an answer and still not a question", async () => {
  const account = await newAccount("ph405");
  fakeProvider.state.set({ toolCalls: [{ name: "list_directory", args: { path: "C:\\tmp" } }] });
  const taskId = await withScheduler(async () => {
    const id = await submit(account.cookie, "Count the files in the folder.");
    return await waitForState(account.cookie, id, ["failed", "waiting_for_user"]);
  });
  const onDisk = await record(taskId.taskId);
  // This is the pre-Phase-4 outcome, unchanged: a tool this path does not run
  // leaves no answer, and the record says so instead of inventing a question.
  assert.equal(onDisk.state, "failed", JSON.stringify(onDisk.state));
  assert.equal(onDisk.error.code, "empty_response");
  assert.equal((onDisk.clarifications || []).length, 0, "a foreign tool call parked the task");
});

// ─── T-3 + T-4: the answer, and the same task carrying on ────────────────────

test("PH4-06 answering parks-to-queues the same task and it completes with the answer in its transcript", async () => {
  const parked = await parkATask("Rename the release branch.", "Which name do you want — release/2.1 or hotfix/2.1?");
  const before = await record(parked.taskId);
  const beforeSeq = before.events.slice(-1)[0].seq;
  const usedBefore = (await usageForEmail(parked.email)).dailyUsed;

  fakeProvider.state.set({ toolCalls: null, chatResponseText: "Renamed to release/2.1." });
  const answered = await answer(parked.cookie, parked, { answer: "release/2.1, please." });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.task.state, "queued");
  assert.equal(answered.body.task.pendingClarification, null, "the answered task still advertises a question");
  assert.equal(answered.body.task.activeOperation.kind, "none");
  const row = answered.body.task.clarifications[0];
  assert.equal(row.status, "answered");
  assert.equal(row.answer, "release/2.1, please.");
  assert.ok(row.answeredAt, "the answer has no timestamp");

  const withAnswer = await Conversation.findOne({ _id: before.conversationId }).select("messages").lean();
  const messages = withAnswer.messages.map(message => ({ role: message.role, content: message.content, messageId: message.messageId }));
  const questionRow = messages.find(message => message.messageId === String(row.askedMessageId));
  const answerRow = messages.find(message => message.messageId === String(row.answeredMessageId));
  assert.equal(questionRow?.role, "assistant", "the question was not stored as the assistant's turn");
  assert.equal(questionRow?.content, "Which name do you want — release/2.1 or hotfix/2.1?");
  assert.equal(answerRow?.role, "user", "the answer was not stored as the user's turn");
  assert.equal(answerRow?.content, "release/2.1, please.");

  const final = await withScheduler(async () => await waitForState(parked.cookie, parked.taskId, "completed"));
  const after = await record(parked.taskId);

  assert.equal(after.taskId, parked.taskId, "the resumed work ran as a different task");
  assert.equal(after.steps, before.steps + 1, "the resumed leg did not continue the same task's step count");
  assert.equal(asksFor(parked.prompt), 2, "the resumed run asked the model more than once");
  assert.equal(after.request.quotaConsumed, true);
  // T-4: one charge for the whole task. `quotaConsumed` is the guard, and a
  // resumed leg must go through it, not around it.
  assert.equal((await usageForEmail(parked.email)).dailyUsed, usedBefore, "answering charged the daily quota again");
  assert.equal(after.clarifications[0].status, "answered");
  assert.ok(after.completedAt, "the resumed task has no completion time");
  assert.equal(after.state, "completed");
  assert.ok(after.result.summary.includes("release/2.1"), JSON.stringify(after.result));

  // The resumed run read the answer as part of its own conversation.
  const resumedRequest = fakeProvider.state.chatRequests.filter(
    entry => JSON.stringify(entry.body?.messages || []).includes(parked.prompt)
  ).at(-1);
  const transcript = JSON.stringify(resumedRequest.body.messages);
  assert.ok(transcript.includes("Which name do you want"), "the resumed request did not carry the question");
  assert.ok(transcript.includes("release/2.1, please."), "the resumed request did not carry the answer");

  const afterSeq = after.events.slice(-1)[0].seq;
  assert.ok(afterSeq > beforeSeq, `the replay cursor did not move across the pause (${beforeSeq} → ${afterSeq})`);
  const seqs = after.events.map(event => event.seq);
  assert.deepEqual([...new Set(seqs)].length, seqs.length, "the event log holds a duplicated sequence number");
  assert.equal(final.pendingClarification, null, "a completed task still advertised a question");
});

// ─── T-5: one question, one answer, however many requests arrive ─────────────

test("PH4-07 two answers sent together cannot queue the same task twice", async () => {
  const parked = await parkATask("Split the invoice by month.", "Which months should the split cover?");
  fakeProvider.state.set({ toolCalls: null, chatResponseText: "Split across January to June." });

  // The completion is awaited inside the scheduler on purpose: stopping the
  // worker between "running" and "completed" would orphan this run with no
  // scheduler left to reconcile it, and the wait would time out on a task that
  // nothing was driving.
  const both = await withScheduler(async () => {
    const results = await Promise.all([
      answer(parked.cookie, parked, { answer: "January to June." }),
      answer(parked.cookie, parked, { answer: "January to June too." })
    ]);
    const taskId = parked.taskId;
    const settled = await waitForState(parked.cookie, taskId, "completed");
    return { results, settled, taskId };
  });

  const statuses = both.results.map(result => result.status).sort();
  assert.equal(statuses.filter(status => status === 200).length, 1, JSON.stringify(both.results.map(result => result.body)));
  assert.equal(statuses.filter(status => status === 409).length, 1, JSON.stringify(both.results.map(result => result.body)));
  const refused = both.results.find(result => result.status === 409);
  assert.ok(
    ["clarification_answered", "state_conflict"].includes(refused.body.code),
    `the losing answer said "${refused.body.code}"; it must name the race it lost`
  );

  const final = both.settled;
  const onDisk = await record(both.taskId);
  assert.equal(asksFor(parked.prompt), 2, "the task was run twice for one answer");
  assert.equal(onDisk.steps, 2, JSON.stringify(onDisk.steps));
  assert.equal(final.clarifications[0].status, "answered");
  assert.ok(final.clarifications[0].answer, "the answer that won was not the one stored");
  const exchange = (await Conversation.findOne({ _id: onDisk.conversationId }).select("messages").lean()).messages;
  assert.equal(exchange.filter(m => m.messageId === String(onDisk.clarifications[0].askedMessageId)).length, 1, "the question was appended twice");
  assert.equal(exchange.filter(m => m.messageId === String(onDisk.clarifications[0].answeredMessageId)).length, 1, "the answer was appended twice");
});

// ─── T-6: ownership ──────────────────────────────────────────────────────────

test("PH4-08 another account cannot read or answer the question", async () => {
  const parked = await parkATask("Rotate the staging secrets.", "Which provider should hold the new key?");
  const other = await newAccount("ph408-other");

  const foreign = await api(answerPath(parked.taskId, parked.clarification.clarificationId), {
    method: "POST",
    cookie: other.cookie,
    body: { answer: "the other one" }
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  assert.equal(foreign.body.code, "task_not_found");

  const eventsByOther = await api(`/api/tasks/${parked.taskId}/events`, { cookie: other.cookie });
  assert.equal(eventsByOther.status, 404, JSON.stringify(eventsByOther.body));

  const anonymous = await api(answerPath(parked.taskId, parked.clarification.clarificationId), {
    method: "POST",
    body: { answer: "nobody" }
  });
  assert.equal(anonymous.status, 401);

  // A question id from somewhere else, on the owner's own task, is not accepted
  // either: the id has to be one this task actually asked.
  const wrongQuestion = await api(answerPath(parked.taskId, newClarificationId()), {
    method: "POST",
    cookie: parked.cookie,
    body: { answer: "not your question" }
  });
  assert.equal(wrongQuestion.status, 409);
  assert.equal(wrongQuestion.body.code, "clarification_not_found");

  const onDisk = await record(parked.taskId);
  assert.equal(onDisk.state, "waiting_for_user");
  assert.equal(onDisk.clarifications[0].status, "pending");
  assert.equal(onDisk.clarifications[0].answer, "");

  // …and the owner can still answer it afterwards.
  const ok = await answer(parked.cookie, parked, { answer: "the one we already use." });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ─── T-7 / T-8 / T-9: what may not be resumed, cancelled, or answered ────────

test("O-9 a paused task can still answer the question it was already holding", async () => {
  const parked = await parkATask("Pause before answering.", "Which environment should this target?");
  await Task.updateOne(
    { taskId: parked.taskId },
    {
      $set: {
        state: "paused",
        stage: "paused",
        lease: { owner: "", claimedAt: null, heartbeatAt: null, expiresAt: null }
      }
    }
  );

  const answered = await answer(parked.cookie, parked, { answer: "production" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.task.state, "queued", "the paused task did not return to the queue");

  const after = await record(parked.taskId);
  assert.equal(after.state, "queued");
  const row = after.clarifications.find(item => item.clarificationId === parked.clarification.clarificationId);
  assert.equal(row.status, "answered");
  assert.equal(row.answer, "production");
});

test("PH4-09 resume is not a way past the question, cancel outranks it, and a terminal task refuses", async () => {
  const parked = await parkATask("Publish the newsletter.", "Which mailing list should receive it?");

  const resumed = await api(`/api/tasks/${parked.taskId}/resume`, { method: "POST", cookie: parked.cookie });
  assert.equal(resumed.status, 409, JSON.stringify(resumed.body));
  assert.equal(resumed.body.code, "clarification_required");
  assert.equal(resumed.body.clarificationId, parked.clarification.clarificationId);
  assert.equal((await record(parked.taskId)).state, "waiting_for_user", "resume moved a task that was waiting for an answer");

  const cancelled = await api(`/api/tasks/${parked.taskId}/cancel`, { method: "POST", cookie: parked.cookie });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.task.state, "cancelled");

  const late = await answer(parked.cookie, parked, { answer: "the big list." });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "task_terminal");

  const afterCancel = await withScheduler(async () => {
    await new Promise(resolve => setTimeout(resolve, 250));
    return record(parked.taskId);
  });
  assert.equal(afterCancel.state, "cancelled", "a cancelled task came back for its unanswered question");
  assert.equal(asksFor(parked.prompt), 1, "the cancelled task asked the model again");

  // A task that is not waiting for anybody refuses an answer too.
  const running = await newAccount("ph409");
  fakeProvider.state.set({ chatDelayMs: 600, chatResponseText: "Answered." });
  const plainId = await submit(running.cookie, "Just answer this one.");
  await withScheduler(async () => {
    const stray = await api(answerPath(plainId, newClarificationId()), {
      method: "POST",
      cookie: running.cookie,
      body: { answer: "too early" }
    });
    assert.equal([404, 409].includes(stray.status), true, JSON.stringify(stray.body));
    assert.ok(["state_conflict", "clarification_not_found", "task_not_found"].includes(stray.body.code), JSON.stringify(stray.body));
    await waitForState(running.cookie, plainId, "completed");
  });
});

// ─── T-10: the bounds, and the shapes the route accepts ──────────────────────

test("PH4-10 an answer is required, bounded, and must arrive as JSON", async () => {
  const parked = await parkATask("Draft the reply to the vendor.", "Do you want to accept the price increase?");

  const blank = await answer(parked.cookie, parked, { answer: "   " });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, "answer_required");

  const missing = await answer(parked.cookie, parked, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "answer_required");

  const tooLong = await answer(parked.cookie, parked, { answer: "a".repeat(MAX_CLARIFICATION_ANSWER_CHARS + 1) });
  assert.equal(tooLong.status, 413);
  assert.equal(tooLong.body.code, "answer_too_long");

  const notJson = await api(answerPath(parked.taskId, parked.clarification.clarificationId), {
    cookie: parked.cookie,
    method: "POST",
    raw: "accept it"
  });
  assert.equal(notJson.status, 415, JSON.stringify(notJson.body));

  const badId = await api(answerPath(parked.taskId, "clr_nonsense"), {
    cookie: parked.cookie,
    method: "POST",
    body: { answer: "yes" }
  });
  assert.equal(badId.status, 400);
  assert.equal(badId.body.code, "invalid_clarification_id");

  // Every rejection above left the question pending, so the happy path still works.
  const maxAllowed = "b".repeat(MAX_CLARIFICATION_ANSWER_CHARS);
  const ok = await answer(parked.cookie, parked, { answer: maxAllowed });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.task.clarifications[0].answer, maxAllowed);
});

// ─── T-11: replay across the pause ───────────────────────────────────────────

test("PH4-11 a client that was away reads the pause and the answer once, in order", async () => {
  const parked = await parkATask("Rebuild the desktop installer.", "Should the rebuild keep the old signing identity?");

  const whileParked = await api(`/api/tasks/${parked.taskId}/events?after=0`, { cookie: parked.cookie });
  assert.equal(whileParked.status, 200);
  assert.equal(whileParked.body.state, "waiting_for_user");
  assert.equal(whileParked.body.done, false);
  assert.equal(whileParked.body.pendingClarification.clarificationId, parked.clarification.clarificationId);
  assert.equal(whileParked.body.pendingClarification.question, "Should the rebuild keep the old signing identity?");
  const cursor = whileParked.body.lastSeq;
  assert.ok(cursor > 0);

  fakeProvider.state.set({ toolCalls: null, chatResponseText: "Rebuilt with the same identity." });
  const answered = await answer(parked.cookie, parked, { answer: "Keep it." });
  assert.equal(answered.status, 200);

  const sincePause = await api(`/api/tasks/${parked.taskId}/events?after=${cursor}`, { cookie: parked.cookie });
  assert.equal(sincePause.status, 200);
  assert.equal(sincePause.body.pendingClarification, null, "an answered task still offers a question");
  const keys = sincePause.body.events.map(event => event.key);
  assert.ok(keys.includes("clarification_answered"), JSON.stringify(keys));
  assert.equal(keys.filter(key => key === "clarification").length, 0, "replay re-sent the question the client already had");
  assert.equal(sincePause.body.events.every(event => event.seq > cursor), true);

  const whole = await api(`/api/tasks/${parked.taskId}/events?after=0`, { cookie: parked.cookie });
  const seqs = whole.body.events.map(event => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "the replay window came back out of order");
  assert.equal(new Set(seqs).size, seqs.length, "one sequence number was replayed twice");
  const parkEvent = whole.body.events.find(event => event.key === "clarification");
  const answerEvent = whole.body.events.find(event => event.key === "clarification_answered");
  assert.ok(parkEvent.seq < answerEvent.seq, "the answer was recorded before the question");
  assert.equal(answerEvent.clarificationId, parked.clarification.clarificationId);
});

// ─── T-12: nobody queues a parked task on its own ────────────────────────────

test("PH4-12 a parked task is not recovered, not re-claimed and not timed out", async () => {
  const parked = await parkATask("Back up the project folder.", "Which folder should the backup read?");
  // The neighbour is a different instruction on the same account, and the fake
  // provider script merges: unless the ask_user call is cleared it answers every
  // request with a question, and this test would be watching the wrong park.
  fakeProvider.state.set({ toolCalls: null, chatResponseText: "Summarised the changelog." });
  const other = await submit(parked.cookie, "Summarise the changelog.");

  await withScheduler(async () => {
    await store.reconcileInterruptedTasks({ now: new Date(Date.now() + 60000) });
    await waitForState(parked.cookie, other, "completed");
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  const onDisk = await record(parked.taskId);
  assert.equal(onDisk.state, "waiting_for_user", "a parked task was swept into another state");
  assert.equal(onDisk.lease.owner, "");
  assert.equal(asksFor(parked.prompt), 1, "the parked task asked the model again on its own");

  // The neighbour ran; this one is still waiting, which is the whole point: a
  // question does not expire and does not get answered by a scheduler.
  const answered = await answer(parked.cookie, parked, { answer: "the one it already used." });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
});

// ─── a second question does not leave two live gates ─────────────────────────

test("PH4-13 a task carries one live question, and a superseded row stops being answerable", async () => {
  const parked = await parkATask("Move the archive to cold storage.", "Which bucket should receive it?");
  const first = (await record(parked.taskId)).clarifications[0];

  // Answer the first question and let the task run — into a second question.
  // This is the only way a task ends up with more than one row, so the history
  // rule is proven through the feature rather than by writing rows by hand.
  fakeProvider.state.set({ toolCalls: [{ name: "ask_user", args: { question: "Which region is that bucket in?" } }] });
  const answered = await answer(parked.cookie, parked, { answer: "the warm bucket." });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));

  const askedAgain = await withScheduler(async () =>
    await waitForState(parked.cookie, parked.taskId, "waiting_for_user"));
  const onDisk = await record(parked.taskId);
  assert.equal(onDisk.clarifications.length, 2, JSON.stringify(onDisk.clarifications));
  assert.equal(onDisk.clarifications[0].clarificationId, first.clarificationId);
  assert.equal(onDisk.clarifications[0].status, "answered", "the answered row was rewritten by the second question");
  assert.equal(onDisk.clarifications[0].answer, "the warm bucket.");
  assert.equal(onDisk.clarifications[1].status, "pending");
  assert.equal(onDisk.clarifications[1].question, "Which region is that bucket in?");
  assert.equal(onDisk.activeOperation.operationId, onDisk.clarifications[1].clarificationId,
    "the live gate still points at the first question");
  assert.equal(askedAgain.pendingClarification.clarificationId, onDisk.clarifications[1].clarificationId,
    "the API reported the stale question as the live one");

  // The row the task already moved past is history, not a second gate.
  const stale = await api(answerPath(parked.taskId, first.clarificationId), {
    method: "POST",
    cookie: parked.cookie,
    body: { answer: "cold bucket instead" }
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "clarification_answered");
  const untouched = await record(parked.taskId);
  assert.equal(untouched.state, "waiting_for_user", "answering a superseded row moved the task");
  assert.equal(untouched.clarifications[0].answer, "the warm bucket.", "a superseded row accepted a new answer");
  assert.equal(asksFor(parked.prompt), 2, "the refused answer ran the model");

  // …and the live question still answers normally.
  fakeProvider.state.set({ toolCalls: null, chatResponseText: "Moved to the warm bucket in eu-gb." });
  const second = await api(answerPath(parked.taskId, onDisk.clarifications[1].clarificationId), {
    method: "POST",
    cookie: parked.cookie,
    body: { answer: "eu-gb." }
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.task.state, "queued");
  assert.equal(second.body.task.pendingClarification, null);
  await withScheduler(async () => await waitForState(parked.cookie, parked.taskId, "completed"));

  // The projection rule the API reads from, on a hand-built history: only a
  // pending row is live, and a task with no pending row has no question.
  const row = (status, question) => ({ clarificationId: newClarificationId(), status, question });
  const history = [row("answered", "one"), row("superseded", "two"), row("pending", "three")];
  assert.equal(clarify.pendingClarificationOf({ clarifications: history }).question, "three");
  assert.equal(clarify.pendingClarificationOf({ clarifications: [row("answered", "only"), row("superseded", "old")] }), null);
  assert.equal(clarify.pendingClarificationOf({}), null);
});

// ─── O-1: the question is a native call, or it is not a question ─────────────

test("PH4-14 a provider that rejects the tool contract degrades, and prose never parks a task", async () => {
  const account = await newAccount("ph414");
  // The compatibility path inside `chatCompletion`: a provider that answers the
  // tool-bearing request with a tool rejection is retried once without tools and
  // falls back to the text protocol, whose markers the desktop chat loop parses.
  // On the task path that parsing must never reach the state machine.
  fakeProvider.state.set({
    chatStatus: 400,
    chatErrorPayload: { error: { message: "Invalid parameter: tools is not supported by this model." } },
    chatFailuresRemaining: 1,
    chatResponseText:
      '<vups_tool_call>{"name":"ask_user","arguments":{"question":"Should I park?"}}</vups_tool_call>'
  });
  const taskId = await withScheduler(async () => {
    const id = await submit(account.cookie, "Rewrite the release notes.");
    return await waitForState(account.cookie, id, ["failed", "waiting_for_user"]);
  });
  const prompt = "Rewrite the release notes.";
  const onDisk = await record(taskId.taskId);

  const requests = fakeProvider.state.chatRequests.filter(
    entry => JSON.stringify(entry.body?.messages || []).includes(prompt)
  );
  assert.equal(requests.length, 2, `the tool rejection did not reach the text fallback (${requests.length} requests)`);
  assert.ok(Array.isArray(requests[0].body.tools), "the first request did not offer the question as a tool");
  assert.equal(requests.at(-1).body.tools, undefined, "the retry still sent the rejected tool contract");

  assert.equal(onDisk.state, "failed", JSON.stringify(onDisk.state));
  assert.equal(onDisk.error.code, "empty_response", JSON.stringify(onDisk.error));
  assert.equal((onDisk.clarifications || []).length, 0, "a line of prose parked the task");
  assert.notEqual(onDisk.activeOperation?.kind, "clarification", "the task is held on a question nobody asked");
});
