import assert from "node:assert/strict";
import { test } from "node:test";

import { afterReferenceChange, onReferenceChange } from "../referenceChanges.ts";

// Design 32 S3b: a group's Used by and a node's Network section read again
// after this session's own write to an object that names them, and only
// once that write has landed.
test("a write tells the listeners its kind once it succeeded, and never when it failed", async () => {
  const heard: string[] = [];
  const stop = onReferenceChange((kind) => heard.push(kind));

  assert.equal(await afterReferenceChange("outbound_policy", Promise.resolve("saved")), "saved");
  assert.deepEqual(heard, ["outbound_policy"]);

  await assert.rejects(afterReferenceChange("check", Promise.reject(new Error("409 version_conflict"))), /version_conflict/);
  assert.deepEqual(heard, ["outbound_policy"], "a refused save changed nothing to read again");

  stop();
  await afterReferenceChange("group", Promise.resolve(undefined));
  assert.deepEqual(heard, ["outbound_policy"], "a closed view stops listening");
});
