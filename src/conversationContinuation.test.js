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
process.env.MONGODB_URI = mongod.getUri("vupsrouter_conversation_continuation_test");

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
  return `continuation${Date.now()}-${counter}@example.com`;
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

async function signupUser() {
  const email = uniqueEmail();
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "Continuation Tester", email, password: "correct-horse-battery" }
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

const HANDOFF = [
  "Continue this task: Ship the invoice CSV export.",
  "",
  "Context handoff from the previous conversation",
  "- Keep the existing table filters.",
  "- src/InvoiceTable.jsx is complete; src/exportCsv.js is incomplete."
].join("\n");

test("creating a continuation conversation requires a signed-in user", async () => {
  const response = await api("/api/conversations", {
    method: "POST",
    body: { handoff: HANDOFF, title: "Continue: Invoice export" }
  });
  assert.equal(response.status, 401);
});

test("a continuation is persisted with its handoff and remains owned by its creator", async () => {
  const cookie = await signupUser();
  const created = await api("/api/conversations", {
    method: "POST",
    cookie,
    body: { handoff: HANDOFF, title: "Continue: Invoice export" }
  });

  assert.equal(created.status, 201);
  const conversation = created.body.conversation;
  assert.ok(mongoose.isValidObjectId(conversation.id));
  assert.equal(conversation.title, "Continue: Invoice export");
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].role, "user");
  assert.equal(conversation.messages[0].content, HANDOFF);

  const fetched = await api(`/api/conversations/${conversation.id}`, { cookie });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.conversation.messages[0].content, HANDOFF);

  const listed = await api("/api/conversations", { cookie });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.conversations.some(item => item.id === conversation.id));

  const otherCookie = await signupUser();
  const denied = await api(`/api/conversations/${conversation.id}`, { cookie: otherCookie });
  assert.equal(denied.status, 404);
});

test("continuation input is bounded and titles stay compact", async () => {
  const cookie = await signupUser();

  const missing = await api("/api/conversations", {
    method: "POST",
    cookie,
    body: { title: "No summary" }
  });
  assert.equal(missing.status, 400);

  const oversized = await api("/api/conversations", {
    method: "POST",
    cookie,
    body: { handoff: "x".repeat(20001) }
  });
  assert.equal(oversized.status, 413);

  const created = await api("/api/conversations", {
    method: "POST",
    cookie,
    body: { handoff: HANDOFF, title: "T".repeat(200) }
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.conversation.title.length, 60);
});

test("the first model request in the new chat receives the persisted handoff", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);

  const created = await api("/api/conversations", {
    method: "POST",
    cookie,
    body: { handoff: HANDOFF, title: "Continue: Invoice export" }
  });
  assert.equal(created.status, 201);
  const conversationId = created.body.conversation.id;

  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: {
      conversationId,
      messages: [{ role: "user", content: HANDOFF }],
      stream: false
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.conversationId, conversationId);
  const upstream = fakeProvider.state.chatRequests.at(-1)?.body?.messages || [];
  assert.ok(
    upstream.some(message => message.role === "user" && message.content === HANDOFF),
    "the upstream request must carry the handoff text"
  );

  const stored = await api(`/api/conversations/${conversationId}`, { cookie });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.conversation.title, "Continue: Invoice export");
  assert.equal(stored.body.conversation.messages[0].content, HANDOFF);
  assert.equal(stored.body.conversation.messages.at(-1).role, "assistant");
});
