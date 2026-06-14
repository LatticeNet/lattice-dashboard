import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import { approvalById, approvalPayload, sha256Hex } from "./approval.js";

test("sha256Hex hashes the exact plan text", async () => {
  assert.equal(
    await sha256Hex("abc", webcrypto.subtle),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("approvalPayload binds queue apply to the reviewed plan hash", async () => {
  const payload = await approvalPayload({ id: "approval_1", plan: "line1\nline2\n" }, webcrypto.subtle);
  assert.deepEqual(payload, {
    approval_id: "approval_1",
    queue_apply: true,
    plan_sha256: await sha256Hex("line1\nline2\n", webcrypto.subtle),
  });
});

test("approvalPayload rejects missing approval state", async () => {
  await assert.rejects(() => approvalPayload(null, webcrypto.subtle), /Approval not found/);
});

test("approvalById finds the visible approval state", () => {
  const approvals = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(approvalById(approvals, "b"), { id: "b" });
  assert.equal(approvalById(approvals, "missing"), null);
});
