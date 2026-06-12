import test from "node:test";
import assert from "node:assert/strict";

import { auditCorrelationFilters, auditDetailRows, auditPath, normalizeAuditResponse, nextAuditOffset } from "./audit.js";

test("auditPath builds a bounded filtered query", () => {
  const path = auditPath({
    action: "task.result",
    decision: "deny",
    node_id: "node-a",
    correlation_id: "req abc",
    limit: 16,
    offset: 32,
  });

  assert.equal(
    path,
    "/api/audit?action=task.result&decision=deny&node_id=node-a&correlation_id=req+abc&limit=16&offset=32",
  );
});

test("auditPath omits empty filters and clamps pagination", () => {
  assert.equal(auditPath({ action: " ", limit: 0, offset: -4 }), "/api/audit?limit=16&offset=0");
});

test("normalizeAuditResponse keeps legacy array responses compatible", () => {
  const out = normalizeAuditResponse([{ id: "audit-a" }, { id: "audit-b" }], { limit: 16, offset: 0 });

  assert.deepEqual(out, {
    events: [{ id: "audit-a" }, { id: "audit-b" }],
    total: 2,
    limit: 16,
    offset: 0,
  });
});

test("normalizeAuditResponse reads paged envelope responses", () => {
  const out = normalizeAuditResponse({ events: [{ id: "audit-a" }], total: 42, limit: 1, offset: 2 }, { limit: 16, offset: 0 });

  assert.deepEqual(out, {
    events: [{ id: "audit-a" }],
    total: 42,
    limit: 1,
    offset: 2,
  });
});

test("nextAuditOffset steps by page size and caps at the last page boundary", () => {
  assert.equal(nextAuditOffset({ offset: 0, limit: 16, total: 17 }, 1), 16);
  assert.equal(nextAuditOffset({ offset: 16, limit: 16, total: 17 }, 1), 16);
  assert.equal(nextAuditOffset({ offset: 16, limit: 16, total: 42 }, 1), 32);
  assert.equal(nextAuditOffset({ offset: 32, limit: 16, total: 42 }, -1), 16);
  assert.equal(nextAuditOffset({ offset: 0, limit: 16, total: 42 }, -1), 0);
});

test("auditDetailRows exposes non-secret audit context with sorted metadata", () => {
  const rows = auditDetailRows({
    id: "audit_1",
    actor_id: "user_admin",
    token_id: "token_1",
    node_id: "node-a",
    scope: "task:run",
    reason: "invalid task lease",
    correlation_id: "req_1",
    metadata: {
      task_id: "task_1",
      approval_id: "approval_1",
    },
  });

  assert.deepEqual(rows, [
    ["audit id", "audit_1"],
    ["actor", "user_admin"],
    ["token", "token_1"],
    ["node", "node-a"],
    ["scope", "task:run"],
    ["reason", "invalid task lease"],
    ["request id", "req_1"],
    ["metadata.approval_id", "approval_1"],
    ["metadata.task_id", "task_1"],
  ]);
});

test("auditDetailRows redacts sensitive metadata values", () => {
  const rows = auditDetailRows({
    metadata: {
      public_id: "pub_1",
      api_token: "secret-token",
      password: "secret-password",
      private_key: "secret-key",
    },
  });

  assert.deepEqual(rows, [
    ["metadata.api_token", "[redacted]"],
    ["metadata.password", "[redacted]"],
    ["metadata.private_key", "[redacted]"],
    ["metadata.public_id", "pub_1"],
  ]);
});

test("auditCorrelationFilters builds a request-id trace filter", () => {
  assert.deepEqual(auditCorrelationFilters({ correlation_id: " req_abc " }), {
    action: "",
    decision: "",
    node_id: "",
    correlation_id: "req_abc",
  });
  assert.equal(auditCorrelationFilters({}), null);
});
