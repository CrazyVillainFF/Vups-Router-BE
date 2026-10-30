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
process.env.MONGODB_URI = mongod.getUri("vupsrouter_desktop_tools_test");

const { startFakeProvider, FAKE_API_KEY } = await import("./testUtils/fakeProvider.js");
const fakeProvider = await startFakeProvider();

const { default: app } = await import("./index.js");
const { default: mongoose } = await import("mongoose");

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
  return `desktop${Date.now()}-${counter}@example.com`;
}

function runId(label) {
  counter += 1;
  return `desktop_${label}_${Date.now()}_${counter}`;
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

async function signupUser(name = "Desktop Tester") {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name, email: uniqueEmail(), password: "correct-horse-battery" }
  });
  assert.equal(response.status, 201);
  return sessionCookie(response);
}

async function configureProvider(cookie) {
  const response = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "Fake OpenAI-compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-mini"
    }
  });
  assert.equal(response.status, 200);
}

async function newUser() {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();
  return cookie;
}

function lastProviderBody() {
  return fakeProvider.state.chatRequests.at(-1)?.body;
}

test("the desktop route offers only the native filesystem tools and returns the model's calls", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({
    toolCalls: [{ name: "get_windows_known_folder", args: { name: "downloads" } }]
  });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("list"),
      messages: [{ role: "user", content: "What is in my Downloads folder?" }]
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.type, "tool_calls");

  const body = lastProviderBody();
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(
    body.tools.map(tool => tool.function.name),
    [
      "get_windows_known_folder",
      "list_directory",
      "list_recent_files",
      "read_file",
      "search_files",
      "read_file_metadata"
    ]
  );
  assert.match(body.messages[0].content, /Local Windows tools are available/);
  assert.match(
    body.messages[0].content,
    /Never call read_file_metadata once per file/,
    "the prompt has to steer " +
      "the model away from the per-file metadata pattern that produced one permission prompt per file"
  );
  assert.doesNotMatch(JSON.stringify(body.messages), new RegExp(FAKE_API_KEY, "i"));

  const call = response.body.toolCalls[0];
  assert.equal(call.type, "function");
  assert.equal(call.function.name, "get_windows_known_folder");
  assert.deepEqual(JSON.parse(call.function.arguments), { name: "downloads" });
  assert.ok(call.id);
  assert.equal(response.body.assistantMessage.tool_calls.length, 1);
});

test("a native tool result round-trips and the final answer is persisted to a conversation", async () => {
  const cookie = await newUser();
  const id = runId("final");
  fakeProvider.state.set({
    toolCalls: [{ id: "call_1", name: "list_directory", args: { path: "C:\\Users\\test\\Downloads" } }]
  });

  const first = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: id, messages: [{ role: "user", content: "List my Downloads folder." }] }
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.type, "tool_calls");

  fakeProvider.state.set({
    toolCalls: null,
    chatResponseText: "There are 2 files in your Downloads folder."
  });

  const second = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: id,
      messages: [
        { role: "user", content: "List my Downloads folder." },
        first.body.assistantMessage,
        { role: "tool", tool_call_id: "call_1", content: JSON.stringify({ ok: true, data: { entries: [] } }) }
      ]
    }
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.type, "final");
  assert.match(second.body.content, /2 files in your Downloads folder/);
  assert.ok(second.body.conversationId);

  const history = await api(`/api/conversations/${second.body.conversationId}`, { cookie });
  assert.equal(history.status, 200);
  const roles = history.body.conversation?.messages?.map(message => message.role) ||
    history.body.messages?.map(message => message.role);
  assert.deepEqual(roles, ["user", "assistant"]);
});

test("another account cannot resume a desktop tool run it does not own", async () => {
  const owner = await newUser();
  const intruder = await newUser();
  const id = runId("foreign");
  fakeProvider.state.set({ toolCalls: [{ name: "read_file", args: { path: "C:\\secret.txt" } }] });

  const started = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie: owner,
    body: { runId: id, messages: [{ role: "user", content: "Read a file." }] }
  });
  assert.equal(started.status, 200);

  const hijack = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie: intruder,
    body: { runId: id, messages: [{ role: "user", content: "Read someone else's file." }] }
  });
  assert.equal(hijack.status, 403);
  assert.equal(hijack.body.code, "run_forbidden");
});

test("an invented tool name in the assistant transcript is rejected before any provider call", async () => {
  const cookie = await newUser();
  const before = fakeProvider.state.chatRequests.length;

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("forged"),
      messages: [
        { role: "user", content: "Delete my files." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_x", type: "function", function: { name: "shell_execute", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_x", content: "{}" }
      ]
    }
  });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /not recognized/);
  assert.equal(fakeProvider.state.chatRequests.length, before);
});

test("image attachments cannot ride the text-only filesystem route", async () => {
  const cookie = await newUser();
  const before = fakeProvider.state.chatRequests.length;

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("images"),
      messages: [{ role: "user", content: "Look at this screenshot.", images: ["data:image/png;base64,AAAA"] }]
    }
  });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /text-only/);
  assert.equal(fakeProvider.state.chatRequests.length, before);
});

test("a request that does not end with a user or tool message is refused", async () => {
  const cookie = await newUser();
  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("dangling"),
      messages: [
        { role: "user", content: "List files." },
        { role: "assistant", content: "Here is the listing." }
      ]
    }
  });
  assert.equal(response.status, 400);
  assert.match(response.body.message, /must be a user message or a tool result/);
});

test("an anonymous run id is rejected before any lookup", async () => {
  const response = await fetch(`${baseURL}/api/chat/desktop-tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId: "short", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(response.status, 401);
});

test("the filesystem tool loop stops after the bounded number of rounds", async () => {
  const cookie = await newUser();
  const id = runId("bounded");
  fakeProvider.state.set({
    toolCalls: [{ name: "search_files", args: { root: "C:\\Users\\test", query: "report" } }]
  });

  const assistantTurn = (callId) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: callId, type: "function", function: { name: "search_files", arguments: "{\"root\":\"C:\\\\Users\\\\test\",\"query\":\"report\"}" } }]
  });

  let lastStatus = null;
  for (let step = 0; step < 7; step += 1) {
    const messages = [{ role: "user", content: "Find every report on this machine." }];
    for (let prior = 0; prior < step; prior += 1) {
      const callId = `call_${prior}`;
      messages.push(assistantTurn(callId), { role: "tool", tool_call_id: callId, content: "{\"ok\":true}" });
    }
    const response = await api("/api/chat/desktop-tools", { method: "POST", cookie, body: { runId: id, messages } });
    lastStatus = { status: response.status, code: response.body.code, type: response.body.type };
    if (response.status !== 200) break;
    assert.equal(response.body.type, "tool_calls");
  }

  assert.equal(lastStatus.status, 429);
  assert.equal(lastStatus.code, "tool_round_limit");
});

test("a busy provider on the follow-up call is retried and the tool result still answers", async () => {
  process.env.VUPS_RETRY_BASE_MS = "1";
  process.env.VUPS_MAX_RETRIES = "2";
  const cookie = await newUser();
  const id = runId("retry");
  fakeProvider.state.set({
    toolCalls: [{ id: "call_recent", name: "list_recent_files", args: { path: "C:\Users\test\Downloads", limit: 5 } }]
  });

  const first = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: id, messages: [{ role: "user", content: "Find my 5 latest downloaded files." }] }
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.type, "tool_calls");
  assert.equal(first.body.toolCalls[0].function.name, "list_recent_files");

  // The desktop app has already read the folder by now. The next model call is
  // the one that turns those results into an answer, and it is the one a shared
  // free model most often answers with a 429.
  const toolResult = {
    ok: true,
    data: {
      path: "C:\Users\test\Downloads",
      files: [{ name: "setup.exe", size: 12, modifiedAt: 1_700_000_000_000 }],
      sortedBy: "lastModified"
    }
  };
  fakeProvider.state.set({
    toolCalls: null,
    chatResponseText: "Your five newest downloads are: setup.exe.",
    chatStatus: 429,
    chatFailuresRemaining: 1
  });

  const second = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: id,
      messages: [
        { role: "user", content: "Find my 5 latest downloaded files." },
        first.body.assistantMessage,
        { role: "tool", tool_call_id: "call_recent", content: JSON.stringify(toolResult) }
      ]
    }
  });

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.type, "final");
  assert.match(second.body.content, /setup\.exe/);
  const followUps = fakeProvider.state.chatRequests.slice(1);
  assert.equal(followUps.length, 2, "the busy call was retried once, not abandoned");
  assert.deepEqual(
    followUps[0].body.messages.at(-1),
    followUps[1].body.messages.at(-1),
    "the retry resends the same tool result rather than dropping it"
  );
  assert.ok(
    followUps.every(entry => entry.body.messages.some(message => message.role === "tool")),
    "the completed filesystem work is present on every attempt"
  );
  delete process.env.VUPS_RETRY_BASE_MS;
  delete process.env.VUPS_MAX_RETRIES;
});

test("a rejected provider key on a tool turn is not retried and is not called busy", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({ toolCalls: null, chatResponseText: "unused", invalidKey: true });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: runId("auth"), messages: [{ role: "user", content: "List my Downloads folder." }] }
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, "invalid_api_key");
  assert.doesNotMatch(String(response.body.message).toLowerCase(), /busy/);
  assert.equal(fakeProvider.state.chatRequests.length, 1, "an auth failure must not be retried");
  fakeProvider.state.set({ invalidKey: false });
});

test("a malformed request on a tool turn is reported as itself, not as a busy model", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({
    toolCalls: null,
    chatResponseText: "unused",
    chatStatus: 400,
    chatErrorPayload: { error: { message: "Invalid parameter: tools is not supported by this model." } }
  });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: runId("bad"), messages: [{ role: "user", content: "List my Downloads folder." }] }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "bad_request");
  assert.match(response.body.message, /tools is not supported/);
  assert.equal(fakeProvider.state.chatRequests.length, 1, "a permanent 400 must not be retried");
  fakeProvider.state.set({ chatStatus: 200, chatErrorPayload: null });
});

test("an exhausted retry budget says the model is unavailable and reports how hard it tried", async () => {
  process.env.VUPS_RETRY_BASE_MS = "1";
  process.env.VUPS_MAX_RETRIES = "1";
  const cookie = await newUser();
  fakeProvider.state.set({ toolCalls: null, chatResponseText: "unused", chatStatus: 503 });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: runId("exhaust"), messages: [{ role: "user", content: "List my Downloads folder." }] }
  });

  assert.equal(response.status, 503);
  assert.equal(fakeProvider.state.chatRequests.length, 2, "one retry, then stop");
  assert.equal(response.body.diagnostic?.providerAttempts, 2);
  fakeProvider.state.set({ chatStatus: 200 });
  delete process.env.VUPS_RETRY_BASE_MS;
  delete process.env.VUPS_MAX_RETRIES;
});

test("the desktop prompt bans invented Windows permission advice", async () => {
  const { DESKTOP_TOOL_PROMPT, DESKTOP_TOOLS } = await import("./desktopTools.js");

  assert.match(DESKTOP_TOOL_PROMPT, /Never tell the user to change NTFS permissions/);
  assert.match(DESKTOP_TOOL_PROMPT, /app-level consent and does not change Windows access control/);
  assert.match(DESKTOP_TOOL_PROMPT, /"access_denied" is the only code that means Windows itself refused/);
  assert.match(
    DESKTOP_TOOL_PROMPT,
    /code "access_denied" may be described as a Windows access problem/,
    "only a real access_denied result may be called a Windows access problem"
  );
  assert.match(DESKTOP_TOOL_PROMPT, /call list_recent_files once/);
  assert.match(DESKTOP_TOOL_PROMPT, /say what it returned instead of calling the same tool again/);

  const recent = DESKTOP_TOOLS.find(tool => tool.function.name === "list_recent_files");
  assert.ok(recent, "the deterministic newest-files tool is offered to the model");
  assert.match(recent.function.description, /sorted by last-modified time/);
});
