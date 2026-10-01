import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTokens } from "../../../lib/queryTokens.ts";
import type { ApprovalView } from "../../../lib/api/types.ts";
import {
  APPROVAL_HISTORY_GRAMMAR,
  defaultApprovalLayer,
  historyRequest,
  legacyApprovalQuery,
  normalizeApprovalPage,
} from "../approvalsPageModel.ts";

const tokens = (text: string) =>
  parseTokens(text, APPROVAL_HISTORY_GRAMMAR, { node: { toId: (v) => (v === "[cd]-DMIT-2" ? "node_dmit2" : undefined) } });

const row = (over: Partial<ApprovalView>): ApprovalView => ({ id: "a", node_id: "n1", plugin: "vpn-core", action: "apply-lines", status: "applied", ...over });

test("a bare address opens Needs you when it has items, History when it has none, and waits for the read", () => {
  assert.equal(defaultApprovalLayer({ needs: 3, read: true, failed: false }), "needs");
  assert.equal(defaultApprovalLayer({ needs: 0, read: true, failed: false }), "history");
  assert.equal(defaultApprovalLayer({ needs: 0, read: false, failed: false }), null);
  // A failed inbox read opens where the failure is said, not on History.
  assert.equal(defaultApprovalLayer({ needs: 0, read: false, failed: true }), "needs");
});

test("a history question is one listing call with the server's own parameters", () => {
  const params = historyRequest({
    tokens: tokens("status:applied,rejected plugin:vpn-core node:[cd]-DMIT-2"),
    window: { from: "2026-09-23T00:00:00.000Z" },
    offset: 50,
  });
  assert.deepEqual(params, {
    limit: 50,
    offset: 50,
    status: "applied,rejected",
    plugin: "vpn-core",
    node_id: "node_dmit2",
    since: "2026-09-23T00:00:00.000Z",
  });
});

test("asking for dismissed plans by status asks for the tombstones too", () => {
  const params = historyRequest({ tokens: tokens("status:dismissed"), window: {}, offset: 0 });
  assert.equal(params.include_dismissed, true);
});

test("there is no actor key: actor: is free text the field reports, never a filter", () => {
  const parsed = tokens("actor:cdcd");
  assert.deepEqual(parsed.values, {});
  assert.equal(parsed.text, "actor:cdcd");
});

test("an older server's bare array is filtered and paged by the console", () => {
  const rows = [
    row({ id: "a1", status: "applied", plugin: "vpn-core" }),
    row({ id: "a2", status: "rejected" }),
    row({ id: "a3", status: "applied", plugin: "netguard" }),
    row({ id: "a4", status: "dismissed" }),
  ];
  const page = normalizeApprovalPage(rows, { status: "applied", limit: 1, offset: 1 });
  assert.deepEqual(page.approvals.map((r) => r.id), ["a3"]);
  assert.equal(page.total, 2);
  assert.equal(page.serverFiltered, false);
  // Tombstones stay hidden unless asked for, as the server hides them.
  assert.equal(normalizeApprovalPage(rows, { limit: 50, offset: 0 }).total, 3);
});

test("a filtering server's envelope is taken as it is", () => {
  const response = { approvals: [row({ id: "a1" })], total: 1144, limit: 50, offset: 0 };
  assert.deepEqual(normalizeApprovalPage(response, { status: "applied", limit: 50, offset: 0 }), { approvals: response.approvals, total: 1144, serverFiltered: true });
});

test("old links land on the sheet and the layer they meant", () => {
  assert.deepEqual(legacyApprovalQuery({ selected: "approval_9zk" }), { open: "approval_9zk" });
  assert.deepEqual(legacyApprovalQuery({ bucket: "pending", q: "a b" }), { view: "needs" });
  assert.deepEqual(legacyApprovalQuery({ bucket: "applied" }), { view: "history", status: "applied" });
  assert.deepEqual(legacyApprovalQuery({ bucket: "stuck", selected: "x", open: "y" }), { open: "y", view: "stuck" });
  assert.equal(legacyApprovalQuery({ view: "history" }), null);
});
