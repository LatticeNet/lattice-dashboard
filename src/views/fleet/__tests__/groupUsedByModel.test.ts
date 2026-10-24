import assert from "node:assert/strict";
import { test } from "node:test";

import { groupUseCount, groupUseSections } from "../groupUsedByModel.ts";

test("every kind is listed in a fixed order, empty ones included", () => {
  const sections = groupUseSections([
    { kind: "outbound_policy", id: "gnp_b", label: "web egress", role: "target" },
    { kind: "outbound_policy", id: "gnp_a", label: "db access", role: "remote" },
  ]);
  assert.deepEqual(sections.map((s) => s.kind), ["check", "outbound_policy", "security_group_binding", "mesh_rule"]);
  assert.deepEqual(sections[1]!.uses.map((u) => u.label), ["db access", "web egress"]);
  assert.equal(sections[0]!.uses.length, 0);
});

test("a kind the server adds later is listed after the known ones", () => {
  const sections = groupUseSections([{ kind: "agent_rollout" as never, id: "r1", label: "batch 1", role: "target" }]);
  assert.equal(sections.at(-1)!.kind, "agent_rollout");
});

test("the count includes uses this session cannot see", () => {
  assert.equal(groupUseCount([{ kind: "outbound_policy", id: "x", label: "x", role: "target" }], 2), 3);
  assert.equal(groupUseCount([], 0), 0);
});
