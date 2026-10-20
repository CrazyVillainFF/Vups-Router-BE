import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import {
  buildAnthropicRequestBody,
  chatCompletion,
  isBedrockHost,
  listProviderModels,
  ProviderError,
  resolveChatEndpoint,
  startChatCompletionStream,
  testProviderConnection,
  testProviderModel
} from "./providerClient.js";

const API_KEY = "sk-ant-adapter-test-123456";
const AZURE_KEY = "azure-adapter-test-key";
const WATSONX_KEY = "ibm-cloud-adapter-test-key";
const MODEL = "claude-test-1";
const requests = [];
let server;
let baseUrl;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const rawBody = req.method === "POST" ? await readBody(req) : "";
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = rawBody;
    }
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (req.headers["x-api-key"] === "listing-unsupported") return json(res, 405, { error: { message: "Not supported" } });
      if (req.headers["x-api-key"] === "cross-origin-redirect") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      }
      if (req.headers["x-api-key"] === "same-origin-redirect" && !url.searchParams.has("final")) {
        res.writeHead(302, { Location: "/v1/models?final=1" });
        res.end();
        return;
      }
      if (![API_KEY, "same-origin-redirect"].includes(req.headers["x-api-key"])) {
        return json(res, 401, { error: { message: "Invalid API key" } });
      }
      return json(res, 200, { data: [{ id: MODEL, display_name: "Claude Test" }] });
    }

    if (url.pathname === "/openai/v1/models" && req.method === "GET") {
      if (req.headers["api-key"] !== AZURE_KEY) return json(res, 401, { error: { message: "Invalid API key" } });
      return json(res, 200, { data: [{ id: MODEL }] });
    }

    if (url.pathname === "/openai/v1/chat/completions" && req.method === "POST") {
      if (req.headers["api-key"] !== AZURE_KEY) return json(res, 401, { error: { message: "Invalid API key" } });
      return json(res, 200, {
        choices: [{ message: { role: "assistant", content: "Hello from Azure" }, finish_reason: "stop" }]
      });
    }

    if (url.pathname === "/identity/token" && req.method === "POST") {
      const form = new URLSearchParams(body ?? "");
      if (!form.get("apikey")) return json(res, 400, { error: "missing apikey" });
      return json(res, 200, { access_token: "iam-test-token", expires_in: 3600 });
    }

    if (url.pathname === "/ml/v1/foundation_model_specs" && req.method === "GET") {
      if (req.headers.authorization !== "Bearer iam-test-token") return json(res, 401, { error: { message: "Invalid token" } });
      return json(res, 200, { resources: [{ model_id: MODEL, provider: "IBM" }] });
    }

    if (url.pathname === "/ml/v1/text/chat" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer iam-test-token") return json(res, 401, { error: { message: "Invalid token" } });
      if (!body?.project_id) return json(res, 400, { error: { message: "project_id is required" } });
      return json(res, 200, {
        choices: [{ message: { role: "assistant", content: "Hello from watsonx" }, finish_reason: "stop" }]
      });
    }

    if (url.pathname === "/ml/v1/text/chat_stream" && req.method === "POST") {
      if (req.headers.authorization !== "Bearer iam-test-token") return json(res, 401, { error: { message: "Invalid token" } });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "watsonx" }, finish_reason: "stop" }] })}\n\n`);
      res.end();
      return;
    }

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      if (req.headers["x-api-key"] !== API_KEY) return json(res, 401, { error: { message: "Invalid API key" } });
      if (body?.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Claude" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();
        return;
      }
      return json(res, 200, {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello from Claude" }],
        stop_reason: "end_turn"
      });
    }

    return json(res, 404, { error: { message: "No adapter route" } });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
});

test("Anthropic endpoint resolution adds the documented version path", () => {
  assert.equal(resolveChatEndpoint("https://api.anthropic.com", MODEL, "anthropic_compatible"), "https://api.anthropic.com/v1/messages");
  assert.equal(resolveChatEndpoint("https://proxy.example/anthropic", MODEL, "anthropic_compatible"), "https://proxy.example/anthropic/v1/messages");
  assert.equal(resolveChatEndpoint("https://api.openai.com/v1", MODEL, "openai_responses"), "https://api.openai.com/v1/responses");
});

test("Anthropic model listing uses x-api-key and the Messages protocol", async () => {
  requests.length = 0;
  const result = await testProviderConnection({
    baseUrl,
    apiKey: API_KEY,
    providerType: "anthropic_compatible"
  });
  assert.deepEqual(result.availableModels.map(entry => entry.id), [MODEL]);
  assert.equal(result.modelChecked, false);
  assert.equal(result.listingSupported, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/v1/models");
  assert.equal(requests[0].headers["x-api-key"], API_KEY);
  assert.equal(requests[0].headers.authorization, undefined);
});

test("redirects are followed only within the same origin", async () => {
  const redirected = await listProviderModels({
    baseUrl,
    apiKey: "same-origin-redirect",
    providerType: "anthropic_compatible"
  });
  assert.deepEqual(redirected.map(entry => entry.id), [MODEL]);

  await assert.rejects(
    () => listProviderModels({ baseUrl, apiKey: "cross-origin-redirect", providerType: "anthropic_compatible" }),
    error => error instanceof ProviderError && error.code === "unsafe_redirect"
  );
});

test("connection checks stay zero-inference when model listing is unsupported", async () => {
  requests.length = 0;
  const result = await testProviderConnection({
    baseUrl,
    apiKey: API_KEY,
    providerType: "anthropic_compatible"
  });
  assert.equal(result.modelChecked, false);
  assert.equal(requests.every(entry => entry.method === "GET"), true);

  const unsupported = await testProviderConnection({
    baseUrl,
    apiKey: "listing-unsupported",
    providerType: "anthropic_compatible"
  });
  assert.equal(unsupported.listingSupported, false);
  assert.equal(unsupported.modelChecked, false);
  assert.equal(requests.filter(entry => entry.method === "POST").length, 0);
});

test("Anthropic chat sends the native body and extracts text", async () => {
  requests.length = 0;
  const result = await chatCompletion({
    baseUrl,
    apiKey: API_KEY,
    providerType: "anthropic_compatible",
    model: MODEL,
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" }
    ],
    maxTokens: 80
  });
  assert.equal(result.content, "Hello from Claude");
  assert.equal(result.finishReason, "stop");
  assert.equal(requests[0].path, "/v1/messages");
  assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(requests[0].body.system, "Be concise.");
  assert.equal(requests[0].body.max_tokens, 80);
  assert.deepEqual(requests[0].body.messages, [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
});

test("Anthropic image parts use base64 sources", () => {
  const body = buildAnthropicRequestBody({
    model: MODEL,
    stream: false,
    messages: [{
      role: "user",
      content: "Describe this",
      images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }]
    }]
  });
  assert.deepEqual(body.messages[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" }
  });
  assert.equal(body.max_tokens, 4096);
});

test("Anthropic streaming surfaces text deltas and finish reason", async () => {
  const upstream = await startChatCompletionStream({
    baseUrl,
    apiKey: API_KEY,
    providerType: "anthropic_compatible",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }]
  });
  const text = await upstream.text();
  assert.match(text, /content_block_delta/);
  assert.match(text, /message_delta/);
  assert.match(text, /end_turn/);
});

test("explicit model tests are the only path that runs inference", async () => {
  requests.length = 0;
  const result = await testProviderModel({
    baseUrl,
    apiKey: API_KEY,
    providerType: "anthropic_compatible",
    model: MODEL
  });
  assert.equal(result.modelChecked, true);
  assert.equal(result.sample, "Hello from Claude");
  assert.equal(requests.filter(entry => entry.path === "/v1/messages" && entry.method === "POST").length, 1);
});

test("Azure OpenAI uses the api-key header instead of Bearer", async () => {
  requests.length = 0;
  const azureBase = `${baseUrl}/openai/v1`;
  const models = await listProviderModels({ baseUrl: azureBase, apiKey: AZURE_KEY, providerType: "azure_openai" });
  assert.deepEqual(models.map(entry => entry.id), [MODEL]);
  assert.equal(requests[0].path, "/openai/v1/models");
  assert.equal(requests[0].headers["api-key"], AZURE_KEY);
  assert.equal(requests[0].headers.authorization, undefined);

  const result = await chatCompletion({
    baseUrl: azureBase,
    apiKey: AZURE_KEY,
    providerType: "azure_openai",
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }]
  });
  assert.equal(result.content, "Hello from Azure");
  const chat = requests.find(entry => entry.path === "/openai/v1/chat/completions");
  assert.equal(chat.headers["api-key"], AZURE_KEY);
  assert.equal(chat.headers.authorization, undefined);
  assert.equal(chat.body.model, MODEL);
});

test("watsonx resolves its versioned endpoint and requires a project ID", async () => {
  assert.equal(
    resolveChatEndpoint("https://us-south.ml.cloud.ibm.com", MODEL, "watsonx"),
    "https://us-south.ml.cloud.ibm.com/ml/v1/text/chat?version=2024-10-08"
  );
  assert.equal(
    resolveChatEndpoint("https://us-south.ml.cloud.ibm.com/ml/v1/text/chat?project_id=x", MODEL, "watsonx", { stream: true }),
    "https://us-south.ml.cloud.ibm.com/ml/v1/text/chat_stream?version=2024-10-08"
  );
  await assert.rejects(
    () => chatCompletion({ baseUrl, apiKey: WATSONX_KEY, providerType: "watsonx", model: MODEL, messages: [{ role: "user", content: "Hi" }] }),
    error => error instanceof ProviderError && error.code === "missing_project_id"
  );
});

test("watsonx exchanges the API key for a cached IAM token and lists models zero-inference", async () => {
  const previous = process.env.WATSONX_IAM_URL;
  process.env.WATSONX_IAM_URL = `${baseUrl}/identity/token`;
  try {
    requests.length = 0;
    const watsonxBase = `${baseUrl}?project_id=proj-123`;
    const connection = await testProviderConnection({ baseUrl: watsonxBase, apiKey: WATSONX_KEY, providerType: "watsonx" });
    assert.deepEqual(connection.availableModels.map(entry => entry.id), [MODEL]);
    assert.equal(connection.listingSupported, true);
    assert.equal(connection.modelChecked, false);
    assert.ok(requests.some(entry => entry.path === "/identity/token" && entry.method === "POST"));
    assert.ok(requests.some(entry => entry.path === "/ml/v1/foundation_model_specs" && entry.method === "GET"));
    assert.equal(requests.filter(entry => entry.method === "POST" && entry.path.startsWith("/ml/v1/text/chat")).length, 0);

    const result = await chatCompletion({
      baseUrl: watsonxBase,
      apiKey: WATSONX_KEY,
      providerType: "watsonx",
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }],
      maxTokens: 64
    });
    assert.equal(result.content, "Hello from watsonx");
    assert.equal(result.finishReason, "stop");
    const chat = requests.find(entry => entry.path === "/ml/v1/text/chat");
    assert.equal(chat.headers.authorization, "Bearer iam-test-token");
    assert.equal(chat.body.model_id, MODEL);
    assert.equal(chat.body.project_id, "proj-123");
    assert.equal(chat.body.max_tokens, 64);
    // The IAM token is cached: no second exchange for the follow-up request.
    assert.equal(requests.filter(entry => entry.path === "/identity/token").length, 1);

    const upstream = await startChatCompletionStream({
      baseUrl: watsonxBase,
      apiKey: WATSONX_KEY,
      providerType: "watsonx",
      model: MODEL,
      messages: [{ role: "user", content: "Hello" }]
    });
    const text = await upstream.text();
    assert.match(text, /Hello /);
    assert.match(text, /watsonx/);
    assert.equal(requests.filter(entry => entry.path === "/identity/token").length, 1);
  } finally {
    if (previous === undefined) delete process.env.WATSONX_IAM_URL;
    else process.env.WATSONX_IAM_URL = previous;
  }
});

test("Bedrock hosts are recognized so listing fallbacks stay honest", () => {
  assert.equal(isBedrockHost("bedrock-runtime.us-east-1.amazonaws.com"), true);
  assert.equal(isBedrockHost("bedrock-mantle.eu-west-1.api.aws"), true);
  assert.equal(isBedrockHost("bedrock-runtime.evil.example.com"), false);
  assert.equal(isBedrockHost("api.openai.com"), false);
});
