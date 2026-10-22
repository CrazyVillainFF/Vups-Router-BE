import assert from "node:assert/strict";
import http from "node:http";
import { after, beforeEach, test } from "node:test";

const { checkOpenRouter, checkOpenRouterKey, openRouterModelIsChat, openRouterModelIsFree, resetOpenRouterCache } = await import("./openrouter.js");

const FREE_ALPHA = {
  id: "free/alpha:free",
  name: "Free Alpha",
  pricing: { prompt: "0", completion: "0", request: "0" },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"], modality: "text+image->text" },
  supported_parameters: ["tools", "reasoning"],
  context_length: 65536,
  top_provider: { max_completion_tokens: 8192 }
};
const FREE_BETA = {
  id: "free/beta:free",
  name: "Free Beta",
  pricing: { prompt: "0", completion: "0" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  context_length: 32768
};
const PAID = {
  id: "paid/premium",
  name: "Paid Premium",
  pricing: { prompt: "0.000001", completion: "0.000002" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] }
};
const IMAGE_ONLY = {
  id: "free/image-only:free",
  name: "Image Only",
  pricing: { prompt: "0", completion: "0" },
  architecture: { input_modalities: ["text"], output_modalities: ["image"] }
};
const NO_PRICING = {
  id: "free/unknown-price:free",
  name: "Unknown Price",
  architecture: { input_modalities: ["text"], output_modalities: ["text"] }
};

const state = { modelsRequests: 0, keyRequests: 0, listStatus: 200, keyStatus: 200 };
const server = http.createServer((req, res) => {
  if (req.url === "/v1/key") {
    state.keyRequests += 1;
    if (state.keyStatus !== 200) {
      res.writeHead(state.keyStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        label: "test-label",
        usage: 1.5,
        limit: 5,
        limit_remaining: 3.5,
        is_free_tier: true
      }
    }));
    return;
  }
  if (req.url === "/v1/models") {
    state.modelsRequests += 1;
    if (state.listStatus !== 200) {
      res.writeHead(state.listStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "catalog unavailable" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [FREE_ALPHA, FREE_BETA, PAID, IMAGE_ONLY, NO_PRICING] }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_MODEL",
  "OPENROUTER_DEFAULT_MODEL",
  "OPENROUTER_FALLBACK_MODEL",
  "OPENROUTER_MODELS",
  "OPENROUTER_CATALOG_TTL_MS",
  "OPENROUTER_CATALOG_STALE_MS"
];
const original = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));

function setEnv({ model = FREE_ALPHA.id, fallback, models, ttl } = {}) {
  process.env.OPENROUTER_API_KEY = "sk-or-test-key";
  process.env.OPENROUTER_BASE_URL = baseUrl;
  process.env.OPENROUTER_MODEL = model;
  if (fallback === undefined) delete process.env.OPENROUTER_FALLBACK_MODEL;
  else process.env.OPENROUTER_FALLBACK_MODEL = fallback;
  if (models === undefined) delete process.env.OPENROUTER_MODELS;
  else process.env.OPENROUTER_MODELS = models;
  if (ttl === undefined) delete process.env.OPENROUTER_CATALOG_TTL_MS;
  else process.env.OPENROUTER_CATALOG_TTL_MS = String(ttl);
  resetOpenRouterCache();
}

beforeEach(() => {
  state.modelsRequests = 0;
  state.keyRequests = 0;
  state.listStatus = 200;
  state.keyStatus = 200;
});

after(async () => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetOpenRouterCache();
  await new Promise(resolve => server.close(resolve));
});

test("only zero-price chat models are exposed and the configured default leads the list", async () => {
  setEnv({ fallback: FREE_BETA.id });
  const result = await checkOpenRouter();
  assert.equal(result.status, "available");
  assert.equal(result.available, true);
  assert.equal(result.freeOnly, true);
  assert.equal(result.model, FREE_ALPHA.id);
  assert.equal(result.fallbackModel, FREE_BETA.id);
  assert.deepEqual(result.models.map(model => model.id), [FREE_ALPHA.id, FREE_BETA.id]);
  const alpha = result.models[0];
  assert.equal(alpha.free, true);
  assert.equal(alpha.capabilities.vision, true);
  assert.equal(alpha.capabilities.tools, true);
  assert.equal(alpha.capabilities.reasoning, true);
  assert.equal(alpha.capabilities.contextLength, 65536);
  assert.equal(alpha.capabilities.maxOutputTokens, 8192);
});

test("the pricing filter does not trust model names or assume missing pricing is free", () => {
  assert.equal(openRouterModelIsFree(FREE_ALPHA), true);
  assert.equal(openRouterModelIsFree(PAID), false);
  assert.equal(openRouterModelIsFree(NO_PRICING), false);
  assert.equal(openRouterModelIsChat(IMAGE_ONLY), false);
  assert.equal(openRouterModelIsChat(FREE_ALPHA), true);
});

test("an explicit allowlist enables paid IDs while keeping missing IDs unavailable", async () => {
  setEnv({ model: FREE_ALPHA.id, models: `${FREE_ALPHA.id},paid/premium,missing/model:free` });
  const result = await checkOpenRouter();
  assert.equal(result.status, "available");
  assert.equal(result.freeOnly, false);
  const paid = result.models.find(model => model.id === "paid/premium");
  assert.equal(paid.available, true);
  assert.equal(paid.paid, true);
  assert.equal(paid.reason, undefined);
  const missing = result.models.find(model => model.id === "missing/model:free");
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "missing");
  assert.ok(!result.models.some(model => model.id === FREE_BETA.id), "dynamic free models must not leak into an explicit allowlist");
});

test("paid defaults never make paid models fallback candidates", async () => {
  setEnv({ model: PAID.id, models: `${PAID.id},${FREE_ALPHA.id},${FREE_BETA.id}`, fallback: FREE_BETA.id });
  const result = await checkOpenRouter();
  assert.equal(result.status, "available");
  assert.equal(result.model, PAID.id);
  assert.equal(result.fallbackModel, FREE_BETA.id);
  assert.equal(result.models[0].paid, true);
  assert.equal(result.models.find(model => model.id === FREE_ALPHA.id).paid, false);
});

test("a paid-only allowlist without a safe default does not silently choose a paid model", async () => {
  setEnv({ model: "missing/default", models: PAID.id });
  const result = await checkOpenRouter();
  assert.equal(result.status, "missing_model");
  assert.equal(result.available, false);
  assert.equal(result.models.find(model => model.id === PAID.id).available, true);
});

test("OpenRouter key verification reports safe account limits and rejects bad keys", async () => {
  setEnv();
  const valid = await checkOpenRouterKey();
  assert.equal(valid.configured, true);
  assert.equal(valid.authenticated, true);
  assert.equal(valid.status, "authenticated");
  assert.equal(valid.usage, 1.5);
  assert.equal(valid.limit, 5);
  assert.equal(valid.limitRemaining, 3.5);
  assert.equal(valid.isFreeTier, true);
  assert.equal(valid.label, undefined, "key labels must not be exposed");
  assert.equal(state.keyRequests, 1);

  state.keyStatus = 401;
  const rejected = await checkOpenRouterKey();
  assert.equal(rejected.authenticated, false);
  assert.equal(rejected.status, "unauthorized");
  assert.equal(rejected.httpStatus, 401);
  assert.equal(rejected.detail, undefined, "raw key errors must not be exposed");

  delete process.env.OPENROUTER_API_KEY;
  const missing = await checkOpenRouterKey();
  assert.equal(missing.configured, false);
  assert.equal(missing.status, "not_configured");
});

test("the catalog is cached and forceRefresh bypasses the cache", async () => {
  setEnv();
  await checkOpenRouter();
  await checkOpenRouter();
  assert.equal(state.modelsRequests, 1);
  await checkOpenRouter({ forceRefresh: true });
  assert.equal(state.modelsRequests, 2);
});

test("a transient catalog failure serves a recent cached catalog with a stale marker", async () => {
  setEnv({ ttl: 1 });
  const first = await checkOpenRouter();
  assert.equal(first.catalogStale, false);
  await new Promise(resolve => setTimeout(resolve, 5));
  state.listStatus = 503;
  const second = await checkOpenRouter();
  assert.equal(second.status, "available");
  assert.equal(second.catalogStale, true);
});

test("a rejected server key is reported as unauthorized instead of serving stale models", async () => {
  setEnv();
  await checkOpenRouter();
  state.listStatus = 401;
  const result = await checkOpenRouter({ forceRefresh: true });
  assert.equal(result.status, "unauthorized");
  assert.equal(result.available, false);
});
