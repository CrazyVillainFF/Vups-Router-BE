import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  ProviderError,
  buildChatRequestBody,
  buildProviderFailureLog,
  chatCompletion,
  describeProviderError,
  extractResponseText,
  extractStreamText,
  isOpenCodeZenBase,
  isOpenCodeZenFreeModel,
  listProviderModels,
  normalizeBaseUrl,
  resolveChatEndpoint,
  startChatCompletionStream,
  testProviderConnection,
  testProviderModel
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

test("OpenCode Zen resolves each documented model family to its endpoint", () => {
  const baseUrl = "https://opencode.ai/inference/openai/v1";
  assert.equal(resolveChatEndpoint(baseUrl, "deepseek-v4.1-flash"), "https://opencode.ai/inference/openai/v1/chat/completions");
  assert.equal(resolveChatEndpoint(baseUrl, "kimi-k3"), "https://opencode.ai/inference/openai/v1/chat/completions");
  assert.equal(resolveChatEndpoint(baseUrl, "qwen3.8-max"), "https://opencode.ai/inference/openai/v1/chat/completions");
  assert.equal(resolveChatEndpoint(baseUrl, "gpt-6-sol"), "https://opencode.ai/inference/openai/v1/responses");
  assert.equal(resolveChatEndpoint(baseUrl, "grok-4.7"), "https://opencode.ai/inference/openai/v1/responses");
  assert.equal(resolveChatEndpoint(baseUrl, "muse-spark-1.3"), "https://opencode.ai/inference/openai/v1/responses");
  assert.equal(resolveChatEndpoint(baseUrl, "claude-sonnet-4-6"), "https://opencode.ai/inference/anthropic/v1/messages");
  assert.equal(resolveChatEndpoint(baseUrl, "qwen3.8-flash"), "https://opencode.ai/inference/anthropic/v1/messages");
  assert.throws(
    () => resolveChatEndpoint(baseUrl, "gemini-3.1-pro"),
    error => error instanceof ProviderError && error.code === "unsupported_protocol"
  );
  assert.equal(isOpenCodeZenBase(baseUrl), true);
  assert.equal(isOpenCodeZenBase("https://opencode.ai/inference/v1"), true);
  assert.equal(isOpenCodeZenBase("https://opencode.ai/inference/custom/conn_123"), false);
});

test("OpenCode Zen discovers models from the Zen catalog with Bearer auth", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return new Response(JSON.stringify({
      object: "list",
      data: [{ id: "deepseek-v4.1-flash" }, { id: "deepseek-v4.1-flash-free" }, { id: "claude-sonnet-4-6" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const models = await listProviderModels({
      baseUrl: "https://opencode.ai/inference/openai/v1",
      apiKey: "oc_sk_test_123456",
      providerType: "openai_compatible"
    });
    assert.deepEqual(models.map(entry => entry.id), ["deepseek-v4.1-flash", "deepseek-v4.1-flash-free", "claude-sonnet-4-6"]);
    assert.equal(models[0].free, false);
    assert.equal(models[1].free, true);
    assert.equal(models[1].restrictedProvider, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://opencode.ai/zen/v1/models");
    assert.equal(calls[0].headers.Authorization, "Bearer oc_sk_test_123456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode Zen free models are rejected before any upstream request", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(isOpenCodeZenFreeModel("deepseek-v4.1-flash-free"), true);
    assert.equal(isOpenCodeZenFreeModel("deepseek-v4.1-flash"), false);
    const baseUrl = "https://opencode.ai/inference/openai/v1";
    const apiKey = "oc_sk_test_123456";
    const messages = [{ role: "user", content: "Hello" }];

    for (const action of [
      () => chatCompletion({ baseUrl, apiKey, model: "deepseek-v4.1-flash-free", messages }),
      () => startChatCompletionStream({ baseUrl, apiKey, model: "deepseek-v4.1-flash-free", messages }),
      () => testProviderModel({ baseUrl, apiKey, model: "deepseek-v4.1-flash-free" })
    ]) {
      await assert.rejects(
        action,
        error => error instanceof ProviderError
          && error.code === "free_tier_client_only"
          && error.status === 403
          && /official OpenCode client/.test(error.message)
      );
    }
    assert.equal(called, false, "restricted models must never reach the provider");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider error details never echo a raw HTML error page", () => {
  const error = describeProviderError(503, "<!DOCTYPE html><html><body><h1>Bad gateway</h1><script>alert(1)</script></body></html>");
  assert.equal(error.code, "provider_unavailable");
  assert.equal(error.status, 503);
  assert.match(error.message, /HTML error page/);
  assert.doesNotMatch(error.message, /<html|<!DOCTYPE|script/i);
});

test("OpenCode Zen connection checks validate the key without inference", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push({ method: options.method });
    return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    await assert.rejects(
      () => testProviderConnection({
        baseUrl: "https://opencode.ai/inference/openai/v1",
        apiKey: "oc_sk_bad_key",
        providerType: "openai_compatible"
      }),
      error => error instanceof ProviderError && error.code === "invalid_api_key"
    );
    assert.deepEqual(calls, [{ method: "GET" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode Zen chat routes OpenAI, Responses, and Anthropic models with Bearer auth", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), headers: options.headers, body });
    if (String(url).endsWith("/messages")) {
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "claude ok" }],
        stop_reason: "end_turn"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).endsWith("/responses")) {
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: "gpt ok" }] }],
        status: "completed"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "chat ok" }, finish_reason: "stop" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const baseUrl = "https://opencode.ai/inference/openai/v1";
    const apiKey = "oc_sk_test_123456";
    const messages = [{ role: "user", content: "Hello" }];
    const chat = await chatCompletion({ baseUrl, apiKey, model: "deepseek-v4.1-flash", messages });
    const responses = await chatCompletion({ baseUrl, apiKey, model: "gpt-6-sol", messages });
    const anthropic = await chatCompletion({ baseUrl, apiKey, model: "claude-sonnet-4-6", messages });

    assert.equal(chat.content, "chat ok");
    assert.equal(responses.content, "gpt ok");
    assert.equal(anthropic.content, "claude ok");
    assert.deepEqual(calls.map(call => call.url), [
      "https://opencode.ai/inference/openai/v1/chat/completions",
      "https://opencode.ai/inference/openai/v1/responses",
      "https://opencode.ai/inference/anthropic/v1/messages"
    ]);
    assert.ok(calls.every(call => call.headers.Authorization === `Bearer ${apiKey}`));
    assert.equal(calls[2].headers["x-api-key"], undefined);
    assert.deepEqual(calls[1].body.input, [{ role: "user", content: "Hello" }]);
    assert.equal(calls[2].body.max_tokens, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode Zen streams Anthropic models through the Messages endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      ""
    ].join("\n\n");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const upstream = await startChatCompletionStream({
      baseUrl: "https://opencode.ai/inference/openai/v1",
      apiKey: "oc_sk_test_123456",
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello" }]
    });
    assert.equal(await upstream.text(), 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    assert.equal(calls[0].url, "https://opencode.ai/inference/anthropic/v1/messages");
    assert.equal(calls[0].headers.Authorization, "Bearer oc_sk_test_123456");
    assert.equal(calls[0].body.stream, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode Zen rejects native-only model families before sending a request", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await assert.rejects(
      () => chatCompletion({
        baseUrl: "https://opencode.ai/inference/openai/v1",
        apiKey: "oc_sk_test_123456",
        model: "gemini-3.1-pro",
        messages: [{ role: "user", content: "Hello" }]
      }),
      error => error instanceof ProviderError
        && error.code === "unsupported_protocol"
        && /native API/.test(error.message)
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider failure diagnostics include only safe request context and a truncated body", () => {
  const payload = `Gateway challenge ${"x".repeat(2200)} sk-live-secret-123456 oc_sk_opencode-secret-123456 Bearer abc.def.secret`;
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
  assert.ok(!log.includes("oc_sk_opencode-secret-123456"));
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
