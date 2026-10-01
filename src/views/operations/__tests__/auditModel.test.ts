import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTokens, readTokenQuery } from "../../../lib/queryTokens.ts";
import { AUDIT_GRAMMAR, auditRequest, auditScan, changesExclusions, exclusionsIgnored, readStoredVerify } from "../auditModel.ts";

const tokens = (text: string) => parseTokens(text, AUDIT_GRAMMAR, { node: { toId: (v) => (v === "[cd]-DMIT-2" ? "node_dmit2" : undefined) } });

test("Changes hides node flips and observe events inside the server's scan", () => {
  const params = auditRequest({ layer: "changes", tokens: tokens(""), window: { from: "2026-09-29T12:00:00.000Z" }, offset: 0 });
  assert.deepEqual(params, {
    limit: 50,
    offset: 0,
    at_from: "2026-09-29T12:00:00.000Z",
    exclude_action: "node.online,node.offline",
    exclude_decision: "observe",
  });
});

test("All events sends the question as asked, keys mapped to the server's parameters", () => {
  const params = auditRequest({
    layer: "all",
    tokens: tokens("node:[cd]-DMIT-2 actor:cdcd action:task.* decision:deny scope:task:run trace:req_9zk sudo"),
    window: {},
    offset: 50,
  });
  assert.deepEqual(params, {
    limit: 50,
    offset: 50,
    node_id: "node_dmit2",
    actor_id: "cdcd",
    action: "task.*",
    decision: "deny",
    scope: "task:run",
    correlation_id: "req_9zk",
    q: "sudo",
  });
});

test("a question about flips or observe events is answered in Changes, not emptied", () => {
  assert.deepEqual(changesExclusions(tokens("action:node.offline")), { exclude_decision: "observe" });
  assert.deepEqual(changesExclusions(tokens("action:node.*")), { exclude_decision: "observe" });
  assert.deepEqual(changesExclusions(tokens("decision:observe")), { exclude_action: "node.online,node.offline" });
  assert.deepEqual(changesExclusions(tokens("action:task.create")), { exclude_action: "node.online,node.offline", exclude_decision: "observe" });
});

test("the address holds the server's own keys", () => {
  const read = readTokenQuery({ node_id: "node_dmit2", correlation_id: "req_1", q: "x" }, AUDIT_GRAMMAR);
  assert.deepEqual(read.values, { node: "node_dmit2", trace: "req_1" });
  assert.equal(read.text, "x");
});

test("the scan says whether the count is whole", () => {
  assert.equal(auditScan(undefined), null);
  assert.deepEqual(auditScan({ total: 412, scanned: 5760, complete: true }), { kind: "complete", total: 412, scanned: 5760 });
  assert.deepEqual(auditScan({ total: 50000, scanned: 200000, complete: false }), { kind: "capped", total: 50000, scanned: 200000 });
  assert.deepEqual(auditScan({ total: 12 }), { kind: "unknown", total: 12 });
});

test("a stored verify result is read only when it is whole", () => {
  assert.equal(readStoredVerify(null), null);
  assert.equal(readStoredVerify("{"), null);
  assert.equal(readStoredVerify(JSON.stringify({ at: "yesterday", enabled: true })), null);
  assert.deepEqual(readStoredVerify(JSON.stringify({ at: "2026-09-30T09:00:00Z", enabled: true, ok: true, count: 230000 })), {
    at: "2026-09-30T09:00:00Z",
    enabled: true,
    ok: true,
    count: 230000,
  });
});

test("rows the request excluded mean the server ignored the exclusion", () => {
  const sent = { exclude_action: "node.online,node.offline", exclude_decision: "observe" };
  const change = { action: "approval.approve", decision: "allow" };
  assert.equal(exclusionsIgnored(sent, [change]), false);
  assert.equal(exclusionsIgnored(sent, [change, { action: "node.offline", decision: "allow" }]), true);
  assert.equal(exclusionsIgnored(sent, [{ action: "auth.login.prompt", decision: "observe" }]), true);
  assert.equal(exclusionsIgnored({ exclude_action: "task.*" }, [{ action: "task.create", decision: "allow" }]), true);
  // Nothing excluded (All events): nothing can be ignored.
  assert.equal(exclusionsIgnored({}, [{ action: "node.offline", decision: "observe" }]), false);
});
