import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import dns from "node:dns/promises";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.RATE_LIMIT_MAX = "10000";
process.env.PLUGIN_RATE_LIMIT_MAX = "10000";
process.env.OAUTH_CALLBACK_RATE_LIMIT_MAX = "10000";
delete process.env.MONGODB_URI;

// Both values are test fixtures. Every assertion below that mentions a secret only
// checks that these strings never appear where they should not.
const CLIENT_ID = "Iv1TestClientApplicationId";
const CLIENT_SECRET = "test-client-secret-value-0123456789abcdef";
const OAUTH_TOKEN = "gho_testAccessTokenValue1234567890";
const PAT_TOKEN = "ghp_testPersonalAccessToken1234567890";
const APP_BASE = "https://vups-router-three.test.local";

process.env.PLUGIN_OAUTH_GITHUB_OAUTH_CLIENT_ID = CLIENT_ID;
process.env.PLUGIN_OAUTH_GITHUB_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
process.env.PLUGIN_OAUTH_GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
process.env.PLUGIN_OAUTH_GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
process.env.PLUGIN_OAUTH_GITHUB_OAUTH_SCOPES = "repo read:user";
process.env.PLUGIN_OAUTH_CLIENT_BASE = APP_BASE;

const { MongoMemoryServer } = await import("mongodb-memory-server");
const mongod = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongod.getUri("vupsrouter_github_oauth_test");

const { default: app } = await import("../index.js");
const mongoose = (await import("mongoose")).default;
const { default: PluginInstallation } = await import("./installation.js");
const { default: PluginAudit } = await import("./audit.js");
const { createOAuthState } = await import("./oauth.js");
const PluginOAuthState = (await import("./oauthState.js")).default;

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const CALLBACK_PATH = "/api/plugins/github/oauth/callback";

// The real GitHub host is never contacted. github.com and api.github.com are
// resolved by a stubbed DNS answer and served by the fetch stub below, so the
// SSRF guard, the header building and the response parsing all run for real
// against a simulated provider.
const realFetch = globalThis.fetch;
const gitHubCalls = [];
const fake = {};

function resetFake() {
  gitHubCalls.length = 0;
  Object.assign(fake, {
    tokenStatus: 200,
    tokenBody: { access_token: OAUTH_TOKEN, token_type: "bearer", scope: "repo read:user" },
    user: { login: "octovups", name: "Vups Test Bot", type: "User", html_url: "https://github.com/octovups" },
    repos: [
      {
        full_name: "octovups/demo-repo",
        name: "demo-repo",
        owner: { login: "octovups" },
        description: "Fixture repository",
        html_url: "https://github.com/octovups/demo-repo",
        default_branch: "main",
        private: false,
        visibility: "public",
        stargazers_count: 3,
        updated_at: "2026-11-01T00:00:00Z",
        permissions: { pull: true, push: true, admin: false }
      }
    ],
    reposLinkHeader: "",
    fileContent: "hello from the fixture\n",
    branches: [{ name: "main", commit: { sha: "abc123" }, protected: true }, { name: "feature/x", commit: { sha: "def456" }, protected: false }],
    commits: [{ sha: "abc123", commit: { message: "initial", author: { name: "Vups Test Bot", date: "2026-11-01T00:00:00Z" } }, author: { login: "octovups" }, html_url: "https://github.com/octovups/demo-repo/commit/abc123" }],
    issueNumber: 7,
    revokeStatus: 200
  });
}
resetFake();

function respond(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4972",
      "x-ratelimit-used": "28",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      ...headers
    }
  });
}

function base64(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

// http.js hands fetch() a URL instance, not a string, so both shapes have to work.
function urlOf(input) {
  if (typeof input === "string") return input;
  return String(input?.url || input?.href || "");
}

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = urlOf(input);
  if (!/^https?:\/\/(github\.com|api\.github\.com)/.test(rawUrl)) {
    return realFetch(input, init);
  }
  const url = new URL(rawUrl);
  const record = {
    method: String(init.method || "GET").toUpperCase(),
    url: url.toString(),
    headers: init.headers || {},
    body: typeof init.body === "string" ? init.body : ""
  };
  gitHubCalls.push(record);

  if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
    return respond(fake.tokenBody, fake.tokenStatus);
  }

  if (url.pathname === "/user") return respond(fake.user);
  if (url.pathname === "/rate_limit") return respond({ resources: {} });
  if (url.pathname === "/user/repos") {
    return respond(fake.repos, 200, fake.reposLinkHeader ? { Link: fake.reposLinkHeader } : {});
  }
  if (url.pathname === "/search/repositories") return respond({ items: fake.repos });
  if (url.pathname === "/search/code") return respond({ items: [{ path: "README.md", repository: { full_name: "octovups/demo-repo" }, html_url: "https://github.com/octovups/demo-repo", text_matches: [{ fragment: "hello" }] }] });

  const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (repoMatch) {
    const sub = repoMatch[3] || "";
    if (sub === "" || sub === "/") {
      if (record.method === "GET") return respond(fake.repos[0]);
    }
    if (sub.startsWith("/contents/")) {
      if (record.method === "GET") {
        if (sub === "/contents/" || sub === "/contents") {
          return respond([{ name: "README.md", path: "README.md", type: "file", size: 20, sha: "aaa" }, { name: "src", path: "src", type: "dir", size: 0, sha: "bbb" }]);
        }
        return respond({ name: "README.md", path: "README.md", sha: "aaa", size: fake.fileContent.length, encoding: "base64", content: base64(fake.fileContent) });
      }
      if (record.method === "PUT") return respond({ content: { path: "README.md" }, commit: { sha: "newcommit1" } });
      if (record.method === "DELETE") return respond({ commit: { sha: "newcommit2" } });
    }
    if (sub === "/branches") return respond(fake.branches);
    if (sub === "/commits") return respond(fake.commits);
    if (sub.startsWith("/commits/")) return respond({ sha: "def456" });
    if (sub.startsWith("/compare/")) {
      return respond({
        base_commit: { sha: "abc123" },
        merge_base_commit: { sha: "def456" },
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        commits: fake.commits,
        files: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+hello from the fixture" }]
      });
    }
    if (sub.startsWith("/git/refs")) {
      const requested = JSON.parse(record.body || "{}");
      return respond({ ref: requested.ref || "refs/heads/feature/x", object: { sha: "def456" } });
    }
    if (sub === "/issues") {
      if (record.method === "POST") return respond({ number: fake.issueNumber, title: "fixture issue", html_url: "https://github.com/octovups/demo-repo/issues/7", state: "open" });
      return respond([
        { number: 7, title: "fixture issue", state: "open", user: { login: "octovups" }, labels: [{ name: "bug" }], comments: 0, html_url: "https://github.com/octovups/demo-repo/issues/7", updated_at: "2026-11-02T00:00:00Z" },
        { number: 8, title: "fixture pull", state: "open", user: { login: "octovups" }, labels: [], comments: 0, pull_request: {}, html_url: "https://github.com/octovups/demo-repo/pull/8" }
      ]);
    }
    if (sub === "/pulls") {
      if (record.method === "POST") {
        return respond({ number: 9, title: "fixture pull", state: "open", draft: false, user: { login: "octovups" }, head: { label: "octovups:feature/x", sha: "def456" }, base: { label: "octovups:main" }, html_url: "https://github.com/octovups/demo-repo/pull/9", additions: 1, deletions: 0, changed_files: 1 }, 201);
      }
      return respond([{ number: 9, title: "fixture pull", state: "open", draft: false, user: { login: "octovups" }, head: { label: "octovups:feature/x", sha: "def456" }, base: { label: "octovups:main" }, html_url: "https://github.com/octovups/demo-repo/pull/9", additions: 1, deletions: 0, changed_files: 1 }]);
    }
    const pullDetail = sub.match(/^\/pulls\/(\d+)$/);
    if (pullDetail) {
      return respond({ number: Number(pullDetail[1]), title: "fixture pull", state: "open", draft: false, user: { login: "octovups" }, head: { label: "octovups:feature/x", sha: "def456" }, base: { label: "octovups:main" }, body: "fixture body", html_url: "https://github.com/octovups/demo-repo/pull/9", additions: 1, deletions: 0, changed_files: 1 });
    }
    if (sub.match(/^\/pulls\/\d+\/files$/)) {
      return respond([{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+hello from the fixture" }]);
    }
  }

  if (url.pathname.startsWith("/applications/")) {
    return respond(fake.revokeStatus === 200 ? {} : { message: "revocation refused" }, fake.revokeStatus);
  }

  throw new Error(`Simulated GitHub has no handler for ${record.method} ${url.pathname}`);
};

const dnsMock = dns.lookup;
dns.lookup = async () => [{ address: "140.82.112.22", family: 4 }];

after(async () => {
  dns.lookup = dnsMock;
  globalThis.fetch = realFetch;
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(resetFake);

let counter = 0;
function uniqueEmail() {
  counter += 1;
  return `github-oauth-${Date.now()}-${counter}@example.com`;
}

async function api(path, { method = "GET", body, cookie = "" } = {}) {
  const response = await realFetch(`${baseURL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: "manual"
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return {
    status: response.status,
    json,
    text,
    location: response.headers.get("location") || "",
    cookie: response.headers.get("set-cookie") || ""
  };
}

async function signedInUser() {
  const response = await api("/api/auth/signup", {
    method: "POST",
    body: { name: "GitHub OAuth Tester", email: uniqueEmail(), password: "github-pass-123", acceptTerms: true }
  });
  assert.equal(response.status, 201, response.text);
  return { cookie: response.cookie.split(";")[0], userId: response.json.user.id };
}

function callbackUrl(params) {
  const query = new URLSearchParams(params);
  return `${baseURL}${CALLBACK_PATH}?${query}`;
}

async function startOAuth(cookie) {
  const response = await api("/api/plugins/github-oauth/oauth/start", { cookie });
  assert.equal(response.status, 200, response.text);
  const authorize = new URL(response.json.url);
  return { authorize, state: authorize.searchParams.get("state"), redirectUri: authorize.searchParams.get("redirect_uri") };
}

async function connectByOAuth(cookie) {
  const { state } = await startOAuth(cookie);
  const callback = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(state)}`);
  return callback;
}

async function installationOf(pluginId, userId) {
  return PluginInstallation.findOne({ userId, pluginId }).select("+encryptedCredentials").lean();
}

test("the GitHub card advertises both connection methods and hides the sign-in twin", async () => {
  const { cookie } = await signedInUser();
  const { json } = await api("/api/plugins", { cookie });
  const pat = json.plugins.find(plugin => plugin.id === "github");
  const signIn = json.plugins.find(plugin => plugin.id === "github-oauth");
  assert.equal(pat.auth.type, "optional_api_key");
  assert.equal(pat.oauth.pluginId, "github-oauth");
  assert.equal(pat.oauth.configured, true);
  assert.equal(pat.oauth.connection, "disconnected");
  assert.equal(pat.oauth.installed, false);
  assert.equal(signIn.marketplaceEntry, false);
  assert.equal(signIn.availability, "oauth_required");
  assert.ok(json.plugins.filter(plugin => plugin.id === "github").length === 1);
  assert.ok(json.summary.installed >= 0);
});

test("the personal access token path still installs, tests and reads", async () => {
  const { cookie } = await signedInUser();
  const install = await api("/api/plugins/github/install", { method: "POST", body: { token: PAT_TOKEN }, cookie });
  assert.equal(install.status, 201, install.text);
  assert.equal(install.json.plugin.connection, "connected");
  assert.deepEqual(install.json.plugin.credentialsConfigured, { token: true });

  const listed = await api("/api/plugins/github/tools/list_repositories", { method: "POST", body: { args: {} }, cookie });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.result.repositories[0].fullName, "octovups/demo-repo");
  const request = gitHubCalls.find(call => call.url.includes("/user/repos"));
  assert.equal(request.headers.Authorization, `Bearer ${PAT_TOKEN}`);

  const all = [install, listed, await api("/api/plugins", { cookie }), await api("/api/plugins/github", { cookie })];
  for (const entry of all) assert.ok(!entry.text.includes(PAT_TOKEN), "token leaked into an API response");
});

test("the token row refuses an OAuth start instead of pretending", async () => {
  const { cookie } = await signedInUser();
  const response = await api("/api/plugins/github/oauth/start", { cookie });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "oauth_not_supported");
});

test("an OAuth plugin cannot be installed by posting credentials", async () => {
  const { cookie } = await signedInUser();
  const response = await api("/api/plugins/github-oauth/install", { method: "POST", body: { credentials: { accessToken: OAUTH_TOKEN } }, cookie });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "oauth_connection_required");
});

test("the start endpoint builds the real GitHub authorization URL on the documented callback path", async () => {
  const { cookie, userId } = await signedInUser();
  const { authorize, state, redirectUri } = await startOAuth(cookie);
  assert.equal(authorize.origin, "https://github.com");
  assert.equal(authorize.pathname, "/login/oauth/authorize");
  assert.equal(authorize.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("scope"), "repo read:user");
  assert.equal(redirectUri, `${baseURL}${CALLBACK_PATH}`);
  assert.ok(state.length > 20);
  // Only the URL is handed to the app: the state stays inside it and its digest
  // is the single-use record.
  const again = await api("/api/plugins/github-oauth/oauth/start", { cookie });
  assert.deepEqual(Object.keys(again.json), ["url"]);
  assert.ok(!again.text.includes(CLIENT_SECRET));
  // Two starts on this account: each one leaves exactly one single-use record
  // behind, and only the URL leaves the server.
  assert.equal(await PluginOAuthState.countDocuments({ userId, pluginId: "github-oauth" }), 2);
});

test("the start endpoint requires a signed-in session", async () => {
  const response = await api("/api/plugins/github-oauth/oauth/start");
  assert.equal(response.status, 401);
});

test("a successful callback exchanges the code, stores only ciphertext and names the account", async () => {
  const { cookie, userId } = await signedInUser();
  const { state, redirectUri } = await startOAuth(cookie);
  const callback = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(state)}`);
  assert.equal(callback.status, 302, callback.text);
  const target = new URL(callback.location);
  assert.equal(`${target.origin}${target.pathname}`, `${APP_BASE}/plugins`);
  assert.equal(target.searchParams.get("plugin"), "github-oauth");
  assert.equal(target.searchParams.get("oauth"), "connected");
  for (const forbidden of ["code", "state", "token", "access_token"]) {
    assert.equal(target.searchParams.get(forbidden), null, `${forbidden} leaked into the redirect`);
  }
  assert.ok(!callback.location.includes(OAUTH_TOKEN) && !callback.location.includes(state));

  const exchange = gitHubCalls.find(call => call.url === "https://github.com/login/oauth/access_token");
  const exchanged = JSON.parse(exchange.body);
  assert.equal(exchanged.grant_type, "authorization_code");
  assert.equal(exchanged.code, "test-auth-code");
  // GitHub rejects a token exchange whose redirect_uri differs from the authorize
  // request, so both must be byte-identical.
  assert.equal(exchanged.redirect_uri, redirectUri);

  const stored = await installationOf("github-oauth", userId);
  assert.equal(stored.status, "connected");
  assert.match(stored.encryptedCredentials, /^v2:/);
  assert.ok(!stored.encryptedCredentials.includes(OAUTH_TOKEN), "plaintext token stored");
  assert.deepEqual(stored.credentialKeys, ["accessToken"]);
  assert.equal(stored.config.account.login, "octovups");
  assert.equal(stored.config.connectedVia, "oauth");
  assert.equal(stored.config.scopes, "repo read:user");

  const detail = await api("/api/plugins/github", { cookie });
  assert.equal(detail.json.plugin.oauth.connection, "connected");
  assert.equal(detail.json.plugin.oauth.account.login, "octovups");
  const signInDetail = await api("/api/plugins/github-oauth", { cookie });
  assert.equal(signInDetail.json.plugin.lastTestMessage, "Signed in as octovups.");
  assert.ok(!detail.text.includes(OAUTH_TOKEN) && !detail.text.includes(CLIENT_SECRET));

  const activity = await api("/api/plugins/activity", { cookie });
  const actions = activity.json.activity.map(entry => entry.action);
  assert.ok(actions.includes("oauth_start") && actions.includes("oauth_callback"), actions.join(","));
  assert.ok(!activity.text.includes(OAUTH_TOKEN));
});

test("a replayed callback is refused and never exchanges the code twice", async () => {
  const { cookie, userId } = await signedInUser();
  const { state } = await startOAuth(cookie);
  const first = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(state)}`);
  assert.equal(new URL(first.location).searchParams.get("oauth"), "connected");
  const second = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(state)}`);
  const target = new URL(second.location);
  assert.equal(target.searchParams.get("oauth"), "error");
  assert.equal(target.searchParams.get("reason"), "replayed_state");
  assert.equal(gitHubCalls.filter(call => call.url.includes("login/oauth/access_token")).length, 1);
  assert.equal((await installationOf("github-oauth", userId)).status, "connected");
});

test("a state the TTL sweep has already removed is reported as expired", async () => {
  const { cookie } = await signedInUser();
  const { state } = await startOAuth(cookie);
  await PluginOAuthState.deleteMany({});
  const callback = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(state)}`);
  assert.equal(new URL(callback.location).searchParams.get("reason"), "replayed_state");
  assert.equal(gitHubCalls.filter(call => call.url.includes("login/oauth/access_token")).length, 0);
});

test("a forged or tampered state never reaches the token exchange", async () => {
  const { cookie, userId } = await signedInUser();
  const { state } = await startOAuth(cookie);
  const [header, payload, signature] = state.split(".");
  const cases = [
    `${header}.${payload}.${signature.slice(0, -2)}xx`,
    `${header}.${Buffer.from(JSON.stringify({ sub: "someone-else", pluginId: "github-oauth", kind: "plugin_oauth" })).toString("base64url")}.${signature}`,
    "not-a-jwt",
    ""
  ];
  for (const candidate of cases) {
    const callback = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(candidate)}`);
    const target = new URL(callback.location);
    assert.equal(target.searchParams.get("oauth"), "error", candidate);
    assert.equal(target.searchParams.get("reason"), "invalid_state", candidate);
  }
  assert.equal((await PluginInstallation.countDocuments({ userId, pluginId: "github-oauth" })), 0);
});

test("a state minted for a different plugin is refused at the GitHub callback", async () => {
  const { cookie, userId } = await signedInUser();
  const foreign = createOAuthState({ userId, pluginId: "google-drive", redirectUri: `${baseURL}${CALLBACK_PATH}` });
  await PluginOAuthState.create({
    _id: (await import("node:crypto")).createHash("sha256").update(foreign).digest("hex"),
    userId,
    pluginId: "google-drive",
    expiresAt: new Date(Date.now() + 60000)
  });
  const callback = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(foreign)}`);
  assert.equal(new URL(callback.location).searchParams.get("reason"), "invalid_state");
  assert.equal(new URL(callback.location).searchParams.get("plugin"), "github-oauth");
  assert.equal(await PluginInstallation.countDocuments({ userId }), 0);
});

test("a cancelled sign-in returns to the app without creating a connection", async () => {
  const { cookie, userId } = await signedInUser();
  const { state } = await startOAuth(cookie);
  const callback = await api(`${CALLBACK_PATH}?error=access_denied&state=${encodeURIComponent(state)}`);
  const target = new URL(callback.location);
  assert.equal(target.searchParams.get("oauth"), "error");
  assert.equal(target.searchParams.get("reason"), "cancelled");
  assert.equal(await PluginInstallation.countDocuments({ userId }), 0);
  assert.equal(gitHubCalls.filter(call => call.url.includes("login/oauth/access_token")).length, 0);
});

test("a provider-side error is labelled provider_error, not echoed verbatim", async () => {
  const { cookie, userId } = await signedInUser();
  const { state } = await startOAuth(cookie);
  const callback = await api(`${CALLBACK_PATH}?error=bad_verification_code&error_description=${encodeURIComponent(OAUTH_TOKEN)}&state=${encodeURIComponent(state)}`);
  const target = new URL(callback.location);
  assert.equal(target.searchParams.get("reason"), "provider_error");
  assert.ok(!callback.location.includes(OAUTH_TOKEN));
  assert.equal(await PluginInstallation.countDocuments({ userId }), 0);
});

test("a code the provider rejects leaves an existing connection untouched", async () => {
  const { cookie, userId } = await signedInUser();
  await connectByOAuth(cookie);
  const before = await installationOf("github-oauth", userId);

  fake.tokenStatus = 404;
  fake.tokenBody = { error: "bad_verification_code", error_description: `the code is no longer valid; token ${OAUTH_TOKEN}` };
  const { state } = await startOAuth(cookie);
  const callback = await api(`${CALLBACK_PATH}?code=expired-code&state=${encodeURIComponent(state)}`);
  const target = new URL(callback.location);
  assert.equal(target.searchParams.get("oauth"), "error");
  assert.equal(target.searchParams.get("reason"), "exchange_failed");
  assert.ok(!callback.location.includes(OAUTH_TOKEN), "provider text echoed into the URL");

  const after = await installationOf("github-oauth", userId);
  assert.equal(after.encryptedCredentials, before.encryptedCredentials);
  assert.equal(after.status, "connected");
});

test("an account that refuses the token after a successful exchange is reported honestly", async () => {
  const { cookie, userId } = await signedInUser();
  const { state } = await startOAuth(cookie);
  fake.user = { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" };
  // The stub returns the error body with a 401 the next time /user is asked.
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    if (url.hostname === "api.github.com" && url.pathname === "/user" && url.search === "") {
      gitHubCalls.push({ method: "GET", url: url.toString(), headers: init?.headers || {}, body: "" });
      return respond({ message: "Bad credentials" }, 401);
    }
    return original(input, init);
  };
  try {
    const callback = await api(`${CALLBACK_PATH}?code=test-auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(new URL(callback.location).searchParams.get("reason"), "failed");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(await PluginInstallation.countDocuments({ userId }), 0);
});

test("missing server configuration is reported by variable name, never by value", async () => {
  const { cookie } = await signedInUser();
  const saved = process.env.PLUGIN_OAUTH_GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env.PLUGIN_OAUTH_GITHUB_OAUTH_CLIENT_SECRET;
  try {
    const list = await api("/api/plugins/github", { cookie });
    assert.equal(list.json.plugin.oauth.configured, false);
    const start = await api("/api/plugins/github-oauth/oauth/start", { cookie });
    assert.equal(start.status, 501);
    assert.equal(start.json.code, "oauth_not_configured");
    assert.match(start.json.message, /sign-in app/);
    assert.ok(!start.text.includes(CLIENT_SECRET) && !start.text.includes(saved));
    const callback = await api(`${CALLBACK_PATH}?code=x&state=y`);
    assert.equal(new URL(callback.location).searchParams.get("reason"), "invalid_state");
  } finally {
    process.env.PLUGIN_OAUTH_GITHUB_OAUTH_CLIENT_SECRET = saved;
  }
});

test("repository browsing uses the signed-in token and keeps paging plus rate limits", async () => {
  const { cookie } = await signedInUser();
  await connectByOAuth(cookie);

  fake.reposLinkHeader = `<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"`;
  const repos = await api("/api/plugins/github-oauth/tools/list_repositories", { method: "POST", body: { args: { page: 1, perPage: 30 } }, cookie });
  assert.equal(repos.status, 200, repos.text);
  assert.equal(repos.json.result.nextPage, 2);
  assert.equal(repos.json.result.lastPage, 5);
  assert.equal(repos.json.result.rateLimit.remaining, 4972);
  assert.ok(repos.json.result.rateLimit.resetsAt);
  assert.equal(repos.json.result.repositories[0].defaultBranch, "main");
  assert.equal(repos.json.result.repositories[0].permissions.push, true);

  const files = await api("/api/plugins/github-oauth/tools/list_files", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo", path: "" } }, cookie });
  assert.equal(files.status, 200, files.text);
  assert.deepEqual(files.json.result.files.map(f => f.name), ["README.md"]);
  assert.deepEqual(files.json.result.folders.map(f => f.name), ["src"]);

  const file = await api("/api/plugins/github-oauth/tools/read_file", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo", path: "README.md" } }, cookie });
  assert.equal(file.json.result.content, fake.fileContent);
  assert.equal(file.json.result.binary, false);

  const branches = await api("/api/plugins/github-oauth/tools/list_branches", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo" } }, cookie });
  assert.deepEqual(branches.json.result.branches.map(b => b.name), ["main", "feature/x"]);

  const commits = await api("/api/plugins/github-oauth/tools/list_commits", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo" } }, cookie });
  assert.equal(commits.json.result.commits[0].sha, "abc123");

  const diff = await api("/api/plugins/github-oauth/tools/compare_refs", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo", base: "main", head: "feature/x" } }, cookie });
  assert.equal(diff.json.result.files[0].patch, "+hello from the fixture");

  const issues = await api("/api/plugins/github-oauth/tools/list_issues", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo" } }, cookie });
  assert.deepEqual(issues.json.result.issues.map(i => i.number), [7], "pull requests must not be listed as issues");

  const pulls = await api("/api/plugins/github-oauth/tools/list_pull_requests", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo" } }, cookie });
  assert.equal(pulls.json.result.pullRequests[0].head, "octovups:feature/x");

  const onePull = await api("/api/plugins/github-oauth/tools/read_pull_request", { method: "POST", body: { args: { owner: "octovups", repo: "demo-repo", number: 9 } }, cookie });
  assert.equal(onePull.json.result.files[0].filename, "README.md");

  const authenticated = gitHubCalls.filter(call => call.url.startsWith("https://api.github.com/repos/"));
  assert.ok(authenticated.length > 0);
  for (const call of authenticated) {
    assert.equal(call.headers.Authorization, `Bearer ${OAUTH_TOKEN}`);
    assert.equal(call.headers["X-GitHub-Api-Version"], "2022-11-28");
  }
});

test("writes need confirmation, cannot land on the default branch silently, and open a real PR", async () => {
  const { cookie } = await signedInUser();
  await connectByOAuth(cookie);
  const args = { owner: "octovups", repo: "demo-repo", path: "docs/notes.md", content: "notes", message: "Add notes", branch: "feature/x" };

  const unconfirmed = await api("/api/plugins/github-oauth/tools/write_file", { method: "POST", body: { args }, cookie });
  assert.equal(unconfirmed.status, 403);
  assert.equal(unconfirmed.json.code, "approval_required");
  assert.equal(gitHubCalls.filter(call => call.method === "PUT").length, 0);

  const defaultBranch = await api("/api/plugins/github-oauth/tools/write_file", {
    method: "POST",
    body: { confirm: true, args: { ...args, branch: "main" } },
    cookie
  });
  assert.equal(defaultBranch.status, 400, defaultBranch.text);
  assert.equal(defaultBranch.json.code, "default_branch_guard");
  assert.match(defaultBranch.json.message, /default branch/);

  const written = await api("/api/plugins/github-oauth/tools/write_file", { method: "POST", body: { confirm: true, args }, cookie });
  assert.equal(written.status, 200, written.text);
  assert.equal(written.json.result.commit, "newcommit1");
  const put = gitHubCalls.find(call => call.method === "PUT");
  assert.equal(JSON.parse(put.body).branch, "feature/x");

  const branch = await api("/api/plugins/github-oauth/tools/create_branch", {
    method: "POST",
    body: { confirm: true, args: { owner: "octovups", repo: "demo-repo", branch: "feature/y", from: "main" } },
    cookie
  });
  assert.equal(branch.status, 200, branch.text);
  assert.equal(branch.json.result.ref, "refs/heads/feature/y");

  const pull = await api("/api/plugins/github-oauth/tools/create_pull_request", {
    method: "POST",
    body: { confirm: true, args: { owner: "octovups", repo: "demo-repo", title: "Add notes", head: "feature/x", base: "main" } },
    cookie
  });
  assert.equal(pull.status, 200, pull.text);
  assert.equal(pull.json.result.number, 9);

  // The token row keeps the identical capability set for accounts that connected
  // before sign-in existed.
  const pat = await api("/api/plugins/github/install", { method: "POST", body: { token: PAT_TOKEN }, cookie });
  assert.equal(pat.status, 201, pat.text);
  const issue = await api("/api/plugins/github/tools/create_issue", {
    method: "POST",
    body: { confirm: true, args: { owner: "octovups", repo: "demo-repo", title: "fixture" } },
    cookie
  });
  assert.equal(issue.status, 200, issue.text);
  assert.equal(issue.json.result.number, 7);
});

test("only non-destructive GitHub tools are handed to the model, under both connection names", async () => {
  const { cookie } = await signedInUser();
  await connectByOAuth(cookie);
  await api("/api/plugins/github/install", { method: "POST", body: { token: PAT_TOKEN }, cookie });

  const { json } = await api("/api/plugins/tools", { cookie });
  const names = json.tools.map(tool => tool.function.name);
  const signedIn = names.filter(name => name.startsWith("plugin__github-oauth__"));
  const tokenRow = names.filter(name => name.startsWith("plugin__github__"));
  assert.ok(signedIn.length >= 11, signedIn.join(","));
  assert.ok(signedIn.includes("plugin__github-oauth__list_repositories"));
  assert.ok(signedIn.includes("plugin__github-oauth__read_file"));
  assert.ok(signedIn.includes("plugin__github-oauth__compare_refs"));
  for (const forbidden of ["write_file", "delete_file", "create_branch", "create_pull_request", "create_issue"]) {
    assert.ok(!names.includes(`plugin__github-oauth__${forbidden}`), forbidden);
    assert.ok(!names.includes(`plugin__github__${forbidden}`), forbidden);
  }
  assert.equal(tokenRow.length, signedIn.length, "both connection methods expose the same capability set");
});

test("disconnecting revokes the token at GitHub and removes the credential", async () => {
  const { cookie, userId } = await signedInUser();
  await connectByOAuth(cookie);
  const removed = await api("/api/plugins/github-oauth", { method: "DELETE", cookie });
  assert.equal(removed.status, 200, removed.text);
  const revoke = gitHubCalls.find(call => call.url.includes("/applications/"));
  assert.equal(revoke.method, "POST");
  assert.equal(JSON.parse(revoke.body).access_token, OAUTH_TOKEN);
  assert.equal(revoke.headers.Authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64")}`);
  assert.equal(await PluginInstallation.countDocuments({ userId, pluginId: "github-oauth" }), 0);
  assert.equal(await PluginOAuthState.countDocuments({ userId, pluginId: "github-oauth" }), 0);

  const after = await api("/api/plugins/github", { cookie });
  assert.equal(after.json.plugin.oauth.connection, "disconnected");
  assert.equal(after.json.plugin.oauth.account, null);
});

test("a revocation that GitHub refuses still disconnects the account", async () => {
  const { cookie, userId } = await signedInUser();
  await connectByOAuth(cookie);
  fake.revokeStatus = 502;
  const removed = await api("/api/plugins/github-oauth", { method: "DELETE", cookie });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(await PluginInstallation.countDocuments({ userId, pluginId: "github-oauth" }), 0);
  const activity = await api("/api/plugins/activity", { cookie });
  assert.ok(activity.json.activity.some(entry => entry.errorCode === "revocation_failed"));
});

test("an expired token makes the next call ask for a reconnect instead of looping", async () => {
  const { cookie, userId } = await signedInUser();
  await connectByOAuth(cookie);
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    if (url.hostname === "api.github.com" && url.pathname === "/user/repos") {
      gitHubCalls.push({ method: "GET", url: url.toString(), headers: init?.headers || {}, body: "" });
      return respond({ message: "Bad credentials" }, 401);
    }
    return original(input, init);
  };
  let response;
  try {
    response = await api("/api/plugins/github-oauth/tools/list_repositories", { method: "POST", body: { args: {} }, cookie });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(response.status, 401, response.text);
  const stored = await installationOf("github-oauth", userId);
  assert.equal(stored.status, "needs_reconnection");
  const detail = await api("/api/plugins/github", { cookie });
  assert.equal(detail.json.plugin.oauth.connection, "needs_reconnection");
  assert.ok(!detail.json.plugin.oauth.lastError.includes(OAUTH_TOKEN));
  const reconnect = await api("/api/plugins/github-oauth/tools/list_repositories", { method: "POST", body: { args: {} }, cookie });
  assert.equal(reconnect.json.code, "plugin_not_connected");
});

test("a public read without any credential still works on the token row", async () => {
  const { cookie } = await signedInUser();
  await api("/api/plugins/github/install", { method: "POST", body: {}, cookie });
  const search = await api("/api/plugins/github/tools/search_repositories", { method: "POST", body: { args: { query: "vups" } }, cookie });
  assert.equal(search.status, 200, search.text);
  assert.equal(search.json.result.results[0].fullName, "octovups/demo-repo");
  const privateList = await api("/api/plugins/github/tools/list_repositories", { method: "POST", body: { args: {} }, cookie });
  assert.equal(privateList.status, 400);
  assert.equal(privateList.json.code, "token_required");
  assert.equal((await api("/api/plugins/github", { cookie })).json.plugin.connection, "connected", "a missing token must not look like a broken connection");
});

test("the sign-in companion is reachable through both callback paths", async () => {
  const { cookie, userId } = await signedInUser();
  const { state } = await startOAuth(cookie);
  const callback = await api(`/api/plugins/github-oauth/oauth/callback?code=test-auth-code&state=${encodeURIComponent(state)}`);
  assert.equal(new URL(callback.location).searchParams.get("oauth"), "connected");
  assert.equal((await installationOf("github-oauth", userId)).status, "connected");
  const unknown = await api("/api/plugins/not-a-plugin/oauth/callback?code=x&state=y");
  assert.equal(new URL(unknown.location).searchParams.get("reason"), "unsupported_plugin");
});
