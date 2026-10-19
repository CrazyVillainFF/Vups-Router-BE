import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.ENCRYPTION_SECRET = "test-encryption-secret-with-at-least-32-chars";
process.env.PASSWORD_RESET_RATE_LIMIT_MAX = "2";
process.env.VERIFY_CODE_RATE_LIMIT_MAX = "2";
process.env.PASSWORD_RESET_ATTEMPT_LIMIT_MAX = "2";
process.env.SENDER_EMAIL = "vupriseoffical@gmail.com";
delete process.env.MONGODB_URI;

const { default: app } = await import("./index.js");
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

test("forgot-password, verify-code, and reset-password are independently rate limited per IP", async () => {
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
    assert.equal(forgotThree.status, 429, "the third forgot-password attempt must be rate limited");
    assert.match((await forgotThree.json()).message, /Too many password reset requests/);

    const verifyOne = await attempt("/api/verify-code", { email: "not-an-email", code: "000000" });
    assert.equal(verifyOne.status, 400);
    const verifyTwo = await attempt("/api/verify-code", { email: "not-an-email", code: "000000" });
    assert.equal(verifyTwo.status, 400);
    const verifyThree = await attempt("/api/verify-code", { email: "not-an-email", code: "000000" });
    assert.equal(verifyThree.status, 429, "the third verify-code attempt must be rate limited");
    assert.match((await verifyThree.json()).message, /Too many code verification attempts/);

    const resetOne = await attempt("/api/reset-password", { email: "not-an-email", code: "000000", newPassword: "short" });
    assert.equal(resetOne.status, 400);
    const resetTwo = await attempt("/api/reset-password", { email: "not-an-email", code: "000000", newPassword: "short" });
    assert.equal(resetTwo.status, 400);
    const resetThree = await attempt("/api/reset-password", { email: "not-an-email", code: "000000", newPassword: "short" });
    assert.equal(resetThree.status, 429);
    const resetThreeBody = await resetThree.json();
    assert.match(resetThreeBody.message, /Too many password reset attempts/);
    assert.doesNotMatch(JSON.stringify(resetThreeBody), /brevo|api-key|stack/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
