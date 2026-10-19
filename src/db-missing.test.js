import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.MONGODB_URI = "";

const { default: app } = await import("./index.js");

test("health reports a degraded service when MongoDB is not configured", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${baseURL}/api/health`);
    const body = await health.json();
    assert.equal(health.status, 503);
    assert.equal(body.database, "disconnected");
    assert.doesNotMatch(JSON.stringify(body), /mongodb(?:\+srv)?:\/\/|password|credential|secret|cluster/i);

    const signup = await fetch(`${baseURL}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alex", email: "alex@example.com", password: "correct-horse-battery" })
    });
    assert.equal(signup.status, 503);
    const signupBody = await signup.json();
    assert.match(signupBody.message, /database is not configured/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
