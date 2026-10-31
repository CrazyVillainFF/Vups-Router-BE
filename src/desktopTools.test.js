import assert from "node:assert/strict";
import http from "node:http";
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

// A second provider speaks the Anthropic Messages protocol. The route-level
// test below proves the same desktop tool registry is reachable through it,
// not only through the OpenAI-compatible fake.
const anthropicRequests = [];
const anthropicServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", chunk => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    anthropicRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === "/v1/messages" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_route",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_route", name: "list_directory", input: { path: "C:/Users/Test" } }
        ],
        stop_reason: "tool_use"
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No route" } }));
  });
});
await new Promise(resolve => anthropicServer.listen(0, "127.0.0.1", resolve));
const anthropicBaseURL = `http://127.0.0.1:${anthropicServer.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await new Promise((resolve, reject) => anthropicServer.close(error => (error ? reject(error) : resolve())));
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

test("close_app promises to close any visible app, not only ones VupsRouter launched", async () => {
  const { DESKTOP_TOOL_PROMPT, DESKTOP_TOOLS } = await import("./desktopTools.js");
  const list = DESKTOP_TOOLS.find(tool => tool.function.name === "list_processes");
  const close = DESKTOP_TOOLS.find(tool => tool.function.name === "close_app");
  assert.match(list.function.description, /canClose=true/);
  assert.match(list.function.description, /even when VupsRouter did not launch it/);
  assert.match(close.function.description, /Works for apps VupsRouter did not launch/);
  assert.match(close.function.description, /Protected Windows processes/);
  assert.match(DESKTOP_TOOL_PROMPT, /apps VupsRouter did not launch can be closed too/);
});

test("the desktop route offers every native local tool and returns the model's calls", async () => {
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
  const { DESKTOP_TOOL_NAMES } = await import("./desktopTools.js");
  const offered = body.tools.map(tool => tool.function.name);
  assert.deepEqual(offered, [...DESKTOP_TOOL_NAMES]);
  assert.equal(offered.length, 27);
  for (const name of [
    "search_file_contents",
    "create_directory",
    "write_file",
    "append_file",
    "edit_file",
    "rename_path",
    "move_path",
    "copy_path",
    "delete_path",
    "open_path",
    "open_url",
    "list_installed_apps",
    "find_app",
    "launch_app",
    "open_with_app",
    "list_processes",
    "close_app",
    "run_command",
    "start_command",
    "command_output",
    "stop_command"
  ]) {
    assert.ok(offered.includes(name), `${name} must be offered to the model`);
  }
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
  assert.match(response.body.message, /does not offer|not recognized/);
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
  for (let step = 0; step < 13; step += 1) {
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

test("a provider that rejects the tool fields gets one text-protocol retry, then the real error", async () => {
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
  const requests = fakeProvider.state.chatRequests;
  assert.equal(requests.length, 2, "one native attempt, then one text-protocol attempt");
  assert.ok(Array.isArray(requests[0].body.tools), "the first attempt uses native tools");
  assert.equal(requests[1].body.tools, undefined, "the compatibility attempt sends no tool fields");
  assert.match(
    String(requests[1].body.messages[0].content),
    /<vups_tool_call>/,
    "the compatibility attempt carries the validated text protocol"
  );
  fakeProvider.state.set({ chatStatus: 200, chatErrorPayload: null });
});

test("a permanent 400 unrelated to tools is reported at once and never retried", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({
    toolCalls: null,
    chatResponseText: "unused",
    chatStatus: 400,
    chatErrorPayload: { error: { message: "Invalid model: not a valid model ID." } }
  });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: runId("modelbad"), messages: [{ role: "user", content: "List my Downloads folder." }] }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "invalid_model");
  assert.match(response.body.message, /not a valid model ID/);
  assert.equal(fakeProvider.state.chatRequests.length, 1, "a permanent 400 must not be retried");
  fakeProvider.state.set({ chatStatus: 200, chatErrorPayload: null });
});

test("an Anthropic Messages provider reaches the same local tool registry", async () => {
  const { DESKTOP_TOOLS } = await import("./desktopTools.js");
  const cookie = await signupUser("Anthropic Desktop Tester");
  const saved = await api("/api/settings/provider", {
    method: "PUT",
    cookie,
    body: {
      provider: "Fake Anthropic",
      baseUrl: anthropicBaseURL,
      apiKey: "sk-ant-route-test-123456",
      model: "claude-route-test",
      providerType: "anthropic_compatible"
    }
  });
  assert.equal(saved.status, 200);
  anthropicRequests.length = 0;

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: runId("anthropic"), messages: [{ role: "user", content: "List C:/Users/Test." }] }
  });

  assert.equal(response.status, 200, "the former tool_calling_unsupported gate is gone");
  assert.equal(response.body.type, "tool_calls");
  assert.equal(response.body.toolCalls.length, 1);
  assert.equal(response.body.toolCalls[0].function.name, "list_directory");
  assert.equal(anthropicRequests.length, 1);
  assert.equal(anthropicRequests[0].url, "/v1/messages");
  assert.equal(anthropicRequests[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(Array.isArray(anthropicRequests[0].body.tools), true);
  assert.equal(anthropicRequests[0].body.tools.length, DESKTOP_TOOLS.length);
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

  assert.match(DESKTOP_TOOL_PROMPT, /complete each dependent step without pausing to ask whether to continue/);
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

test("a permission question is recognized only after real tool work", async () => {
  const { asksPermissionToContinue } = await import("./desktopTools.js");

  assert.equal(
    asksPermissionToContinue({
      text: "I created index.html and style.css. Would you like me to continue with script.js?",
      hasToolResults: true
    }),
    true
  );
  assert.equal(
    asksPermissionToContinue({
      text: "Would you like me to continue with script.js?",
      hasToolResults: false
    }),
    false,
    "without completed tool work this is an ordinary reply"
  );
  assert.equal(
    asksPermissionToContinue({
      text: "I found two Qoder folders. Which one should I use: C:\\Users\\test\\Qoder or D:\\Qoder?",
      hasToolResults: true
    }),
    false,
    "a genuine clarification must stay a question"
  );
});

test("a model that stops to ask before the last requested file gets one continuation round", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({
    chatResponseText: "I created index.html and style.css. Would you like me to continue with script.js?",
    nudgeToolCalls: [
      { name: "write_file", args: { path: "C:\\Users\\test\\site\\script.js", content: "console.log('ready');" } }
    ]
  });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("continue-files"),
      messages: [
        { role: "user", content: "Create index.html, style.css and script.js in C:\\Users\\test\\site." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_html",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: "C:\\Users\\test\\site\\index.html", content: "<h1>Hi</h1>" }) }
            },
            {
              id: "call_css",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: "C:\\Users\\test\\site\\style.css", content: "body { margin: 0; }" }) }
            }
          ]
        },
        { role: "tool", tool_call_id: "call_html", content: JSON.stringify({ ok: true, data: { path: "C:\\Users\\test\\site\\index.html" } }) },
        { role: "tool", tool_call_id: "call_css", content: JSON.stringify({ ok: true, data: { path: "C:\\Users\\test\\site\\style.css" } }) }
      ]
    }
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.type, "tool_calls", "the dependent step continues instead of stopping on a question");
  assert.equal(response.body.toolCalls[0].function.name, "write_file");
  assert.equal(fakeProvider.state.chatRequests.length, 2, "exactly one continuation round");
  const followUp = fakeProvider.state.chatRequests[1].body.messages;
  assert.equal(followUp.at(-2).role, "assistant");
  assert.equal(followUp.at(-1).role, "system");
  assert.match(followUp.at(-1).content, /finish every deliverable/);
});

test("a genuine clarification question is preserved, not converted into a tool call", async () => {
  const cookie = await newUser();
  const question = "I found two Qoder folders. Which one should I use: C:\\Users\\test\\Qoder or D:\\Qoder?";
  fakeProvider.state.set({
    chatResponseText: question,
    nudgeToolCalls: [{ name: "search_files", args: { root: "C:\\Users\\test", query: "Qoder" } }]
  });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("clarify"),
      messages: [
        { role: "user", content: "Find my Qoder folder." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_find", type: "function", function: { name: "search_files", arguments: JSON.stringify({ root: "C:\\Users\\test", query: "Qoder" }) } }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_find",
          content: JSON.stringify({ ok: true, data: { entries: [{ name: "Qoder", path: "C:\\Users\\test\\Qoder" }] } })
        }
      ]
    }
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.type, "final");
  assert.equal(response.body.content, question);
  assert.equal(fakeProvider.state.chatRequests.length, 1, "a real clarification spends no forced round");
});

test("an announced search is followed by a real tool call instead of ending on the promise", async () => {
  const cookie = await newUser();
  fakeProvider.state.set({
    chatResponseText: "I'll search for the Qoder folder in the common directories.",
    nudgeToolCalls: [{ name: "search_files", args: { root: "C:\\Users\\test", query: "Qoder" } }]
  });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("announce"),
      messages: [{ role: "user", content: "Can you find my Qoder folder and give that path?" }]
    }
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.type, "tool_calls", "the promise must be turned into a real tool call");
  assert.equal(response.body.toolCalls[0].function.name, "search_files");
  assert.deepEqual(JSON.parse(response.body.toolCalls[0].function.arguments), { root: "C:\\Users\\test", query: "Qoder" });

  assert.equal(fakeProvider.state.chatRequests.length, 2, "exactly one follow-up round is spent on the announcement");
  const followUp = fakeProvider.state.chatRequests[1].body.messages;
  assert.equal(followUp.at(-2).role, "assistant", "the announcement stays in context");
  assert.equal(followUp.at(-1).role, "system");
  assert.match(followUp.at(-1).content, /did not call any tool/);
});

test("a promise that stays a promise ends honestly and is never marked as executed", async () => {
  const cookie = await newUser();
  const promise = "I'll search for the Qoder folder in the common directories.";
  fakeProvider.state.set({ chatResponseText: promise, nudgeResponseText: promise });

  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("still-promise"),
      messages: [{ role: "user", content: "Can you find my Qoder folder and give that path?" }]
    }
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.type, "final");
  assert.equal(fakeProvider.state.chatRequests.length, 2, "one nudge, never an endless loop");
  assert.equal(response.body.finishReason, "stop");
  assert.doesNotMatch(response.body.content, /I found|here are the paths|C:\\/i);
});

test("consecutive tool rounds all reach the model before the final answer", async () => {
  const cookie = await newUser();
  const id = runId("two-rounds");
  const userText = "Find my Qoder folder and confirm what is in it.";

  fakeProvider.state.set({
    toolCalls: [{ id: "call_a", name: "list_directory", args: { path: "C:\\Users\\test" } }]
  });
  const first = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: id, messages: [{ role: "user", content: userText }] }
  });
  assert.equal(first.body.type, "tool_calls");
  assert.equal(first.body.toolCalls[0].id, "call_a");

  fakeProvider.state.set({
    toolCalls: [{ id: "call_b", name: "search_files", args: { root: "C:\\Users\\test\\Qoder", query: "config" } }]
  });
  const second = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: id,
      messages: [
        { role: "user", content: userText },
        first.body.assistantMessage,
        { role: "tool", tool_call_id: "call_a", content: JSON.stringify({ ok: true, data: { entries: [{ name: "Qoder" }] } }) }
      ]
    }
  });
  assert.equal(second.body.type, "tool_calls");
  assert.equal(second.body.toolCalls[0].id, "call_b");
  const secondRequest = fakeProvider.state.chatRequests.at(-1).body.messages;
  assert.ok(
    secondRequest.some(message => message.role === "tool" && message.tool_call_id === "call_a"),
    "the first result is sent back before the second action"
  );

  fakeProvider.state.set({
    toolCalls: null,
    chatResponseText: "The Qoder folder is C:\\Users\\test\\Qoder and it contains config.json."
  });
  const third = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: id,
      messages: [
        { role: "user", content: userText },
        first.body.assistantMessage,
        { role: "tool", tool_call_id: "call_a", content: JSON.stringify({ ok: true, data: { entries: [{ name: "Qoder" }] } }) },
        second.body.assistantMessage,
        { role: "tool", tool_call_id: "call_b", content: JSON.stringify({ ok: true, data: { matches: [{ path: "C:\\Users\\test\\Qoder\\config.json" }] } }) }
      ]
    }
  });
  assert.equal(third.body.type, "final");
  assert.match(third.body.content, /C:\\Users\\test\\Qoder/);
});

test("a clarifying question is delivered as the turn and the task resumes after the answer", async () => {
  const cookie = await newUser();
  const id = runId("clarify");
  const question = "Which location should I search: the whole computer, common development folders, or a specific drive?";

  fakeProvider.state.set({ toolCalls: null, chatResponseText: question });
  const first = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: id, messages: [{ role: "user", content: "Find my Qoder folder." }] }
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.type, "final");
  assert.equal(first.body.content, question);
  assert.equal(fakeProvider.state.chatRequests.length, 1, "a question is not an unfulfilled action promise");

  fakeProvider.state.set({
    chatResponseText: null,
    toolCalls: [{ id: "call_scope", name: "search_files", args: { root: "C:\\Users\\test\\Documents", query: "Qoder" } }]
  });
  const second = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: id,
      messages: [
        { role: "user", content: "Find my Qoder folder." },
        { role: "assistant", content: question },
        { role: "user", content: "Search my development folders." }
      ]
    }
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.type, "tool_calls", "the same task continues after the answer");
  assert.equal(second.body.toolCalls[0].function.name, "search_files");
});

test("the announcement follow-up is provider- and model-independent", async () => {
  const cookie = await newUser();
  const configId = "second-fake";
  const saved = await api("/api/settings/providers/second-fake", {
    method: "PUT",
    cookie,
    body: {
      provider: "Second Fake",
      providerId: "second-fake",
      providerType: "openai_compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-pro"
    }
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.config.configId, configId);

  fakeProvider.state.set({
    chatResponseText: "Let me check the Documents folder for a Qoder directory.",
    nudgeToolCalls: [{ name: "search_files", args: { root: "C:\\Users\\test\\Documents", query: "Qoder" } }]
  });
  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("second-provider"),
      model: "fake-model-pro",
      configId,
      messages: [{ role: "user", content: "Find my Qoder folder under Documents." }]
    }
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.type, "tool_calls");
  const requests = fakeProvider.state.chatRequests;
  assert.equal(requests.at(-1).body.model, "fake-model-pro");
  assert.equal(requests.length, 2, "the nudge applies to a second configuration unchanged");
});

test("cancelling a tool turn stops the execution loop without a fabricated final answer", async () => {
  const cookie = await newUser();
  const id = runId("cancel");
  fakeProvider.state.set({
    chatResponseText: "I'll search for the Qoder folder in the common directories.",
    nudgeToolCalls: [{ name: "search_files", args: { root: "C:\\Users\\test", query: "Qoder" } }],
    chatDelayMs: 250
  });

  const controller = new AbortController();
  const pending = fetch(`${baseURL}/api/chat/desktop-tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      runId: id,
      messages: [{ role: "user", content: "Can you find my Qoder folder and give that path?" }]
    }),
    signal: controller.signal
  }).catch(error => error);

  setTimeout(() => controller.abort(), 80);
  const outcome = await pending;
  assert.equal(outcome.name, "AbortError");

  fakeProvider.state.set({ chatDelayMs: 0, chatResponseText: null, nudgeToolCalls: null });
  const next = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: id, messages: [{ role: "user", content: "Never mind." }] }
  });
  assert.notEqual(next.status, 409, "a cancelled run releases its busy slot");
  assert.equal(next.body.type, "final");
});

test("a write_file call as large as the file it wrote is replayed on the next round", async () => {
  // Reproduced from the Windows app: script.js was 14,861 bytes, and the next
  // tool round replayed its write_file call. The old 12,000-character replay
  // cap rejected the route's own history, so the turn after a successful large
  // write failed and every remaining file was lost.
  const cookie = await newUser();
  const id = runId("large-replay");
  const fileBody = `const boot = ${JSON.stringify("x".repeat(14861))};\n`;
  assert.ok(fileBody.length > 12000, "the fixture must exceed the old 12,000 cap");

  fakeProvider.state.set({
    toolCalls: [{ id: "call_write", name: "write_file", args: { path: "C:\\project\\Tested Folder\\script.js", content: fileBody } }]
  });
  const first = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: { runId: id, messages: [{ role: "user", content: "Build the page files." }] }
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.type, "tool_calls");
  assert.equal(first.body.toolCalls[0].function.name, "write_file");
  assert.ok(first.body.toolCalls[0].function.arguments.length > 12000);

  fakeProvider.state.set({ toolCalls: null, chatResponseText: "The files are written." });
  const second = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: id,
      messages: [
        { role: "user", content: "Build the page files." },
        first.body.assistantMessage,
        {
          role: "tool",
          tool_call_id: "call_write",
          content: JSON.stringify({ ok: true, data: { path: "C:\\project\\Tested Folder\\script.js", bytesWritten: fileBody.length } })
        }
      ]
    }
  });

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.type, "final");
  const replayed = lastProviderBody().messages.find(message => message.role === "assistant" && message.tool_calls);
  assert.equal(replayed.tool_calls[0].function.name, "write_file");
  assert.ok(replayed.tool_calls[0].function.arguments.length > 12000, "the real file text reaches the model");
});

test("a replayed tool call above the replay bound gets its own honest message", async () => {
  const cookie = await newUser();
  const before = fakeProvider.state.chatRequests.length;
  const response = await api("/api/chat/desktop-tools", {
    method: "POST",
    cookie,
    body: {
      runId: runId("oversized"),
      messages: [
        { role: "user", content: "Write an enormous file." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_huge",
            type: "function",
            function: { name: "write_file", arguments: JSON.stringify({ path: "C:\\huge.txt", content: "x".repeat(200001) }) }
          }]
        },
        { role: "tool", tool_call_id: "call_huge", content: "{\"ok\":true}" }
      ]
    }
  });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /larger than the server can replay/i);
  assert.equal(fakeProvider.state.chatRequests.length, before);
});

test("a desktop run expires from idleness, not total age", async () => {
  const { desktopRunExpired } = await import("./routes/chat.js");
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  assert.equal(desktopRunExpired({ createdAt: now - hour }, now), true, "an idle run expires");
  assert.equal(
    desktopRunExpired({ createdAt: now - hour, lastUsedAt: now - 1000 }, now),
    false,
    "a run still receiving rounds stays alive past the TTL"
  );
  assert.equal(desktopRunExpired({ lastUsedAt: now - hour }, now), true);
});

