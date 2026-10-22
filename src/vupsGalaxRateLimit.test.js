import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.VUPS_CHAT_RATE_LIMIT_MAX = "2";

const express = (await import("express")).default;
const { vupsGalaxRateLimiter } = await import("./middleware.js");

const app = express();
app.use((req, _res, next) => {
  req.userId = req.get("x-test-user") || "anonymous";
  next();
});
app.post("/api/chat/vups-v3-galax", vupsGalaxRateLimiter, (_req, res) => res.json({ ok: true }));

const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
});

function post(user) {
  return fetch(`${baseURL}/api/chat/vups-v3-galax`, {
    method: "POST",
    headers: { "x-test-user": user }
  });
}

test("Vups v3 Galax rate limit is separate per authenticated user and preserves per-IP limits", async () => {
  assert.equal((await post("alice")).status, 200);
  assert.equal((await post("alice")).status, 200);
  const blocked = await post("alice");
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.match(body.message, /Too many Vups v3 Galax requests/);

  assert.equal((await post("bob")).status, 200, "another signed-in user on the same IP gets its own bucket");
});
