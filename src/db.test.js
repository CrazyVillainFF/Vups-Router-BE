import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDatabaseError } from "./db.js";

test("describes a missing MONGODB_URI as not_configured", () => {
  const result = describeDatabaseError(new Error("Database is not configured."));
  assert.equal(result.reason, "not_configured");
  assert.match(result.hint, /MONGODB_URI/);
});

test("describes a rejected Atlas user as auth_failed", () => {
  const error = new Error("Authentication failed.");
  error.name = "MongoServerError";
  const result = describeDatabaseError(error);
  assert.equal(result.reason, "auth_failed");
  assert.match(result.hint, /username/i);
});

test("describes an unresolvable host as dns_error", () => {
  const error = new Error("getaddrinfo ENOTFOUND ac-abcde.mongodb.net");
  error.name = "MongoNetworkError";
  const result = describeDatabaseError(error);
  assert.equal(result.reason, "dns_error");
});

test("describes a server selection failure as timeout", () => {
  const error = new Error("Server selection timed out after 10000 ms");
  error.name = "MongooseServerSelectionError";
  error.reason = {
    type: "ReplicaSetNoPrimary",
    servers: new Map([["db.example:27017", { error: new Error("connect ETIMEDOUT 10.0.0.1:27017") }]])
  };
  const result = describeDatabaseError(error);
  assert.equal(result.reason, "timeout");
  assert.match(result.hint, /Network Access/i);
});

test("describes a refused connection as unreachable", () => {
  const error = new Error("connect ECONNREFUSED 127.0.0.1:27017");
  error.name = "MongoNetworkError";
  const result = describeDatabaseError(error);
  assert.equal(result.reason, "unreachable");
});

test("falls back to a generic reason without echoing the raw error text", () => {
  const secret = "mongodb+srv://admin:sup3r-password@cluster0.example.net/vupsrouter";
  const result = describeDatabaseError(new Error(`Failed to connect to ${secret}`));
  assert.equal(result.reason, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /sup3r-password|cluster0\.example\.net|mongodb\+srv/i);
  assert.deepEqual(Object.keys(result).sort(), ["hint", "reason"]);
});

test("describes unusual error shapes without throwing", () => {
  assert.equal(describeDatabaseError(undefined).reason, "unavailable");
  assert.equal(describeDatabaseError({}).reason, "unavailable");
  assert.equal(describeDatabaseError({ reason: { servers: null } }).reason, "unavailable");
});
