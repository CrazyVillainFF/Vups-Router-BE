import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SAVE_WARNING_MESSAGE,
  hasTerminalEvent,
  resolveTerminalEvent,
  saveWarningFor,
  writeSseEvent
} from "./chatTerminal.js";

function fakeRes() {
  return {
    writableEnded: false,
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk);
    }
  };
}

function eventTypes(res) {
  return res.chunks.map(chunk => JSON.parse(chunk.replace(/^data: /, "")).type);
}

test("a genuine generation failure is the single terminal error", () => {
  const terminal = resolveTerminalEvent({ failure: { code: "stream_error" } });
  assert.deepEqual(terminal, { type: "error", saveWarning: null });
});

test("artifact persistence failure after a complete answer is done with a save warning", () => {
  const terminal = resolveTerminalEvent({
    artifactError: { code: "artifact_persist_failed" }
  });
  assert.equal(terminal.type, "done");
  assert.equal(terminal.saveWarning.code, "artifact_persist_failed");
  assert.equal(terminal.saveWarning.message, SAVE_WARNING_MESSAGE);
});

test("conversation persistence failure after a complete answer is done with a save warning", () => {
  const terminal = resolveTerminalEvent({
    persistFailure: { code: "persist_failed" }
  });
  assert.equal(terminal.type, "done");
  assert.equal(terminal.saveWarning.code, "persist_failed");
});

test("a completed answer with no save problem is a plain done", () => {
  assert.deepEqual(resolveTerminalEvent({}), { type: "done", saveWarning: null });
});

test("a client abort produces no terminal event", () => {
  assert.deepEqual(resolveTerminalEvent({ clientAborted: true }), { type: "none", saveWarning: null });
});

test("save warnings never expose provider or database detail", () => {
  const warning = saveWarningFor({
    code: "artifact_persist_failed",
    message: "MongoServerError: E11000 duplicate key error collection"
  });
  assert.equal(warning.message, SAVE_WARNING_MESSAGE);
  assert.doesNotMatch(JSON.stringify(warning), /Mongo|duplicate|E11000/i);
});

test("the SSE writer refuses every event after a done event", () => {
  const res = fakeRes();
  assert.equal(writeSseEvent(res, { type: "progress", message: "Generating…" }), true);
  assert.equal(writeSseEvent(res, { type: "done", finishReason: "stop" }), true);
  assert.equal(writeSseEvent(res, { type: "error", code: "stream_error" }), false);
  assert.equal(writeSseEvent(res, { type: "done", finishReason: "stop" }), false);
  assert.deepEqual(eventTypes(res), ["progress", "done"]);
  assert.equal(hasTerminalEvent(res), true);
});

test("the SSE writer refuses every event after an error event", () => {
  const res = fakeRes();
  assert.equal(writeSseEvent(res, { type: "error", code: "stream_error" }), true);
  assert.equal(writeSseEvent(res, { type: "done", finishReason: "stop" }), false);
  assert.deepEqual(eventTypes(res), ["error"]);
});

test("the SSE writer never writes to a closed response", () => {
  const res = fakeRes();
  res.writableEnded = true;
  assert.equal(writeSseEvent(res, { type: "done" }), false);
  assert.deepEqual(res.chunks, []);
});

test("the standard chat route declares clientAborted in its own scope", () => {
  const source = readFileSync(new URL("./routes/chat.js", import.meta.url), "utf8");
  const standardStart = source.indexOf('router.post("/", requireAuth');
  assert.ok(standardStart > 0, "standard chat route must exist");
  const standardRoute = source.slice(standardStart);
  assert.match(standardRoute, /let clientAborted = false;/);
});

test("neither streaming route sends an error event for a save failure", () => {
  const source = readFileSync(new URL("./routes/chat.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /type: "error",\s*\n\s*message: artifactError\.message/);
  assert.equal((source.match(/saveWarning: terminal\.saveWarning/g) || []).length, 2);
  assert.equal((source.match(/persistFailure = new ProviderError/g) || []).length, 2);
});
