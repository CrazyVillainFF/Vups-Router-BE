import test from "node:test";
import assert from "node:assert/strict";
import { startFakeQoder, FAKE_QODER_API_KEY, FAKE_QODER_SA_KEY } from "./testUtils/fakeQoder.js";
import {
  ProviderError,
  qoderApiBase,
  qoderRegionForHost,
  qoderServiceTokenUrl,
  testProviderConnection,
  validateQoderSettings
} from "./providerClient.js";
import ProviderConfig, { invalidatedTestFields, providerBehaviorChanged } from "./providerConfig.js";

async function withFake(fn) {
  const fake = await startFakeQoder();
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

const qoder = (fake, overrides = {}) => ({
  baseUrl: fake.baseUrl,
  apiKey: FAKE_QODER_API_KEY,
  providerType: "qoder_cloud_agents",
  ...overrides
});

test("a PAT is sent straight to the business API and never exchanged", async () => {
  await withFake(async fake => {
    const result = await testProviderConnection(qoder(fake));
    assert.equal(result.authMode, "pat");
    assert.ok(result.availableModels.some(model => model.id === "ultimate"));
    assert.equal(fake.state.requests.filter(entry => entry.path.includes("serviceToken")).length, 0);
    const models = fake.state.requests.find(entry => entry.path === "/api/v1/cloud/models");
    assert.equal(models.auth, "Bearer <pat>");
  });
});

test("a service account key is exchanged for a SAT used by the business API", async () => {
  await withFake(async fake => {
    const origin = new URL(fake.baseUrl).origin;
    const result = await testProviderConnection(
      qoder(fake, { apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: origin })
    );
    const exchange = fake.state.requests.find(entry => entry.path === "/api/v1/serviceToken/exchange");
    assert.ok(exchange, "the documented exchange endpoint was called");
    // `auth` is the fake's credential label: it proves which token reached
    // which host without putting a token string in the assertion output.
    assert.equal(exchange.auth, "Bearer <sa-key>");
    assert.deepEqual(exchange.body, {
      grant_type: "client_credentials",
      audience: "qoder",
      scope: "qca.access",
      ttl_seconds: 3600
    });
    const models = fake.state.requests.find(entry => entry.path === "/api/v1/cloud/models");
    assert.equal(models.auth, "Bearer <sat#1>", "the business API gets the exchanged token");
    assert.notEqual(models.auth, "Bearer <sa-key>", "the long-lived key never reaches the business API");
    assert.equal(result.authMode, "service_account");
    assert.equal(result.openapiHost, "127.0.0.1");
  });
});

test("a token exchange without access_token is an authentication failure, not success", async () => {
  await withFake(async fake => {
    fake.state.exchangePayload = { token_type: "Bearer", expires_in: 3600 };
    await assert.rejects(
      testProviderConnection(
        qoder(fake, { apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: new URL(fake.baseUrl).origin })
      ),
      error => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, "invalid_response");
        assert.equal(error.qoderStage, "token_exchange");
        assert.equal(fake.state.requests.some(entry => entry.path.startsWith("/api/v1/cloud/")), false, "no business call after a failed exchange");
        assert.doesNotMatch(error.message, new RegExp(FAKE_QODER_SA_KEY));
        return true;
      }
    );
  });
});

test("HTTP 401 is reported as an invalid credential without leaking it", async () => {
  await withFake(async fake => {
    await assert.rejects(testProviderConnection(qoder(fake, { apiKey: "bad-key-123456" })), error => {
      assert.equal(error.code, "invalid_api_key");
      assert.match(error.message, /personal access token/i);
      assert.doesNotMatch(error.message, /bad-key-123456/);
      return true;
    });
    await assert.rejects(
      testProviderConnection(
        qoder(fake, { apiKey: `${FAKE_QODER_SA_KEY}-revoked`, authMode: "service_account", openapiBaseUrl: new URL(fake.baseUrl).origin })
      ),
      error => {
        assert.equal(error.code, "invalid_api_key");
        assert.equal(error.qoderStage, "token_exchange");
        assert.match(error.message, /service account key/i);
        assert.doesNotMatch(error.message, new RegExp(FAKE_QODER_SA_KEY));
        return true;
      }
    );
  });
});

test("HTTP 403 is reported as insufficient scope", async () => {
  await withFake(async fake => {
    fake.state.modelsStatus = 403;
    await assert.rejects(testProviderConnection(qoder(fake)), error => {
      assert.equal(error.code, "insufficient_scope");
      assert.match(error.message, /qca\.access/);
      return true;
    });
    fake.state.modelsStatus = 0;
    fake.state.scopeDenied = true;
    await assert.rejects(
      testProviderConnection(
        qoder(fake, { apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: new URL(fake.baseUrl).origin })
      ),
      error => {
        assert.equal(error.code, "insufficient_scope");
        assert.equal(error.qoderStage, "token_exchange");
        return true;
      }
    );
  });
});

test("a wrong path returns HTTP 404 instead of a false 'reachable' result", async () => {
  await withFake(async fake => {
    const origin = new URL(fake.baseUrl).origin;
    await assert.rejects(testProviderConnection(qoder(fake, { baseUrl: `${origin}/wrong` })), error => {
      assert.equal(error.code, "not_found");
      assert.match(error.message, /404/);
      return true;
    });
  });
});

test("documented regional hosts resolve to matching exchange and business URLs", () => {
  assert.equal(qoderRegionForHost("api.qoder.com"), "global");
  assert.equal(qoderRegionForHost("api.qoder.com.cn"), "cn");
  assert.equal(qoderRegionForHost("openapi.qoder.sh"), "global");
  assert.equal(qoderRegionForHost("openapi.qoder.com.cn"), "cn");
  assert.equal(qoderApiBase("https://api.qoder.com"), "https://api.qoder.com/api/v1/cloud");
  assert.equal(qoderApiBase("https://api.qoder.com.cn"), "https://api.qoder.com.cn/api/v1/cloud");
  assert.equal(qoderApiBase("https://openapi.qoder.sh"), "https://api.qoder.com/api/v1/cloud");
  assert.equal(qoderApiBase("https://openapi.qoder.com.cn"), "https://api.qoder.com.cn/api/v1/cloud");
  assert.equal(qoderServiceTokenUrl("https://openapi.qoder.sh"), "https://openapi.qoder.sh/api/v1/serviceToken/exchange");
  assert.equal(
    qoderServiceTokenUrl("https://openapi.qoder.com.cn/api/v1"),
    "https://openapi.qoder.com.cn/api/v1/serviceToken/exchange"
  );
  assert.throws(
    () =>
      validateQoderSettings({
        baseUrl: "https://api.qoder.com",
        authMode: "service_account",
        openapiBaseUrl: "https://openapi.qoder.com.cn"
      }),
    error => error instanceof ProviderError && error.code === "incorrect_region"
  );
});

test("base URL normalization removes duplicate /api/v1 and stray slashes", () => {
  assert.equal(qoderApiBase("https://api.qoder.com/api/v1/cloud/"), "https://api.qoder.com/api/v1/cloud");
  assert.equal(qoderApiBase("https://api.qoder.com/api/v1"), "https://api.qoder.com/api/v1/cloud");
  assert.equal(qoderApiBase("https://api.qoder.com/api/v1/api/v1/cloud"), "https://api.qoder.com/api/v1/cloud");
  assert.equal(qoderApiBase("https://gateway.example.com/api/v1"), "https://gateway.example.com/api/v1/cloud");
  assert.equal(qoderApiBase("https://gateway.example.com/api/v1/cloud/"), "https://gateway.example.com/api/v1/cloud");
  const path = new URL(qoderApiBase("https://gateway.example.com//api//v1/cloud")).pathname;
  assert.doesNotMatch(path, /\/{2,}/);
  assert.doesNotMatch(path, /\/api\/v\d+\/api\/v\d+/i);
});

test("network failures and timeouts are distinguishable", async () => {
  await assert.rejects(
    testProviderConnection({ baseUrl: "http://127.0.0.1:1/api/v1/cloud", apiKey: FAKE_QODER_API_KEY, providerType: "qoder_cloud_agents" }),
    error => ["network_error", "connection_refused", "dns_error"].includes(error.code)
  );
  await withFake(async fake => {
    fake.state.modelsDelayMs = 200;
    await assert.rejects(testProviderConnection(qoder(fake), AbortSignal.timeout(30)), error => {
      assert.equal(error.code, "timeout");
      return true;
    });
  });
});

test("HTTP 429 and 5xx map to rate limiting and upstream unavailability", async () => {
  await withFake(async fake => {
    fake.state.modelsStatus = 429;
    await assert.rejects(testProviderConnection(qoder(fake)), error => error.code === "rate_limited");
    fake.state.modelsStatus = 503;
    await assert.rejects(testProviderConnection(qoder(fake)), error => error.code === "provider_unavailable");
  });
});

test("an expired SAT is discarded and exchanged again once", async () => {
  await withFake(async fake => {
    fake.state.rejectSatOnce = true;
    const result = await testProviderConnection(
      qoder(fake, { apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: new URL(fake.baseUrl).origin })
    );
    assert.equal(result.authMode, "service_account");
    assert.equal(fake.state.serviceTokensIssued, 2);
    const models = fake.state.requests.filter(entry => entry.path === "/api/v1/cloud/models");
    assert.equal(models.length, 2);
    assert.equal(models[0].auth, "Bearer <sat#1>");
    assert.equal(models[1].auth, "Bearer <sat#2>", "the retry uses the freshly exchanged token");
  });
});

test("a malformed model list is invalid_response, never 'connected'", async () => {
  await withFake(async fake => {
    fake.state.modelsInvalidShape = true;
    await assert.rejects(testProviderConnection(qoder(fake)), error => {
      assert.equal(error.code, "invalid_response");
      return true;
    });
    fake.state.modelsInvalidShape = false;
    fake.state.modelsStatus = 404;
    const result = await testProviderConnection(qoder(fake));
    assert.equal(result.listingSupported, false);
    assert.match(result.warning, /business API/);
    assert.ok(fake.state.requests.some(entry => entry.method === "GET" && entry.path === "/api/v1/cloud/agents"));
  });
});

test("connection testing never creates environments, agents, or sessions", async () => {
  await withFake(async fake => {
    await testProviderConnection(qoder(fake));
    await testProviderConnection(
      qoder(fake, { apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: new URL(fake.baseUrl).origin })
    );
    const mutations = fake.state.requests.filter(
      entry => entry.method === "POST" && !entry.path.endsWith("/serviceToken/exchange")
    );
    assert.deepEqual(mutations, []);
  });
});

test("credentials never appear in diagnostics or error messages", async () => {
  const logged = [];
  const original = console.warn;
  console.warn = (...args) => logged.push(args.map(value => String(value)).join(" "));
  try {
    await withFake(async fake => {
      await testProviderConnection(
        qoder(fake, { apiKey: FAKE_QODER_SA_KEY, authMode: "service_account", openapiBaseUrl: new URL(fake.baseUrl).origin })
      );
      await assert.rejects(
        testProviderConnection(qoder(fake, { apiKey: "bad-key-123456" })),
        error => {
          const visible = `${error.message}\n${JSON.stringify(error.diagnostics || {})}`;
          assert.doesNotMatch(visible, /bad-key-123456/);
          return true;
        }
      );
      const sat = fake.state.currentSat;
      assert.ok(sat);
      const output = logged.join("\n");
      assert.doesNotMatch(output, new RegExp(FAKE_QODER_SA_KEY));
      assert.doesNotMatch(output, new RegExp(sat));
      assert.doesNotMatch(output, /authorization/i);
    });
  } finally {
    console.warn = original;
  }
});

test("saved settings default to PAT and behavior changes invalidate old results", () => {
  assert.equal(ProviderConfig.schema.path("authMode").defaultValue, "pat");
  assert.equal(ProviderConfig.schema.path("openapiBaseUrl").defaultValue, "");
  const existing = {
    baseUrl: "https://api.qoder.com/api/v1/cloud",
    providerType: "qoder_cloud_agents",
    authMode: "pat",
    openapiBaseUrl: ""
  };
  assert.equal(providerBehaviorChanged(existing, { ...existing }), false);
  assert.equal(providerBehaviorChanged(existing, { ...existing, authMode: "service_account" }), true);
  assert.equal(providerBehaviorChanged(existing, { ...existing, openapiBaseUrl: "https://openapi.qoder.sh" }), true);
  assert.deepEqual(invalidatedTestFields(), { lastTestStatus: "", lastTestCode: "", lastTestMessage: "", lastTestAt: null });
});
