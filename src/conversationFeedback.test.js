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
process.env.MONGODB_URI = mongod.getUri("vupsrouter_conversation_feedback_test");

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
  return `feedback${Date.now()}-${counter}@example.com`;
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
    body: { name: "Feedback Tester", email, password: "correct-horse-battery" }
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

async function createAnsweredConversation(cookie) {
  const response = await api("/api/chat", {
    method: "POST",
    cookie,
    body: { messages: [{ role: "user", content: "Give me a short answer." }], stream: false }
  });
  assert.equal(response.status, 200);
  return {
    conversationId: response.body.conversationId,
    messageId: response.body.message?.messageId
  };
}

test("message feedback requires a signed-in user", async () => {
  const response = await api(
    "/api/conversations/6adefc59cae7da140c271ff9/messages/msg-1/feedback",
    { method: "PUT", body: { value: "like" } }
  );
  assert.equal(response.status, 401);
});

test("feedback persists on the assistant message and can be changed or cleared", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  const { conversationId, messageId } = await createAnsweredConversation(cookie);
  assert.ok(conversationId);
  assert.ok(messageId);

  const path = `/api/conversations/${conversationId}/messages/${messageId}/feedback`;

  const liked = await api(path, { method: "PUT", cookie, body: { value: "like" } });
  assert.equal(liked.status, 200);
  assert.equal(liked.body.feedback, "like");

  const fetched = await api(`/api/conversations/${conversationId}`, { cookie });
  assert.equal(fetched.status, 200);
  const assistant = fetched.body.conversation.messages.find(message => message.role === "assistant");
  assert.equal(assistant.feedback, "like");

  const disliked = await api(path, { method: "PUT", cookie, body: { value: "dislike" } });
  assert.equal(disliked.status, 200);
  assert.equal(disliked.body.feedback, "dislike");

  const cleared = await api(path, { method: "PUT", cookie, body: { value: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.feedback, null);
  const afterClear = await api(`/api/conversations/${conversationId}`, { cookie });
  const clearedMessage = afterClear.body.conversation.messages.find(message => message.role === "assistant");
  assert.equal(clearedMessage.feedback, undefined);
});

test("feedback input is validated and never crosses conversation ownership", async () => {
  fakeProvider.state.reset();
  const cookie = await signupUser();
  await configureProvider(cookie);
  const { conversationId, messageId } = await createAnsweredConversation(cookie);
  const path = `/api/conversations/${conversationId}/messages/${messageId}/feedback`;

  const invalid = await api(path, { method: "PUT", cookie, body: { value: "neutral" } });
  assert.equal(invalid.status, 400);

  const missingMessage = await api(
    `/api/conversations/${conversationId}/messages/does-not-exist/feedback`,
    { method: "PUT", cookie, body: { value: "like" } }
  );
  assert.equal(missingMessage.status, 404);

  const otherCookie = await signupUser();
  const denied = await api(path, { method: "PUT", cookie: otherCookie, body: { value: "like" } });
  assert.equal(denied.status, 404);

  const invalidId = await api("/api/conversations/not-an-id/messages/msg-1/feedback", {
    method: "PUT",
    cookie,
    body: { value: "like" }
  });
  assert.equal(invalidId.status, 404);
});
