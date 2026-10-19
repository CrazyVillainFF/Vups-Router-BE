import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkOmniRoute,
  normalizeOmniRouteBaseUrl,
  normalizeOmniRouteModels,
  omnirouteConfiguration,
  omnirouteEndpoint,
  omnirouteModelRows,
  omnirouteStatusError,
  publicOmniRouteStatus,
  resetOmniRouteCache,
  resolveOmniRouteChat
} from "./omniroute.js";
import { ProviderError, startChatCompletionStream } from "./providerClient.js";
import { FAKE_OMNIROUTE_KEY, startFakeOmniRoute } from "./testUtils/fakeOmniRoute.js";

const fake = await startFakeOmniRoute();

const originalEnv = {
  OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
  OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
  OMNIROUTE_ENABLED: process.env.OMNIROUTE_ENABLED
};

function setOmniRoute({ baseUrl, apiKey, enabled } = {}) {
  if (baseUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
  else process.env.OMNIROUTE_BASE_URL = baseUrl;
  if (apiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = apiKey;
  if (enabled === undefined) delete process.env.OMNIROUTE_ENABLED;
  else process.env.OMNIROUTE_ENABLED = enabled;
  resetOmniRouteCache();
}

afterEach(() => {
  setOmniRoute({});
});

after(async () => {
  if (originalEnv.OMNIROUTE_BASE_URL === undefined) delete process.env.OMNIROUTE_BASE_URL;
  else process.env.OMNIROUTE_BASE_URL = originalEnv.OMNIROUTE_BASE_URL;
  if (originalEnv.OMNIROUTE_API_KEY === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = originalEnv.OMNIROUTE_API_KEY;
  if (originalEnv.OMNIROUTE_ENABLED === undefined) delete process.env.OMNIROUTE_ENABLED;
  else process.env.OMNIROUTE_ENABLED = originalEnv.OMNIROUTE_ENABLED;
  resetOmniRouteCache();
  await fake.close();
});

test("OmniRoute base URLs normalize to a single protocol root and never duplicate /v1", () => {
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128/"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128/v1"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128/v1/"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128/v1/chat/completions"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128/v1/responses"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128/v1/models"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("http://localhost:20128/v1/v1"), "http://localhost:20128");
  assert.equal(normalizeOmniRouteBaseUrl("https://gateway.example.com/omniroute/v1/models"), "https://gateway.example.com/omniroute");
  assert.equal(normalizeOmniRouteBaseUrl("https://gateway.example.com/omniroute/v2"), "https://gateway.example.com/omniroute");
});

test("invalid OmniRoute base URLs are rejected with a clear code", () => {
  for (const value of ["", "not a url", "ftp://host", "http://user:pass@host", "http://host/v1?token=1", "http://host/v1#frag"]) {
    assert.throws(
      () => normalizeOmniRouteBaseUrl(value),
      (error) => error instanceof ProviderError && error.code === "invalid_base_url",
      `expected invalid_base_url for ${value}`
    );
  }
});

test("configuration stays optional and defaults to enabled only when credentials exist", () => {
  setOmniRoute({});
  assert.deepEqual(
    { status: omnirouteConfiguration().status, enabled: omnirouteConfiguration().enabled, configured: omnirouteConfiguration().configured },
    { status: "disabled", enabled: false, configured: false }
  );

  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });
  assert.equal(omnirouteConfiguration().status, "ready");
  assert.equal(omnirouteConfiguration().enabled, true);

  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY, enabled: "false" });
  assert.equal(omnirouteConfiguration().status, "disabled");
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY, enabled: "0" });
  assert.equal(omnirouteConfiguration().status, "disabled");

  setOmniRoute({ baseUrl: fake.baseUrl, enabled: "true" });
  assert.equal(omnirouteConfiguration().status, "not_configured");
  setOmniRoute({ baseUrl: "ftp://bad", apiKey: FAKE_OMNIROUTE_KEY, enabled: "true" });
  assert.equal(omnirouteConfiguration().status, "invalid_config");
});

test("endpoint construction appends exactly one /v1 path segment", () => {
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });
  assert.equal(omnirouteEndpoint("/chat/completions"), `${fake.baseUrl}/v1/chat/completions`);
  assert.equal(omnirouteEndpoint("/models"), `${fake.baseUrl}/v1/models`);
  setOmniRoute({ baseUrl: `${fake.baseUrl}/v1`, apiKey: FAKE_OMNIROUTE_KEY });
  assert.equal(omnirouteEndpoint("/chat/completions"), `${fake.baseUrl}/v1/chat/completions`);
  setOmniRoute({ baseUrl: "https://gateway.example.com/gw/v1/models", apiKey: FAKE_OMNIROUTE_KEY });
  assert.equal(omnirouteEndpoint("/models"), "https://gateway.example.com/gw/v1/models");
  setOmniRoute({});
  assert.equal(omnirouteEndpoint("/models"), null);
});

test("model lists are normalized, deduplicated, and bounded", () => {
  const models = normalizeOmniRouteModels([
    { id: "openai/gpt-5.2" },
    { id: "openai/gpt-5.2" },
    { id: "  " },
    { name: "anthropic/claude-sonnet-4-6" },
    { id: "vision/model", architecture: { input_modalities: ["text", "image"] } },
    { id: "text/model", architecture: { input_modalities: ["text"] } },
    { id: "x".repeat(201) }
  ]);
  assert.deepEqual(models.map(model => model.id), [
    "openai/gpt-5.2",
    "anthropic/claude-sonnet-4-6",
    "vision/model",
    "text/model"
  ]);
  assert.equal(models[0].name, "openai/gpt-5.2");
  assert.equal(models[2].vision, true);
  assert.equal(models[3].vision, false);

  const many = normalizeOmniRouteModels(Array.from({ length: 620 }, (_, index) => ({ id: `model-${index}` })));
  assert.equal(many.length, 500);
});

test("model discovery uses the bearer key, caches results, and can force a refresh", async () => {
  fake.reset();
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });

  const first = await checkOmniRoute();
  assert.equal(first.status, "available");
  assert.equal(first.available, true);
  assert.deepEqual(first.models.map(model => model.id), fake.state.models);
  assert.equal(fake.state.modelsRequests, 1);

  const cached = await checkOmniRoute();
  assert.equal(cached.status, "available");
  assert.equal(fake.state.modelsRequests, 1, "a cached result must not re-query OmniRoute");

  const refreshed = await checkOmniRoute({ force: true });
  assert.equal(refreshed.status, "available");
  assert.equal(fake.state.modelsRequests, 2);
});

test("model discovery reports disabled, unauthorized, empty, unreachable, and timeout states", async () => {
  setOmniRoute({});
  assert.equal((await checkOmniRoute()).status, "disabled");

  fake.reset();
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: "sk-wrong-key" });
  assert.equal((await checkOmniRoute()).status, "unauthorized");

  fake.reset();
  fake.state.behavior.emptyModels = true;
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });
  assert.equal((await checkOmniRoute()).status, "empty");

  fake.reset();
  setOmniRoute({ baseUrl: "http://127.0.0.1:1", apiKey: FAKE_OMNIROUTE_KEY });
  assert.equal((await checkOmniRoute()).status, "unreachable");

  fake.reset();
  fake.state.behavior.delayMs = 500;
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });
  assert.equal((await checkOmniRoute({ timeoutMs: 150 })).status, "timeout");
  fake.reset();
});

test("public status and model rows never expose the server key or base URL", async () => {
  fake.reset();
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });
  const status = await checkOmniRoute();
  const publicStatus = publicOmniRouteStatus(status);
  assert.deepEqual(publicStatus, {
    provider: "OmniRoute",
    enabled: true,
    configured: true,
    available: true,
    status: "available",
    modelCount: fake.state.models.length
  });
  const serialized = JSON.stringify(publicStatus);
  assert.ok(!serialized.includes(FAKE_OMNIROUTE_KEY));
  assert.ok(!serialized.includes(fake.baseUrl));
  assert.ok(!/OMNIROUTE_API_KEY/i.test(serialized));

  const rows = omnirouteModelRows(status);
  assert.equal(rows.length, fake.state.models.length);
  assert.deepEqual(rows.map(row => row.id), fake.state.models);
  assert.ok(rows.every(row => row.gateway === true && row.shared === false && row.source === "omniroute"));
  assert.ok(!JSON.stringify(rows).includes(FAKE_OMNIROUTE_KEY));
});

test("gateway chat resolution validates the exact model and returns safe provider settings", async () => {
  fake.reset();
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });

  const provider = await resolveOmniRouteChat("openai/gpt-5.2");
  assert.equal(provider.gateway, true);
  assert.equal(provider.provider, "OmniRoute");
  assert.equal(provider.baseUrl, `${fake.baseUrl}/v1`);
  assert.equal(provider.apiKey, FAKE_OMNIROUTE_KEY);
  assert.equal(provider.defaultModel, "openai/gpt-5.2");

  const fallback = await resolveOmniRouteChat("");
  assert.equal(fallback.defaultModel, fake.state.models[0]);

  await assert.rejects(
    () => resolveOmniRouteChat("not/a-model"),
    (error) => error instanceof ProviderError && error.code === "invalid_model" && !error.message.includes(FAKE_OMNIROUTE_KEY)
  );
  assert.equal(fake.state.chatRequests.length, 0, "invalid models must never reach the gateway");
});

test("status errors are distinct, sanitized, and actionable", () => {
  const cases = [
    ["disabled", "omniroute_disabled"],
    ["not_configured", "omniroute_not_configured"],
    ["invalid_config", "omniroute_invalid_config"],
    ["unauthorized", "omniroute_auth_failed"],
    ["rate_limited", "omniroute_rate_limited"],
    ["timeout", "omniroute_timeout"],
    ["not_found", "omniroute_unavailable"],
    ["empty", "omniroute_no_models"],
    ["unreachable", "omniroute_unreachable"]
  ];
  for (const [status, code] of cases) {
    const error = omnirouteStatusError({ status });
    assert.equal(error.code, code);
    assert.ok(error.status >= 400 && error.status <= 504);
    assert.ok(!error.message.includes(FAKE_OMNIROUTE_KEY));
  }
});

test("client cancellation aborts an in-flight OmniRoute request cleanly", async () => {
  fake.reset();
  fake.state.behavior.delayMs = 400;
  setOmniRoute({ baseUrl: fake.baseUrl, apiKey: FAKE_OMNIROUTE_KEY });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    () => startChatCompletionStream(
      {
        baseUrl: `${fake.baseUrl}/v1`,
        apiKey: FAKE_OMNIROUTE_KEY,
        model: fake.state.models[0],
        messages: [{ role: "user", content: "hello" }]
      },
      controller.signal
    ),
    (error) => error instanceof ProviderError && error.code === "cancelled"
  );
  fake.reset();
});
