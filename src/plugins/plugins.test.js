import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";

const { PLUGIN_CATALOG, catalogSummary, getPlugin } = await import("./catalog.js");
const { ADAPTERS, getAdapter, publicTools } = await import("./adapters/index.js");
const { validateInput } = await import("./validation.js");
const { createOAuthState, verifyOAuthState } = await import("./oauth.js");
const { parseToolName, toolNameFor } = await import("./service.js");

test("catalog has at least 80 distinct, truthful plugins", () => {
  assert.ok(PLUGIN_CATALOG.length >= 80);
  const ids = PLUGIN_CATALOG.map(plugin => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const plugin of PLUGIN_CATALOG) {
    assert.ok(plugin.name && plugin.category && plugin.description, plugin.id);
    assert.ok(["none", "api_key", "optional_api_key", "oauth"].includes(plugin.auth.type), plugin.id);
    if (plugin.adapter) {
      assert.ok(getAdapter(plugin.adapter), `${plugin.id} references a missing adapter`);
      assert.equal(plugin.implemented, true);
    } else {
      assert.equal(plugin.implemented, false);
      assert.equal(plugin.availability, "in_development");
    }
    if (plugin.implemented) {
      if (plugin.auth.type === "none" || plugin.auth.type === "optional_api_key") {
        assert.equal(plugin.availability, "available", plugin.id);
      } else if (plugin.auth.type === "api_key") {
        assert.equal(plugin.availability, "requires_setup", plugin.id);
      } else {
        assert.equal(plugin.availability, "oauth_required", plugin.id);
      }
    }
  }
  const summary = catalogSummary();
  assert.equal(summary.catalog, PLUGIN_CATALOG.length);
  assert.equal(summary.implemented, PLUGIN_CATALOG.filter(plugin => plugin.implemented).length);
  assert.equal(summary.available + summary.requiresSetup + summary.oauthRequired + summary.inDevelopment, summary.catalog);
});

test("every adapter has unique tools with object schemas", () => {
  for (const [adapterId, adapter] of Object.entries(ADAPTERS)) {
    assert.equal(adapter.id, adapterId);
    const names = adapter.tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length, adapterId);
    for (const tool of adapter.tools) {
      assert.ok(tool.description, `${adapterId}.${tool.name}`);
      assert.equal(tool.inputSchema?.type, "object", `${adapterId}.${tool.name}`);
      assert.equal(tool.inputSchema?.additionalProperties, false, `${adapterId}.${tool.name}`);
    }
  }
});

test("public tool views never expose executable functions", () => {
  const tools = publicTools("github");
  assert.ok(tools.length >= 3);
  assert.ok(tools.some(tool => tool.name === "create_issue" && tool.sensitive));
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name", "sensitive"].sort());
  }
});

test("tool input validation enforces required fields and bounds", () => {
  const plugin = getPlugin("wikipedia");
  const tool = getAdapter(plugin.adapter).tools.find(item => item.name === "search");
  assert.throws(() => validateInput(tool.inputSchema, {}), /query is required/);
  assert.throws(() => validateInput(tool.inputSchema, { query: "x", limit: 99 }), /limit must be at most 10/);
  assert.throws(() => validateInput(tool.inputSchema, { query: "x", extra: true }), /extra is not supported/);
  assert.deepEqual(validateInput(tool.inputSchema, { query: "x", limit: 2 }), { query: "x", limit: 2 });
});

test("tool names round-trip and reject malformed names", () => {
  const name = toolNameFor("open-meteo", "current");
  assert.deepEqual(parseToolName(name), { pluginId: "open-meteo", toolName: "current" });
  assert.equal(parseToolName("other__x__y"), null);
  assert.equal(parseToolName("plugin__"), null);
  assert.equal(parseToolName("plugin__id__"), null);
});

test("OAuth state is signed, scoped, and tamper-resistant", () => {
  const state = createOAuthState({ userId: "user-1", pluginId: "google-drive", redirectUri: "http://localhost/cb" });
  const payload = verifyOAuthState(state);
  assert.equal(payload.sub, "user-1");
  assert.equal(payload.pluginId, "google-drive");
  assert.equal(payload.redirectUri, "http://localhost/cb");
  assert.throws(() => verifyOAuthState(`${state}x`), /invalid or has expired/);
});

test("live provider verification attempts every credential-free adapter", async () => {
  const source = await readFile(new URL("../../scripts/verify-plugins.mjs", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const PUBLIC = ["), source.indexOf("const CREDENTIALED = ["));
  assert.ok(block.startsWith("const PUBLIC = ["), "verify-plugins.mjs PUBLIC list not found");
  const attempted = new Set([...block.matchAll(/"([^"]+)"/g)].map(match => match[1]));
  const credentialFree = Object.keys(ADAPTERS).filter(adapterId => {
    const row = PLUGIN_CATALOG.find(plugin => plugin.adapter === adapterId);
    return row && (row.auth.type === "none" || row.auth.type === "optional_api_key");
  });
  for (const adapterId of credentialFree) {
    assert.ok(attempted.has(adapterId), `${adapterId} installs without a credential but is never live-tested`);
  }
  assert.equal(credentialFree.length, attempted.size, "verify-plugins.mjs tests adapters that are not credential-free");
});
