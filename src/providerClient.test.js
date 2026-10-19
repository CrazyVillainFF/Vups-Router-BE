import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  ProviderError,
  buildChatRequestBody,
  buildProviderFailureLog,
  chatCompletion,
  extractResponseText,
  extractStreamText,
  normalizeBaseUrl,
  resolveChatEndpoint,
  startChatCompletionStream
} from "./providerClient.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test("normalizes AgentRouter base URLs without duplicating /v1", () => {
  assert.equal(normalizeBaseUrl("https://agentrouter.org"), "https://agentrouter.org/v1");
  assert.equal(normalizeBaseUrl("https://agentrouter.org/"), "https://agentrouter.org/v1");
  assert.equal(normalizeBaseUrl("https://agentrouter.org/v1/"), "https://agentrouter.org/v1");
  assert.equal(normalizeBaseUrl("https://agentrouter.org/v1/chat/completions"), "https://agentrouter.org/v1");
  assert.equal(normalizeBaseUrl("https://agentrouter.org/v1/chat/completions/"), "https://agentrouter.org/v1");
  assert.equal(normalizeBaseUrl("https://agentrouter.org/v1/responses/"), "https://agentrouter.org/v1");
  assert.equal(normalizeBaseUrl("https://agentrouter.org/v1/v1"), "https://agentrouter.org/v1");
});

test("keeps other provider base URLs unchanged", () => {
  assert.equal(normalizeBaseUrl("https://api.deepseek.com/"), "https://api.deepseek.com");
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/chat/completions/"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1");
});

test("AgentRouter GPT models resolve to /responses and other models keep /chat/completions", () => {
  assert.equal(resolveChatEndpoint("https://agentrouter.org/v1", "gpt-5.6-sol"), "https://agentrouter.org/v1/responses");
  assert.equal(resolveChatEndpoint("https://agentrouter.org/v1/", "gpt-5.6-sol"), "https://agentrouter.org/v1/responses");
  assert.equal(resolveChatEndpoint("https://agentrouter.org/v1/chat/completions", "gpt-5.6-sol"), "https://agentrouter.org/v1/responses");
  assert.equal(resolveChatEndpoint("https://agentrouter.org/v1/responses", "gpt-5.6-sol"), "https://agentrouter.org/v1/responses");
  assert.equal(resolveChatEndpoint("https://agentrouter.org/v1", "deepseek-v4-flash"), "https://agentrouter.org/v1/chat/completions");
  assert.equal(resolveChatEndpoint("https://api.openai.com/v1", "gpt-5.6-sol"), "https://api.openai.com/v1/chat/completions");
});

test("builds a Responses payload with the exact model ID and stream flag", () => {
  const body = buildChatRequestBody({
    model: "gpt-5.6-sol",
    messages: [
      { role: "system", content: "System guidance." },
      { role: "user", content: "Hello" }
    ],
    temperature: 0.7,
    maxTokens: 128,
    stream: true,
    responses: true
  });
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "System guidance.");
  assert.deepEqual(body.input, [{ role: "user", content: "Hello" }]);
  assert.equal(body.max_output_tokens, 128);
  assert.equal(body.messages, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.temperature, undefined);
});

test("keeps the existing chat-completions payload shape", () => {
  const body = buildChatRequestBody({
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "Hello" }],
    temperature: 0.4,
    maxTokens: 128,
    stream: false
  });
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
  assert.equal(body.temperature, 0.4);
  assert.equal(body.max_tokens, 128);
  assert.equal(body.input, undefined);
  assert.equal(body.max_output_tokens, undefined);
});

test("sends POST to /v1/chat/completions for streaming and non-streaming requests", async () => {
  const requests = [];
  const { server, port } = await listen(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    requests.push({ method: req.method, url: req.url, body });
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"streamed"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "complete" }, finish_reason: "stop" }] }));
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}/v1/`;
    const completion = await chatCompletion({
      baseUrl,
      apiKey: "sk-test-provider-key",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }]
    });
    const upstream = await startChatCompletionStream({
      baseUrl,
      apiKey: "sk-test-provider-key",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }]
    });
    const streamed = await upstream.text();

    assert.equal(completion.content, "complete");
    assert.match(streamed, /streamed/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[1].url, "/v1/chat/completions");
    assert.equal(requests[0].body.model, "gpt-5.6-sol");
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[1].body.stream, true);
  } finally {
    await close(server);
  }
});

test("AgentRouter GPT requests are POSTed to /v1/responses for both modes", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), method: options.method, body });
    if (body.stream) {
      const sse = [
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}',
        ""
      ].join("\n\n");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: "ok" }] }],
      status: "completed"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const completion = await chatCompletion({
      baseUrl: "https://agentrouter.org/v1/",
      apiKey: "sk-test-key-123456",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }]
    });
    const upstream = await startChatCompletionStream({
      baseUrl: "https://agentrouter.org/",
      apiKey: "sk-test-key-123456",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }]
    });
    const streamed = await upstream.text();

    assert.equal(completion.content, "ok");
    assert.equal(completion.finishReason, "stop");
    assert.match(streamed, /response\.output_text\.delta/);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.url), [
      "https://agentrouter.org/v1/responses",
      "https://agentrouter.org/v1/responses"
    ]);
    assert.ok(calls.every(call => call.method === "POST"));
    assert.equal(calls[0].body.stream, false);
    assert.equal(calls[1].body.stream, true);
    assert.equal(calls[0].body.model, "gpt-5.6-sol");
    assert.equal(calls[1].body.model, "gpt-5.6-sol");
    assert.equal(calls[0].body.input[0].content, "Hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider failure diagnostics include only safe request context and a truncated body", () => {
  const payload = `Gateway challenge ${"x".repeat(2200)} sk-live-secret-123456 Bearer abc.def.secret`;
  const log = buildProviderFailureLog({
    url: "https://agentrouter.org/v1/responses?key=sk-query-secret-123456",
    method: "POST",
    status: 405,
    contentType: "text/html; charset=utf-8",
    payload
  });
  assert.match(log, /^Provider request failed: POST https:\/\/agentrouter\.org\/v1\/responses -> HTTP 405; content-type=text\/html; charset=utf-8; body=/);
  assert.ok(!log.includes("?key="), "query strings must not be logged");
  assert.ok(!log.includes("sk-live-secret-123456"));
  assert.ok(!log.includes("sk-query-secret-123456"));
  assert.ok(!log.includes("abc.def.secret"));
  const loggedBody = log.slice(log.indexOf("body=") + 5);
  assert.ok(loggedBody.length <= 2000, "upstream bodies must be truncated to 2000 characters");
});

test("provider failure diagnostics serialize JSON and redact credential fields", () => {
  const log = buildProviderFailureLog({
    url: "https://agentrouter.org/v1/chat/completions",
    status: 401,
    contentType: "application/json; charset=utf-8",
    payload: { error: { message: "denied" }, apiKey: "secret-value", token: "another-secret" }
  });
  assert.match(log, /body=\{"error":\{"message":"denied"\},"apiKey":"\[redacted\]","token":"\[redacted\]"\}/);
  assert.ok(!log.includes("secret-value"));
  assert.ok(!log.includes("another-secret"));
});

test("propagates HTTP 405 with safe diagnostics for both request modes", async () => {
  const requests = [];
  const { server, port } = await listen(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    await readBody(req);
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: "GPT models must use /v1/responses. Key sk-test-secret-123456 was rejected. Authorization Bearer abc.def.secret"
      }
    }));
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const run = () => chatCompletion({
      baseUrl,
      apiKey: "sk-test-secret-123456",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }]
    });
    const runStream = () => startChatCompletionStream({
      baseUrl,
      apiKey: "sk-test-secret-123456",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }]
    });

    for (const request of [run, runStream]) {
      await assert.rejects(request, error => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.status, 405);
        assert.equal(error.code, "method_not_allowed");
        assert.match(error.message, /HTTP 405/);
        assert.match(error.message, /GPT models must use \/v1\/responses/);
        assert.ok(!error.message.includes("sk-test-secret-123456"));
        assert.ok(!error.message.includes("abc.def.secret"));
        return true;
      });
    }
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.method === "POST"));
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
      assert.match(warning, /POST http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions -> HTTP 405/);
      assert.match(warning, /content-type=application\/json/);
      assert.match(warning, /GPT models must use \/v1\/responses/);
      assert.ok(!warning.includes("sk-test-secret-123456"));
      assert.ok(!warning.includes("abc.def.secret"));
      assert.match(warning, /Bearer \[redacted\]/);
    }
  } finally {
    console.warn = originalWarn;
    await close(server);
  }
});

test("parses streaming deltas from both API shapes", () => {
  assert.equal(extractStreamText({ choices: [{ delta: { content: "chat" } }] }), "chat");
  assert.equal(extractStreamText({ type: "response.output_text.delta", delta: "responses" }), "responses");
  assert.equal(extractStreamText({ type: "response.completed", response: { status: "completed" } }), "");
});

test("extracts non-streaming text from both API shapes", () => {
  assert.equal(extractResponseText({ output_text: "direct" }), "direct");
  assert.equal(extractResponseText({
    output: [{ content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] }]
  }), "ab");
  assert.equal(extractResponseText({ choices: [{ message: { content: "chat" } }] }), "chat");
});
