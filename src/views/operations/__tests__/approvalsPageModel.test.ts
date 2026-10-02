import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTokens } from "../../../lib/queryTokens.ts";
import type { ApprovalView } from "../../../lib/api/types.ts";
import {
  APPROVAL_HISTORY_GRAMMAR,
  defaultApprovalLayer,
  historyRequest,
  legacyApprovalQuery,
  namePreview,
  nextToReview,
  normalizeApprovalPage,
  stuckReasonSummary,
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

test("a preview names six nodes and counts the rest", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assert.deepEqual(namePreview(names), { names: ["a", "b", "c", "d", "e", "f"], extra: 2 });
  assert.deepEqual(namePreview(["a", "b"]), { names: ["a", "b"], extra: 0 });
  assert.deepEqual(namePreview(names, 3), { names: ["a", "b", "c"], extra: 5 });
});

test("the stuck summary counts each reason once, most common first", () => {
  const waiting = (code: string) => ({ waiting: { code, blocked: true, reason: "" } }) as Pick<ApprovalView, "waiting">;
  assert.deepEqual(
    stuckReasonSummary([waiting("task_failed"), waiting("node_offline"), waiting("node_offline"), waiting("not_queued")]),
    [
      { code: "node_offline", count: 2 },
      { code: "task_failed", count: 1 },
      { code: "not_queued", count: 1 },
    ],
  );
  assert.deepEqual(stuckReasonSummary([]), []);
});

test("after a decision the plan now in its place comes next, wrapping, and undecidable plans are skipped", () => {
  const order = [
    { id: "a", decidable: true },
    { id: "b", decidable: true },
    { id: "c", decidable: false },
    { id: "d", decidable: true },
  ];
  // Decided the first: the second is next, three left minus the undecidable one.
  assert.deepEqual(nextToReview(order, { id: "a", index: 0 }), { id: "b", waiting: 2 });
  // Decided b while c (not decidable) sat after it: d.
  assert.deepEqual(nextToReview(order, { id: "b", index: 1 }), { id: "d", waiting: 2 });
  // Decided the last: wrap to the top.
  assert.deepEqual(nextToReview(order, { id: "d", index: 3 }), { id: "a", waiting: 2 });
});

test("the next plan is found when the decided plan already left the inbox after a refresh", () => {
  // The read after the decision no longer lists "b"; the plan in its old place is next.
  const refreshed = [
    { id: "a", decidable: true },
    { id: "c", decidable: true },
    { id: "d", decidable: true },
  ];
  assert.deepEqual(nextToReview(refreshed, { id: "b", index: 1 }), { id: "c", waiting: 3 });
  // A position past the end (the inbox shrank) wraps to the top.
  assert.deepEqual(nextToReview(refreshed, { id: "x", index: 9 }), { id: "a", waiting: 3 });
});

test("nothing is offered when no decidable plan is left", () => {
  assert.equal(nextToReview([{ id: "a", decidable: true }], { id: "a", index: 0 }), null);
  assert.equal(nextToReview([{ id: "a", decidable: true }, { id: "b", decidable: false }], { id: "a", index: 0 }), null);
  assert.equal(nextToReview([], { id: "a", index: -1 }), null);
});
