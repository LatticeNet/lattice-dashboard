import assert from "node:assert/strict";
import test from "node:test";

import { usePlanDigest } from "../usePlanDigest.ts";

/**
 * The case that took twenty-three approvals out of service.
 *
 * The server mutates a pending approval in place: same id, new plan, whenever
 * the thing it describes is re-rendered. A digest memoized on the id alone is
 * then sent for a plan it was not computed from, the server answers "plan
 * changed since review", and because nothing invalidated the entry, clicking
 * approve again produced the same stale digest forever.
 */
test("a plan that changes under a stable id gets a fresh digest", async () => {
  const { digestFor } = usePlanDigest();

  const first = await digestFor({ id: "approval_1", plan: "PLAN A" });
  const second = await digestFor({ id: "approval_1", plan: "PLAN B" });

  assert.notEqual(first, second, "the digest must follow the plan, not the id");
  assert.equal(second, await digestFor({ id: "approval_1", plan: "PLAN B" }));
});

test("an unchanged plan is still served from the memo", async () => {
  const { digestFor, cache } = usePlanDigest();

  const a = await digestFor({ id: "approval_2", plan: "SAME" });
  const b = await digestFor({ id: "approval_2", plan: "SAME" });

  assert.equal(a, b);
  assert.equal(cache.value["approval_2"], a, "the reactive cache still exposes the digest by id");
});

test("the cached digest matches a plain hash of the same bytes", async () => {
  const { digestFor, digestHex } = usePlanDigest();
  assert.equal(await digestFor({ id: "x", plan: "body" }), await digestHex("body"));
});

test("a missing plan hashes as the empty string, as it always did", async () => {
  const { digestFor, digestHex } = usePlanDigest();
  const empty = await digestHex("");
  assert.equal(await digestFor({ id: "n1", plan: null }), empty);
  assert.equal(await digestFor({ id: "n2" }), empty);
});
