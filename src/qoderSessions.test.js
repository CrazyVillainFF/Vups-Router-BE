import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chatCompletion, ProviderError, startChatCompletionStream } from "./providerClient.js";
import { FAKE_QODER_API_KEY, FAKE_QODER_MODEL, startFakeQoder } from "./testUtils/fakeQoder.js";

const MODEL = FAKE_QODER_MODEL;

let fake;
let baseUrl;
let requests;

before(async () => {
  fake = await startFakeQoder();
  baseUrl = fake.baseUrl;
  requests = fake.state.requests;
});

after(async () => {
  await fake?.close();
});

beforeEach(() => {
  fake.state.clearRequests();
  requests = fake.state.requests;
});

async function collect(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  const chunks = [];
  let terminalCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = JSON.parse(payload);
    chunks.push(parsed);
    if (typeof parsed?.choices?.[0]?.finish_reason === "string") terminalCount += 1;
  }
  return { text: chunks.map(chunk => chunk?.choices?.[0]?.delta?.content ?? "").join(""), terminalCount };
}

function stream(params, signal) {
  return startChatCompletionStream({ baseUrl, apiKey: FAKE_QODER_API_KEY, providerType: "qoder_cloud_agents", model: MODEL, ...params }, signal);
}

async function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    await new Promise(done => setTimeout(done, 25));
  }
  return check();
}

const sessions = () => fake.state.paths("POST", "/api/v1/cloud/sessions").filter(entry => entry.path === "/api/v1/cloud/sessions");
const postedBatches = () => fake.state.requests.filter(entry => entry.method === "POST" && /\/sessions\/[^/]+\/events$/.test(entry.path));

test("a conversation reuses its Qoder session and sends only the newest turn", async () => {
  const conversationId = "conv-reuse-1";
  await collect(await stream({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hello" }], conversationId }));

  fake.state.clearRequests();
  const second = await stream({
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Second" }
    ],
    conversationId
  });
  const result = await collect(second);

  assert.equal(result.text, "Hello world");
  assert.equal(sessions().length, 0, "the turn continued the session Qoder already holds");
  assert.deepEqual(postedBatches()[0].body.events[0].content, [{ type: "text", text: "[User]\nSecond" }]);
});

test("without a conversation each turn keeps its own session, as before", async () => {
  await collect(await stream({ messages: [{ role: "user", content: "Hello" }] }));
  await collect(await stream({ messages: [{ role: "user", content: "Hello again" }] }));
  assert.equal(sessions().length, 2);
  assert.equal(postedBatches().length, 2);
});

test("a retried turn never posts the same batch twice", async () => {
  const conversationId = "conv-retry-1";
  const messages = [{ role: "user", content: "Hello" }];
  await collect(await stream({ messages, conversationId }));
  // The chat route re-issues an interrupted turn with identical arguments.
  await collect(await stream({ messages, conversationId }));

  assert.equal(sessions().length, 1);
  assert.equal(postedBatches().length, 1, "the batch Qoder already accepted is not run a second time");
});

test("a dropped stream resumes with Last-Event-ID and folds the buffered reply", async () => {
  fake.state.dropAfterFrames = 4;
  const result = await collect(await stream({ messages: [{ role: "user", content: "Hello" }] }));

  const streamRequests = requests.filter(entry => entry.method === "GET" && entry.path.endsWith("/events/stream"));
  assert.equal(streamRequests.length, 2, "the turn is resumed, not restarted");
  assert.equal(streamRequests[1].headers["last-event-id"], "evt_am");
  assert.equal(result.text, "Hello world");
  assert.equal(result.terminalCount, 1);
});

test("a replayed buffered event is delivered to the chat once", async () => {
  fake.state.replayBuffered = true;
  const result = await collect(await stream({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(result.text, "Hello world");
  assert.equal(result.terminalCount, 1);
});

test("a session archived since the last turn is replaced with the whole transcript", async () => {
  const conversationId = "conv-archived-1";
  await collect(await stream({ messages: [{ role: "user", content: "Hello" }], conversationId }));

  fake.state.clearRequests();
  fake.state.streamNotFoundOnce = 1;
  const result = await collect(await stream({
    messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }, { role: "user", content: "Second" }],
    conversationId
  }));

  assert.equal(result.text, "Hello world");
  assert.equal(sessions().length, 1, "a new session is created for the dead one");
  const blocks = postedBatches()[0].body.events[0].content.map(block => block.text);
  assert.deepEqual(blocks, ["[User]\nHello", "[Assistant]\nHi", "[User]\nSecond"], "the replacement session starts with the conversation it lost");
});

test("a busy session is reported as session_busy, never as a generic failure", async () => {
  fake.state.busyOnce = 1;
  await assert.rejects(
    () => stream({ messages: [{ role: "user", content: "Hello" }] }),
    error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "session_busy");
      assert.match(error.message, /still working on the previous reply/);
      assert.doesNotMatch(error.message, new RegExp(FAKE_QODER_API_KEY));
      return true;
    }
  );
});

test("stopping a turn interrupts it so the next message is not blocked", async () => {
  fake.state.holdOpen = true;
  const controller = new AbortController();
  const response = await stream({ messages: [{ role: "user", content: "Hello" }], conversationId: "conv-stop-1" }, controller.signal);
  const reader = response.body.getReader();
  await reader.read();
  const sessionId = fake.state.sessions.at(-1).id;
  controller.abort();

  assert.equal(await waitFor(() => fake.state.interrupts.length > 0), true, "the abandoned turn is interrupted, not left running");
  assert.deepEqual(fake.state.interrupts, [sessionId]);
  assert.equal(postedBatches()[0].body.events[0].type, "user.message");
});

test("separate conversations and credentials never share a session", async () => {
  await collect(await stream({ messages: [{ role: "user", content: "Hello" }], conversationId: "conv-isolation-a" }));
  await collect(await stream({ messages: [{ role: "user", content: "Hello" }], conversationId: "conv-isolation-b" }));
  assert.equal(sessions().length, 2);
  assert.deepEqual(sessions().map(entry => entry.body.agent), ["agent_ultimate", "agent_ultimate"]);

  fake.state.clearRequests();
  await chatCompletion({
    baseUrl,
    apiKey: FAKE_QODER_API_KEY,
    providerType: "qoder_cloud_agents",
    model: "giga",
    messages: [{ role: "user", content: "Hello" }],
    conversationId: "conv-isolation-a"
  });
  assert.equal(sessions().length, 1, "another agent needs its own session");
  assert.equal(sessions()[0].body.agent, "agent_giga");
});

test("the session id Qoder returns is the one addressed by later calls", async () => {
  const response = await stream({ messages: [{ role: "user", content: "Hello" }], conversationId: "conv-url-1" });
  const result = await collect(response);
  assert.equal(result.text, "Hello world");
  assert.equal(
    new URL(response.url).pathname,
    `/api/v1/cloud/sessions/${fake.state.sessions.at(-1).id}/events/stream`,
    "the adapter talks to the session this conversation owns"
  );
  assert.match(response.url, /event_deltas%5B%5D=agent\.message/);
});
