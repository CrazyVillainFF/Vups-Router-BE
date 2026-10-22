import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoMemoryServer } from "mongodb-memory-server";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercelOrigin = "https://vups-router-three.vercel.app";
const mongo = await MongoMemoryServer.create();
const mongoUri = mongo.getUri("vupsrouter");

function startServer({ port, nodeEnv, extraEnv = {} }) {
  const logs = [];
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      PORT: String(port),
      MONGODB_URI: mongoUri,
      JWT_SECRET: process.env.JWT_SECRET || "verify-jwt-secret-with-at-least-32-characters",
      ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET || "verify-encryption-secret-with-32-chars-min",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => logs.push(String(chunk)));
  child.stderr.on("data", chunk => logs.push(String(chunk)));
  return { child, logs };
}

async function waitForHealth(baseURL, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) return response;
    } catch {
      // server not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

function makeClient(baseURL, defaultOrigin) {
  return async function request(pathname, options = {}) {
    const response = await fetch(`${baseURL}${pathname}`, {
      ...options,
      headers: {
        Origin: defaultOrigin,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  };
}

async function verifyDevelopmentFlow() {
  const { child, logs } = startServer({ port: 4321, nodeEnv: "development" });
  const request = makeClient("http://127.0.0.1:4321", "http://localhost:5173");
  try {
    const health = await waitForHealth("http://127.0.0.1:4321");
    assert.ok(health, `dev server never became healthy:\n${logs.join("")}`);
    assert.equal((await health.json()).database, "connected");
    console.log("[ok] dev: GET  /api/health → 200, database connected");

    const signup = await request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Verify User", email: "verify@example.com", password: "correct-horse-battery" })
    });
    assert.equal(signup.response.status, 201);
    assert.equal(signup.body.user.email, "verify@example.com");
    const cookie = signup.response.headers.getSetCookie()[0].split(";")[0];
    console.log("[ok] dev: POST /api/auth/signup → 201, user created");

    const duplicate = await request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Verify User", email: "verify@example.com", password: "correct-horse-battery" })
    });
    assert.equal(duplicate.response.status, 409);
    console.log("[ok] dev: POST /api/auth/signup (duplicate) → 409");

    const wrongPassword = await request("/api/auth/signin", {
      method: "POST",
      body: JSON.stringify({ email: "verify@example.com", password: "wrong-password-123" })
    });
    assert.equal(wrongPassword.response.status, 401);
    console.log("[ok] dev: POST /api/auth/signin (wrong password) → 401");

    const signin = await request("/api/auth/signin", {
      method: "POST",
      body: JSON.stringify({ email: "verify@example.com", password: "correct-horse-battery" })
    });
    assert.equal(signin.response.status, 200);
    console.log("[ok] dev: POST /api/auth/signin → 200, session established");

    const me = await request("/api/auth/me", { headers: { Cookie: cookie } });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.user.email, "verify@example.com");
    console.log("[ok] dev: GET  /api/auth/me (session cookie) → 200, correct user");

    const anonymous = await request("/api/auth/me");
    assert.equal(anonymous.response.status, 401);
    console.log("[ok] dev: GET  /api/auth/me (no cookie) → 401");

    const logout = await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    assert.equal(logout.response.status, 200);
    console.log("[ok] dev: POST /api/auth/logout → 200");
  } finally {
    child.kill();
  }
}

async function verifyProductionFlow() {
  const branchOrigin = "https://vups-router-git-main-vishnu-4571.vercel.app";
  const { child, logs } = startServer({
    port: 4322,
    nodeEnv: "production",
    extraEnv: { CLIENT_ORIGIN_PATTERNS: "https://vups-router-*-vishnu-4571.vercel.app" }
  });
  const request = makeClient("http://127.0.0.1:4322", vercelOrigin);
  try {
    const health = await waitForHealth("http://127.0.0.1:4322");
    assert.ok(health, `production server never became healthy:\n${logs.join("")}`);
    assert.equal((await health.json()).database, "connected");
    console.log("[ok] prod: GET  /api/health → 200, database connected");

    const preflight = await fetch("http://127.0.0.1:4322/api/auth/signup", {
      method: "OPTIONS",
      headers: {
        Origin: vercelOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), vercelOrigin);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
    console.log(`[ok] prod: OPTIONS preflight allows ${vercelOrigin} with credentials`);

    const branchPreflight = await fetch("http://127.0.0.1:4322/api/auth/signin", {
      method: "OPTIONS",
      headers: {
        Origin: branchOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
      }
    });
    assert.equal(branchPreflight.status, 204);
    assert.equal(branchPreflight.headers.get("access-control-allow-origin"), branchOrigin);
    assert.equal(branchPreflight.headers.get("access-control-allow-credentials"), "true");
    console.log(`[ok] prod: OPTIONS preflight allows pattern-matched alias ${branchOrigin} with credentials`);

    const index = await request("/api");
    assert.equal(index.response.status, 200);
    assert.equal(index.body.health, "/api/health");
    console.log("[ok] prod: GET  /api → 200 API index (no misleading 404)");

    const signup = await request("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "Prod User", email: "prod@example.com", password: "correct-horse-battery" })
    });
    assert.equal(signup.response.status, 201);
    const setCookie = signup.response.headers.getSetCookie()[0];
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=604800/i);
    assert.doesNotMatch(setCookie, /Partitioned/i);
    console.log("[ok] prod: signup Set-Cookie is HttpOnly; Secure; SameSite=Lax; Max-Age=604800");

    const me = await request("/api/auth/me", {
      headers: { Cookie: setCookie.split(";")[0] }
    });
    assert.equal(me.response.status, 200);
    console.log("[ok] prod: session cookie authenticates GET /api/auth/me");

    const blocked = await request("/api/auth/signup", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
      body: JSON.stringify({ name: "Evil", email: "evil@example.com", password: "correct-horse-battery" })
    });
    assert.equal(blocked.response.status, 403);
    console.log("[ok] prod: POST from unknown origin → 403");
  } finally {
    child.kill();
  }
}

let failed = false;
try {
  await verifyDevelopmentFlow();
  console.log("");
  await verifyProductionFlow();
  console.log("\nAll backend checks passed (development + production).");
} catch (error) {
  failed = true;
  console.error(`\nVerification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongo.stop();
  if (!failed) console.log("(verification MongoDB stopped; real config in server/.env is untouched)");
}
