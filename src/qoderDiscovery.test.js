import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chatCompletion, listProviderModels, ProviderError, testProviderConnection } from "./providerClient.js";
import { FAKE_QODER_API_KEY, FAKE_QODER_SA_KEY, startFakeQoder } from "./testUtils/fakeQoder.js";
import { FAKE_API_KEY, startFakeProvider } from "./testUtils/fakeProvider.js";

// The documented Managed-mode contract (docs.qoder.com → Cloud Agents → API →
// Models → List models): GET {base}/api/v1/cloud/models, `Authorization: Bearer`
// with a PAT or SAT, no query parameters, and a `{ "data": [...], "has_more":
// false }` envelope whose entries carry id / display_name / is_enabled /
// max_input_tokens. These tests pin that contract and, above all, the rule that
// a failed or empty discovery must never look like a successful one.

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

function check(options = {}, signal) {
  return testProviderConnection({
    baseUrl,
    apiKey: FAKE_QODER_API_KEY,
    providerType: "qoder_cloud_agents",
    authMode: "pat",
    openapiBaseUrl: "",
    ...options
  }, signal);
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to fail, but it resolved" });
}

test("a Qoder HTTP 400 on the model list is an error, never a silent empty catalogue", async () => {
  fake.state.modelsStatus = 400;
  const error = await rejection(check());
  assert.ok(error instanceof ProviderError, `expected a ProviderError, got ${error}`);
  assert.equal(error.status, 400);
  assert.equal(error.code, "bad_request");
  assert.doesNotMatch(error.message, /connection succeeded/i);
  assert.equal(requests.length, 1, "a rejected request is not disguised by a second read-only probe");
  assert.equal(requests[0].path, "/api/v1/cloud/models");
});

test("a 400 during Check connection still keeps the saved catalogue untouched", async () => {
  // The same failure reached the settings route through the shared listing
  // helper; discovery must not write anything when it never got a model list.
  fake.state.modelsStatus = 400;
  const error = await rejection(listProviderModels({ baseUrl, apiKey: FAKE_QODER_API_KEY, providerType: "qoder_cloud_agents" }));
  assert.ok(error instanceof ProviderError);
  assert.equal(error.status, 400);
  assert.equal(requests.filter(entry => entry.path === "/api/v1/cloud/models").length, 1, "one listing attempt, no silent retry as success");
});

test("a legitimate empty model list is reported as empty, not as a success", async () => {
  fake.state.modelsPayload = { data: [], has_more: false };
  const result = await check();
  assert.deepEqual(result.availableModels, []);
  assert.equal(result.listingSupported, true, "the endpoint did answer, so listing is supported");
  assert.ok(result.warning, "an empty catalogue must be surfaced, not shown as connected-with-models");
  assert.match(result.warning, /no enabled models/i);
});

for (const [status, expectedCode] of [
  [401, "invalid_api_key"],
  [403, "insufficient_scope"],
  [429, "rate_limited"],
  [500, "provider_unavailable"]
]) {
  test(`an HTTP ${status} from the model list surfaces its own error class`, async () => {
    fake.state.modelsStatus = status;
    const error = await rejection(check());
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, status);
    assert.equal(error.code, expectedCode);
  });
}

test("an HTTP 404 falls back to the read-only agents probe instead of claiming models", async () => {
  fake.state.modelsStatus = 404;
  const result = await check();
  assert.deepEqual(result.availableModels, []);
  assert.equal(result.listingSupported, false);
  assert.ok(result.warning, "the fallback must be visible to the user");
  const paths = requests.map(entry => `${entry.path}${entry.search || ""}`);
  assert.deepEqual(paths, ["/api/v1/cloud/models", "/api/v1/cloud/agents?limit=1"]);
});

test("when the agents fallback also fails, the error surfaces instead of an empty success", async () => {
  fake.state.modelsStatus = 404;
  fake.state.agentsStatus = 503;
  const error = await rejection(check());
  assert.ok(error instanceof ProviderError);
  assert.equal(error.status, 503);
});

test("a timeout is a timeout, not an empty model list", async () => {
  fake.state.modelsDelayMs = 600;
  const error = await rejection(check({}, AbortSignal.timeout(150)));
  assert.ok(error instanceof ProviderError);
  assert.ok(["timeout", "cancelled"].includes(error.code), `unexpected code ${error.code}`);
});

test("the listing call matches the documented path, header, and absence of query parameters", async () => {
  await check();
  const entry = requests.find(request => request.path === "/api/v1/cloud/models");
  assert.ok(entry, "the model list must be requested on /api/v1/cloud/models");
  assert.equal(entry.method, "GET");
  assert.equal(entry.search, "", "the documented endpoint takes no query parameters");
  assert.equal(entry.tokenKind, "pat", "the PAT is presented as the bearer credential");
  assert.match(entry.headers.authorization, /^Bearer /);
});

test("malformed individual entries are dropped without losing the valid models", async () => {
  fake.state.modelsPayload = {
    data: [
      null,
      { id: 12345, display_name: "Numeric id" },
      { display_name: "No id at all" },
      { id: "   ", display_name: "Blank id" },
      { id: "qfmodel", display_name: "Qwen Flash", is_enabled: true, max_input_tokens: 256000 },
      { id: "retired", display_name: "Retired", is_enabled: false }
    ],
    has_more: false
  };
  const models = await listProviderModels({ baseUrl, apiKey: FAKE_QODER_API_KEY, providerType: "qoder_cloud_agents" });
  assert.deepEqual(models.map(model => model.id), ["qfmodel"]);
  assert.equal(models[0].contextLength, 256000);
  assert.equal(models[0].ownedBy, "Qoder · Qwen Flash", "the picker label is the human-readable display name");
});

test("the opaque id, not the display name, is what gets sent to Qoder", async () => {
  fake.state.modelsPayload = {
    data: [{ id: "ultimate", display_name: "Qwen3.8-Flash", is_enabled: true }],
    has_more: false
  };
  await chatCompletion({
    baseUrl,
    apiKey: FAKE_QODER_API_KEY,
    providerType: "qoder_cloud_agents",
    model: "Qwen3.8-Flash",
    messages: [{ role: "user", content: "hi" }]
  });
  const agent = requests.find(entry => entry.method === "POST" && entry.path === "/api/v1/cloud/agents");
  assert.equal(agent.body.model, "ultimate", "the resolved model id is used for the agent");
});

test("duplicate display names are never guessed at", async () => {
  // state.agents survives clearRequests(): the previous test created one. Only growth matters here.
  const agentsBefore = fake.state.agents.length;
  fake.state.modelsPayload = {
    data: [
      { id: "ultimate", display_name: "Same Name", is_enabled: true },
      { id: "giga", display_name: "Same Name", is_enabled: true }
    ],
    has_more: false
  };
  const error = await rejection(
    chatCompletion({
      baseUrl,
      apiKey: FAKE_QODER_API_KEY,
      providerType: "qoder_cloud_agents",
      model: "Same Name",
      messages: [{ role: "user", content: "hi" }]
    })
  );
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, "invalid_model");
  assert.equal(fake.state.agents.length, agentsBefore, "an ambiguous name must not create an agent");
});

test("a service account key is exchanged first and never reaches the business API", async () => {
  const result = await check({
    apiKey: FAKE_QODER_SA_KEY,
    authMode: "service_account",
    openapiBaseUrl: new URL(baseUrl).origin
  });
  assert.ok(result.availableModels.length > 0);
  const exchange = requests.find(entry => entry.path === "/api/v1/serviceToken/exchange");
  assert.ok(exchange, "token exchange happens before the model list");
  assert.equal(exchange.tokenKind, "sa-key", "the long-lived key is only ever sent to the OpenAPI exchange host");
  assert.ok(requests[0] === exchange, "the exchange is the first call of the check");
  const listing = requests.find(entry => entry.path === "/api/v1/cloud/models");
  assert.equal(listing.tokenKind, "sat", "the business API gets the short-lived exchanged token");
});

test("the request log never records a bearer token verbatim", async () => {
  await check();
  await check({ apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: new URL(baseUrl).origin });
  const leaked = requests.filter(entry => JSON.stringify(entry).includes(FAKE_QODER_API_KEY) || JSON.stringify(entry).includes(FAKE_QODER_SA_KEY));
  assert.deepEqual(leaked, [], "a fake key must never appear in the diagnostic log either");
});

test("non-Qoder providers keep their own unsupported-listing behaviour", async () => {
  // The Qoder fix must not change OpenAI-compatible / OpenRouter-style
  // listings: a 400 there still means "endpoint reached, listing unverified"
  // rather than a hard connection failure.
  const openai = await startFakeProvider();
  try {
    openai.state.behavior.listStatus = 400;
    const result = await testProviderConnection({
      baseUrl: `${openai.baseUrl}/v1`,
      apiKey: FAKE_API_KEY,
      providerType: "openai_compatible"
    });
    assert.deepEqual(result.availableModels, []);
    assert.equal(result.listingSupported, false);
    assert.match(result.warning, /endpoint was reached/i);
  } finally {
    await openai.close();
  }
});
