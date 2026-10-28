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
    ["get_windows_known_folder", "list_directory", "read_file", "search_files", "read_file_metadata"]
  );
  assert.match(body.messages[0].content, /Local Windows tools are available/);
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
