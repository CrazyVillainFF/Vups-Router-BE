import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.CHAT_RATE_LIMIT_MAX = "10000";
process.env.SETTINGS_RATE_LIMIT_MAX = "10000";
process.env.AI_DAILY_QUOTA = "1000";
// Read once when the chat router is imported.
process.env.CHAT_SSE_HEARTBEAT_MS = "1000";
delete process.env.MONGODB_URI;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OLLAMA_BASE_URL;
delete process.env.VUPS_BASE_URL;
delete process.env.VUPS_API_KEY;
delete process.env.VUPS_UNDERLYING_MODEL;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_chat_heartbeat_test");

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

function sessionCookie(response) {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find(value => value.startsWith("vr_session="));
  return session ? session.split(";")[0] : null;
}

async function newUser() {
  fakeProvider.state.reset();
  const signup = await fetch(`${baseURL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Heartbeat Tester",
      email: `heartbeat-${Date.now()}@example.com`,
      password: "correct-horse-battery"
    })
  });
  assert.equal(signup.status, 201);
  const cookie = sessionCookie(signup);
  const saved = await fetch(`${baseURL}/api/settings/provider`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      provider: "Fake OpenAI-compatible",
      baseUrl: fakeProvider.baseUrl,
      apiKey: FAKE_API_KEY,
      model: "fake-model-mini"
    })
  });
  assert.equal(saved.status, 200);
  fakeProvider.state.reset();
  return cookie;
}

test("the standard chat stream sends keepalives while a provider is quiet", async () => {
  const cookie = await newUser();
  // Headers arrive immediately, then the first upstream chunk stays quiet for
  // longer than the heartbeat interval. The client must see the connection is
  // alive instead of treating the silence as a stalled model.
  fakeProvider.state.set({ streamInitialDelayMs: 1300 });
  const response = await fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Say hello slowly" }] })
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /^: keepalive$/m, "a quiet provider must not look like a dead connection");
  const events = text
    .split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
  assert.ok(events.some(event => event.type === "delta"));
  assert.ok(events.some(event => event.type === "done"));
});
