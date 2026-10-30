import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  chatCompletion,
  listProviderModels,
  ProviderError,
  qoderEventContent,
  resolveChatEndpoint,
  startChatCompletionStream,
  testProviderConnection,
  usesResponsesApi
} from "./providerClient.js";
import { FAKE_QODER_API_KEY, FAKE_QODER_MODEL, FAKE_QODER_REPLY, startFakeQoder } from "./testUtils/fakeQoder.js";

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
  let doneMarker = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      doneMarker = true;
      continue;
    }
    const parsed = JSON.parse(payload);
    chunks.push(parsed);
    if (typeof parsed?.choices?.[0]?.finish_reason === "string") terminalCount += 1;
  }
  const text = chunks.map(chunk => chunk?.choices?.[0]?.delta?.content ?? "").join("");
  return { text, chunks, terminalCount, doneMarker };
}

async function stream(params) {
  return startChatCompletionStream({ baseUrl, apiKey: FAKE_QODER_API_KEY, providerType: "qoder_cloud_agents", model: MODEL, messages: [{ role: "user", content: "Hello" }], ...params });
}

test("Qoder is never routed through the OpenAI chat or responses endpoints", () => {
  assert.equal(resolveChatEndpoint(baseUrl, MODEL, "qoder_cloud_agents"), `${baseUrl}/sessions`);
  assert.equal(usesResponsesApi(baseUrl, MODEL, "qoder_cloud_agents"), false);
  assert.equal(resolveChatEndpoint("https://api.qoder.com", MODEL, "qoder_cloud_agents"), "https://api.qoder.com/api/v1/cloud/sessions");
});

test("Qoder model listing reads the enabled models from GET /models", async () => {
  const models = await listProviderModels({ baseUrl, apiKey: FAKE_QODER_API_KEY, providerType: "qoder_cloud_agents" });
  assert.deepEqual(models.map(model => model.id), ["ultimate", "giga"]);
  assert.equal(models[0].contextLength, 1000000);
  assert.equal(models[0].ownedBy, "Qoder · Ultimate");
  assert.equal(models[0].capabilities.streaming, true);
  assert.equal(requests[0].auth, "Bearer <pat>", "the personal access token goes straight to the business API");
  assert.equal(requests[0].path, "/api/v1/cloud/models");
});

test("Check connection performs a real authenticated request, not a simulation", async () => {
  const ok = await testProviderConnection({ baseUrl, apiKey: FAKE_QODER_API_KEY, providerType: "qoder_cloud_agents" });
  assert.equal(ok.listingSupported, true);
  assert.deepEqual(ok.availableModels.map(model => model.id), ["ultimate", "giga"]);

  await assert.rejects(
    () => testProviderConnection({ baseUrl, apiKey: "bad-key", providerType: "qoder_cloud_agents" }),
    error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /bad-key/);
      return true;
    }
  );
});

test("a turn opens the stream before sending the message and streams one reply", async () => {
  const response = await stream();
  const result = await collect(response);

  assert.equal(response.url, `${baseUrl}/sessions/sess_test/events/stream?event_deltas%5B%5D=agent.message`);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(result.text, "Hello world");
  assert.equal(result.terminalCount, 1);
  assert.equal(result.doneMarker, true);
  assert.doesNotMatch(result.text, /hidden reasoning/, "thinking deltas stay out of the answer");

  const order = requests.map(entry => `${entry.method} ${entry.path}`);
  const streamIndex = order.indexOf("GET /api/v1/cloud/sessions/sess_test/events/stream");
  const postIndex = order.indexOf("POST /api/v1/cloud/sessions/sess_test/events");
  assert.ok(streamIndex > -1 && postIndex > streamIndex, `stream must attach before the message: ${order.join(", ")}`);
  assert.equal(order.indexOf("POST /api/v1/cloud/sessions") < streamIndex, true);

  const streamRequest = requests.find(entry => entry.path.endsWith("/events/stream"));
  assert.equal(streamRequest.headers.accept, "text/event-stream");
  assert.match(streamRequest.search, /event_deltas%5B%5D=agent\.message|event_deltas\[\]=agent\.message/);

  const posted = requests.find(entry => entry.path.endsWith("/events") && entry.method === "POST");
  assert.equal(posted.body.events[0].type, "user.message");
  assert.deepEqual(posted.body.events[0].content, [{ type: "text", text: "[User]\nHello" }]);

  const session = requests.find(entry => entry.path === "/api/v1/cloud/sessions" && entry.method === "POST");
  assert.equal(session.body.agent, "agent_ultimate");
  assert.equal(session.body.environment_id, "env_test");
});

test("the buffered agent.message completes text missed by a late stream", async () => {
  fake.state.mode = "partial";
  const result = await collect(await stream());
  assert.equal(result.text, "Hello world");
  assert.equal(result.terminalCount, 1);
});

test("a turn without deltas still yields the buffered reply exactly once", async () => {
  fake.state.mode = "buffered";
  const result = await collect(await stream());
  assert.equal(result.text, "Hello world");
  assert.equal(result.terminalCount, 1);
});

test("heartbeat comments keep the stream alive without producing text", async () => {
  const result = await collect(await stream());
  assert.deepEqual(result.chunks[0], { choices: [{ delta: {} }] }, "the heartbeat frame forwards an empty chunk");
  assert.equal(result.text, "Hello world");
});

test("environments and agents are provisioned once per credential and model", async () => {
  const first = await chatCompletion({
    baseUrl,
    apiKey: FAKE_QODER_API_KEY,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }]
  });
  assert.equal(first.content, "Hello world");
  assert.equal(first.finishReason, "stop");

  fake.state.clearRequests();
  const second = await chatCompletion({
    baseUrl,
    apiKey: FAKE_QODER_API_KEY,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }]
  });
  assert.equal(second.content, "Hello world");
  assert.equal(requests.filter(entry => entry.path === "/api/v1/cloud/environments").length, 0, "environment id is cached");
  assert.equal(requests.filter(entry => entry.path === "/api/v1/cloud/agents").length, 0, "agent id is cached");

  fake.state.clearRequests();
  const other = await chatCompletion({
    baseUrl,
    apiKey: `${FAKE_QODER_API_KEY}-second`,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }]
  });
  assert.equal(other.content, "Hello world");
  assert.ok(requests.some(entry => entry.path === "/api/v1/cloud/environments"), "a different credential never reuses the first account's environment");
});

test("an unknown model is rejected by Qoder before a session is created", async () => {
  await assert.rejects(
    () =>
      chatCompletion({
        baseUrl,
        apiKey: `${FAKE_QODER_API_KEY}-unknown`,
        providerType: "qoder_cloud_agents",
        model: "not-a-model",
        messages: [{ role: "user", content: "Hello" }]
      }),
    error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 400);
      assert.equal(requests.some(entry => entry.path === "/api/v1/cloud/sessions" && entry.method === "POST"), false);
      return true;
    }
  );
});

test("a model saved under its display name is resolved to the id Qoder lists", async () => {
  fake.state.agents.length = 0;
  const result = await chatCompletion({
    baseUrl,
    apiKey: `${FAKE_QODER_API_KEY}-display-name`,
    providerType: "qoder_cloud_agents",
    model: "Ultimate",
    messages: [{ role: "user", content: "Hello" }]
  });
  assert.equal(result.content, FAKE_QODER_REPLY);
  const agent = requests.find(entry => entry.path === "/api/v1/cloud/agents" && entry.method === "POST");
  assert.ok(agent, "an agent is created for the resolved model");
  assert.equal(agent.body.model, "ultimate", "the account's real id is sent, not the display name");
});

test("an unlisted model name fails with the ids this account actually has", async () => {
  await assert.rejects(
    () =>
      chatCompletion({
        baseUrl,
        apiKey: `${FAKE_QODER_API_KEY}-unlisted`,
        providerType: "qoder_cloud_agents",
        model: "deepseek-flash",
        messages: [{ role: "user", content: "Hello" }]
      }),
    error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "invalid_model");
      assert.match(error.message, /does not list a model called "deepseek-flash"/);
      assert.match(error.message, /ultimate, giga/);
      assert.equal(error.message.includes("deepseek-flash"), true);
      assert.equal(requests.some(entry => entry.path === "/api/v1/cloud/agents" && entry.method === "POST"), false, "no agent is created for a model Qoder does not have");
      return true;
    }
  );
});

test("a disabled model cannot be selected even by its exact id", async () => {
  await assert.rejects(
    () =>
      chatCompletion({
        baseUrl,
        apiKey: `${FAKE_QODER_API_KEY}-disabled`,
        providerType: "qoder_cloud_agents",
        model: "retired",
        messages: [{ role: "user", content: "Hello" }]
      }),
    error => {
      assert.equal(error.code, "invalid_model");
      assert.match(error.message, /retired/);
      return true;
    }
  );
});

test("when the model list is unreachable the saved id is sent through unchanged", async () => {
  fake.state.agents.length = 0;
  fake.state.modelsStatus = 503;
  const result = await chatCompletion({
    baseUrl,
    apiKey: `${FAKE_QODER_API_KEY}-list-down`,
    providerType: "qoder_cloud_agents",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }]
  });
  assert.equal(result.content, FAKE_QODER_REPLY);
  assert.ok(requests.some(entry => entry.path === "/api/v1/cloud/models" && entry.method === "GET"), "the list is attempted first");
  const agent = requests.find(entry => entry.path === "/api/v1/cloud/agents" && entry.method === "POST");
  assert.equal(agent.body.model, MODEL, "the outage never blocks a valid id");
});

test("history is flattened into labelled text blocks with Qoder image sources", () => {
  const blocks = qoderEventContent([
    { role: "system", content: "Be brief." },
    { role: "user", content: "First" },
    { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
    { role: "user", content: "Look at this", images: [{ mimeType: "image/png", data: "AAAA" }, { url: "https://example.com/a.png" }] }
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "[System]\nBe brief." },
    { type: "text", text: "[User]\nFirst" },
    { type: "text", text: "[Assistant]\nEarlier answer" },
    { type: "text", text: "[User]\nLook at this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", source: { type: "url", url: "https://example.com/a.png" } }
  ]);
});
