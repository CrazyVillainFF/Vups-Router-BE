import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.SETTINGS_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.VUPS_BASE_URL;
delete process.env.VUPS_API_KEY;
delete process.env.VUPS_UNDERLYING_MODEL;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_chat_persistence_test");

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
  return `persist${Date.now()}-${counter}@example.com`;
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
  return { status: response.status, body: json, headers: response.headers, text };
}

function sessionCookie(response) {
  return response.headers.getSetCookie().find(value => value.startsWith("vr_session="))?.split(";")[0] ?? null;
}

async function signupUser() {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Persist Tester", email: uniqueEmail(), password: "correct-horse-battery", acceptTerms: true }
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

async function conversationOf(cookie, id) {
  const response = await api(`/api/conversations/${id}`, { cookie });
  assert.equal(response.status, 200);
  return response.body.conversation;
}

async function waitForAssistantTurn(cookie, id, assertOn) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const conversation = await conversationOf(cookie, id);
    const assistant = conversation.messages.filter(message => message.role === "assistant").at(-1);
    if (assistant) {
      assertOn(assistant, conversation);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("the unanswered turn never produced a record");
}

function chatBody(prompt, extra = {}) {
  return { messages: [{ role: "user", content: prompt }], stream: true, ...extra };
}

async function startChatStream(cookie, body, onEvent) {
  const controller = new AbortController();
  const responsePromise = fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
    signal: controller.signal
  });
  const events = [];
  const done = (async () => {
    const response = await responsePromise;
    if (!response.ok) return { status: response.status, body: await response.json() };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        events.push(parsed);
        onEvent?.(parsed, controller);
      }
    }
    return { status: response.status, events };
  })();
  return { done, events, controller };
}

test("1. the user message is durable while the model is still loading", async () => {
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();
  fakeProvider.state.set({ chatDelayMs: 1500, streamChunkDelayMs: 0 });

  const prompt = "durable-before-answer-please";
  const stream = await startChatStream(cookie, chatBody(prompt));
  try {
    let seen = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const list = await api("/api/conversations", { cookie });
      seen = list.body.conversations?.find(item => item.title.includes(prompt));
      if (seen) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(seen, "the conversation appeared in the sidebar before the provider answered");
    const conversation = await conversationOf(cookie, seen.id);
    assert.deepEqual(
      conversation.messages.map(message => [message.role, message.content]),
      [["user", prompt]],
      "only the submitted message is stored while generation has not produced anything"
    );
  } finally {
    stream.controller.abort();
    await stream.done.catch(() => {});
    fakeProvider.state.set({ chatDelayMs: 0 });
  }
});

test("2. a provider that fails before the first token keeps the message and records the failure", async () => {
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();
  fakeProvider.state.set({ chatStatus: 503, chatStatusText: "upstream unavailable" });

  const prompt = "failing-provider-turn";
  const response = await api("/api/chat", { method: "POST", cookie, body: chatBody(prompt) });
  fakeProvider.state.set({ chatStatus: 200, chatStatusText: "" });
  assert.ok(response.status >= 500, `a failing upstream answers with a server status, got ${response.status}`);

  const list = await api("/api/conversations", { cookie });
  const found = list.body.conversations.find(item => item.title.includes(prompt));
  assert.ok(found, "a failed turn still leaves the conversation in the sidebar");
  await waitForAssistantTurn(cookie, found.id, assistant => {
    assert.equal(assistant.status, "failed");
    assert.ok(assistant.content.length > 0, "the failure is readable inside the conversation");
  });
  const conversation = await conversationOf(cookie, found.id);
  assert.equal(conversation.messages[0].content, prompt, "the user message survived the failure");
});

test("3. an empty model response is recorded instead of dropping the turn", async () => {
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();
  fakeProvider.state.set({ emptyStream: true });

  const prompt = "empty-response-turn";
  const stream = await startChatStream(cookie, chatBody(prompt));
  const result = await stream.done;
  fakeProvider.state.set({ emptyStream: false });
  assert.equal(result.status, 200);
  const meta = result.events.find(event => event.type === "meta");
  assert.ok(meta?.conversationId, "the stream still names the conversation it wrote");

  await waitForAssistantTurn(cookie, meta.conversationId, assistant => {
    assert.equal(assistant.status, "failed");
    assert.match(assistant.content, /empty response/i);
  });
});

test("4. closing the app mid-generation keeps the message and marks the turn interrupted", async () => {
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();
  fakeProvider.state.set({ streamChunkDelayMs: 120 });

  const prompt = "disconnect-mid-stream-turn";
  const stream = await startChatStream(cookie, chatBody(prompt), (event, controller) => {
    if (event.type === "delta") controller.abort();
  });
  await stream.done.catch(() => {});
  fakeProvider.state.set({ streamChunkDelayMs: 5 });

  let id = null;
  for (let attempt = 0; attempt < 20 && !id; attempt += 1) {
    const list = await api("/api/conversations", { cookie });
    id = list.body.conversations.find(item => item.title.includes(prompt))?.id ?? null;
    if (!id) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(id, "the chat is still listed after the app was closed");
  await waitForAssistantTurn(cookie, id, assistant => {
    assert.equal(assistant.status, "interrupted");
  });
  const conversation = await conversationOf(cookie, id);
  assert.equal(conversation.messages[0].content, prompt);
});

test("5. a retry with the same client message id does not store the message twice", async () => {
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();

  const messageId = "client-user-message-1";
  const prompt = "idempotent-retry-turn";
  const first = await startChatStream(cookie, {
    messages: [{ role: "user", content: prompt, messageId }],
    stream: true
  });
  const firstResult = await first.done;
  const second = await startChatStream(cookie, {
    messages: [{ role: "user", content: prompt, messageId }],
    stream: true,
    conversationId: firstResult.events.find(event => event.type === "meta")?.conversationId
  });
  await second.done;

  const id = firstResult.events.find(event => event.type === "meta")?.conversationId;
  const conversation = await conversationOf(cookie, id);
  const users = conversation.messages.filter(message => message.role === "user");
  assert.equal(users.length, 1, "resending the same submitted message does not duplicate it");
  assert.equal(users[0].messageId, messageId);
});

test("6. Stop on a non-streaming turn keeps the message and discards the late answer", async () => {
  const cookie = await signupUser();
  await configureProvider(cookie);
  fakeProvider.state.reset();
  fakeProvider.state.set({ chatDelayMs: 300, chatResponseText: "answer that arrived after Stop" });

  const prompt = "stopped-non-streaming-turn";
  const controller = new AbortController();
  const request = fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      stream: false,
      model: "fake-model-mini",
      messages: [{ role: "user", content: prompt }]
    }),
    signal: controller.signal
  });
  // The message is on disk before the provider is called, so the upstream call
  // has to be in flight before Stop is pressed.
  for (let attempt = 0; attempt < 60 && fakeProvider.state.chatRequests.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(fakeProvider.state.chatRequests.length, 1, "the upstream request is in flight");
  controller.abort();
  await request.catch(() => {});
  // Long enough that a provider answer arriving after Stop would have been saved.
  await new Promise(resolve => setTimeout(resolve, 500));

  const list = await api("/api/conversations", { cookie });
  const found = list.body.conversations.find(item => item.title.includes(prompt));
  assert.ok(found, "a stopped submission stays in the sidebar");
  const conversation = await conversationOf(cookie, found.id);
  assert.equal(conversation.messages[0].role, "user");
  assert.equal(conversation.messages[0].content, prompt, "Stop does not take the submitted message away");
  const assistant = conversation.messages.at(-1);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.status, "interrupted");
  assert.ok(!JSON.stringify(conversation.messages).includes("answer that arrived after Stop"),
    "a late provider answer is never saved");
  fakeProvider.state.reset();
});
