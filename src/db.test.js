import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDatabaseError, isDatabaseFailure, safeDatabaseErrorText } from "./db.js";

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

test("describes a malformed connection string as invalid_uri", () => {
  const error = new Error('Invalid scheme, expected connection string to start with "mongodb://" or "mongodb+srv://"');
  error.name = "MongoParseError";
  const result = describeDatabaseError(error);
  assert.equal(result.reason, "invalid_uri");
  assert.match(result.hint, /Percent-encode/i);
});

test("redacts credentials from logged database errors", () => {
  const error = new Error("Failed mongodb+srv://app:sup3r-secret@cluster0.example.net/vupsrouter?password=sup3r-secret");
  error.name = "MongoServerSelectionError";
  const text = safeDatabaseErrorText(error);
  assert.doesNotMatch(text, /sup3r-secret/);
  assert.match(text, /\[redacted\]/);
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

test("classifies only confirmed database failures as database failures", () => {
  const notConfigured = new Error("Database is not configured.");
  assert.equal(isDatabaseFailure(notConfigured), true);

  const selection = new Error("Server selection timed out after 10000 ms");
  selection.name = "MongooseServerSelectionError";
  assert.equal(isDatabaseFailure(selection), true);

  const network = new Error("connect ECONNREFUSED 127.0.0.1:27017");
  network.name = "MongoNetworkError";
  assert.equal(isDatabaseFailure(network), true);

  const parseError = new Error('Invalid scheme, expected connection string to start with "mongodb://"');
  parseError.name = "MongoParseError";
  assert.equal(isDatabaseFailure(parseError), true);

  const duplicate = new Error("E11000 duplicate key error collection: vupsrouter.users index: email_1");
  duplicate.name = "MongoServerError";
  assert.equal(isDatabaseFailure(duplicate), true);

  const buffering = new Error("Operation `appsettings.findOne()` buffering timed out after 10000ms");
  buffering.name = "MongooseError";
  assert.equal(isDatabaseFailure(buffering), true, "a buffering timeout is a real database connectivity failure");
});

test("never classifies provider, HTTP, or validation errors as database failures", () => {
  const providerError = new Error("The provider rejected your API key (HTTP 401).");
  providerError.name = "ProviderError";
  assert.equal(isDatabaseFailure(providerError), false);

  const castError = new Error("Cast to ObjectId failed for value \"nope\"");
  castError.name = "CastError";
  assert.equal(isDatabaseFailure(castError), false);

  const validation = new Error("Conversation validation failed");
  validation.name = "ValidationError";
  assert.equal(isDatabaseFailure(validation), false);

  const genericMongoose = new Error("Parameter \"filter\" to findOne() must be an object");
  genericMongoose.name = "MongooseError";
  assert.equal(isDatabaseFailure(genericMongoose), false, "generic Mongoose operation errors are not outages");

  assert.equal(isDatabaseFailure(new Error("socket hang up")), false);
  assert.equal(isDatabaseFailure(undefined), false);
  assert.equal(isDatabaseFailure({}), false);
});
