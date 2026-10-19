import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.PASSWORD_RESET_RATE_LIMIT_MAX = "2";
process.env.PASSWORD_RESET_ATTEMPT_LIMIT_MAX = "2";
process.env.PASSWORD_RESET_PEPPER = "test-password-reset-pepper-with-32-plus-characters";
process.env.SENDER_EMAIL = "vupriseoffical@gmail.com";
process.env.CLIENT_URL = "http://localhost:5173";
delete process.env.MONGODB_URI;

const { default: app } = await import("./index.js");
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

test("forgot-password and reset-password are rate limited per IP", async () => {
  const attempt = (path, body) => fetch(`${baseURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  try {
    const forgotOne = await attempt("/api/forgot-password", { email: "not-an-email" });
    assert.equal(forgotOne.status, 400);
    const forgotTwo = await attempt("/api/forgot-password", { email: "not-an-email" });
    assert.equal(forgotTwo.status, 400);
    const forgotThree = await attempt("/api/forgot-password", { email: "not-an-email" });
    assert.equal(forgotThree.status, 429, "the third attempt must be rate limited");
    const limited = await forgotThree.json();
    assert.match(limited.message, /Too many password reset requests/);

    // The two endpoints have independent limits.
    const resetOne = await attempt("/api/reset-password", { token: "x", newPassword: "y", confirmPassword: "y" });
    assert.equal(resetOne.status, 400);
    const resetTwo = await attempt("/api/reset-password", { token: "x", newPassword: "y", confirmPassword: "y" });
    assert.equal(resetTwo.status, 400);
    const resetThree = await attempt("/api/reset-password", { token: "x", newPassword: "y", confirmPassword: "y" });
    assert.equal(resetThree.status, 429);

    const errorBody = JSON.stringify(await resetThree.json());
    assert.doesNotMatch(errorBody, /pepper|api-key|brevo|stack/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
