import test from "node:test";
import assert from "node:assert/strict";
import { applyContinuationFile } from "./codeArtifacts.js";

// Mongoose subdocuments keep fields behind getters, so a plain spread yields
// no path/content. This mimics that shape.
function mongooseLike(fields) {
  return Object.create({ toObject: () => ({ ...fields }) });
}

test("continuation merges saved subdocuments without losing their paths", () => {
  const artifact = {
    files: [
      mongooseLike({ path: "index.html", language: "html", content: "<main>Hello</main>", bytes: 19, complete: true }),
      mongooseLike({ path: "app.js", language: "js", content: 'const message = "hello', bytes: 22, complete: false })
    ]
  };
  const updated = applyContinuationFile(artifact, "app.js", ' world";', { complete: true });
  assert.equal(updated.file.path, "app.js");
  assert.equal(updated.file.content, 'const message = "hello world";');
  assert.equal(updated.file.complete, true);
  assert.deepEqual(updated.files.map(file => file.path), ["index.html", "app.js"]);
});

test("continuation reports a missing target file instead of crashing", () => {
  const artifact = { files: [mongooseLike({ path: "app.js", content: "x", complete: false })] };
  assert.throws(
    () => applyContinuationFile(artifact, "missing.js", "y"),
    error => error.code === "continuation_unavailable"
  );
});
