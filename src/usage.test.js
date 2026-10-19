import assert from "node:assert/strict";
import { test } from "node:test";

const { acquireSlot, releaseSlot, activeSlotCount, dailyQuota, maxConcurrency } = await import("./usage.js");

test("concurrency slots are bounded per user and released independently", () => {
  process.env.AI_MAX_CONCURRENCY = "2";
  try {
    assert.equal(acquireSlot("user-a"), true);
    assert.equal(acquireSlot("user-a"), true);
    assert.equal(acquireSlot("user-a"), false);
    assert.equal(acquireSlot("user-b"), true);
    releaseSlot("user-a");
    assert.equal(acquireSlot("user-a"), true);
    assert.equal(activeSlotCount("user-a"), 2);
    releaseSlot("user-a");
    releaseSlot("user-a");
    releaseSlot("user-a");
    releaseSlot("user-b");
    assert.equal(activeSlotCount("user-a"), 0);
    assert.equal(activeSlotCount("user-b"), 0);
  } finally {
    delete process.env.AI_MAX_CONCURRENCY;
  }
});

test("quota and concurrency configuration falls back to safe defaults", () => {
  delete process.env.AI_DAILY_QUOTA;
  delete process.env.AI_MAX_CONCURRENCY;
  assert.equal(dailyQuota(), 100);
  assert.equal(maxConcurrency(), 3);
  process.env.AI_DAILY_QUOTA = "0";
  process.env.AI_MAX_CONCURRENCY = "not-a-number";
  assert.equal(dailyQuota(), 100);
  assert.equal(maxConcurrency(), 3);
  delete process.env.AI_DAILY_QUOTA;
  delete process.env.AI_MAX_CONCURRENCY;
});
