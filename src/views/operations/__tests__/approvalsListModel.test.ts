import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_STATUSES,
  HISTORY_PAGE_SIZE,
  HISTORY_STATUSES,
  activeListParams,
  agentUpdatePlanParams,
  agentUpdateStaleParams,
  agentUpdateRowsNeedingPlans,
  appendHistoryPage,
  approvalDigest,
  baselineKey,
  baselineParams,
  bucketCount,
  emptyHistoryPage,
  hasMoreHistory,
  historyLoadNote,
  historyPageParams,
  historyStatusesForBucket,
  isHistoryLoaded,
  mergeApprovalRows,
  planCacheIsStale,
  previousAppliedPlan,
} from "../approvalsListModel.ts";
import { approvalListTotal, unwrapApproval, unwrapApprovalCounts } from "../../../lib/api/approvalsEnvelope.ts";
import type { ApprovalCounts, ApprovalView } from "../../../lib/api/types.ts";

function row(id: string, over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id,
    node_id: "node-a",
    plugin: "nftpolicy",
    action: "apply-policy",
    status: "pending",
    plan_sha256: `sha-${id}`,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

// ── What each read asks for ──────────────────────────────────────────────────

test("the first read is the active set without plan text", () => {
  assert.deepEqual(activeListParams(), { status: "pending,approved,stale" });
  assert.deepEqual([...ACTIVE_STATUSES], ["pending", "approved", "stale"]);
  assert.deepEqual([...HISTORY_STATUSES], ["applied", "rejected", "dismissed"]);
});

test("a history page is one status, 200 rows, at an offset, and only dismissed asks for tombstones", () => {
  assert.equal(HISTORY_PAGE_SIZE, 200);
  assert.deepEqual(historyPageParams("applied"), { status: "applied", limit: 200, offset: 0, include_dismissed: undefined });
  assert.deepEqual(historyPageParams("rejected", 400), { status: "rejected", limit: 200, offset: 400, include_dismissed: undefined });
  assert.deepEqual(historyPageParams("dismissed"), { status: "dismissed", limit: 200, offset: 0, include_dismissed: true });
});

test("history buckets name their status; all names every history status; active buckets none", () => {
  assert.deepEqual(historyStatusesForBucket("applied"), ["applied"]);
  assert.deepEqual(historyStatusesForBucket("dismissed"), ["dismissed"]);
  assert.deepEqual(historyStatusesForBucket("all"), ["applied", "rejected", "dismissed"]);
  for (const bucket of ["active", "pending", "stale", "approved", "stuck"]) {
    assert.deepEqual(historyStatusesForBucket(bucket), [], bucket);
  }
});

test("the agent-update plan read and the diff baseline read are narrow and carry plan text", () => {
  assert.deepEqual(agentUpdatePlanParams(), { status: "pending,approved,stale", plugin: "agentupdate", include: "plan" });
  const target = row("x", { node_id: "node-9", plugin: "wireguard" });
  assert.equal(baselineKey(target), "node-9|wireguard");
  assert.deepEqual(baselineParams(target), {
    status: "applied",
    node_id: "node-9",
    plugin: "wireguard",
    include: "plan",
    limit: 200,
  });
});

// The Agent Updates page prints stale agent updates. Staleness is derived, not
// a status column value, so asking the server for status=stale answers an empty
// list and the page would go permanently blank. It filters client-side instead,
// which is what it did when it read the whole listing.
test("the agent-update staleness read filters by plugin only, never by a status the server cannot match", () => {
  assert.deepEqual(agentUpdateStaleParams(), { plugin: "agentupdate" });
  assert.equal("status" in agentUpdateStaleParams(), false);

  // Both arms of that claim: a stale row is not carrying "stale" in its status
  // column, and it is the flag the page filters on.
  const stale = row("ap-stale", { plugin: "agentupdate", status: "rejected", stale: true });
  assert.notEqual(stale.status as string, "stale");
  assert.equal(stale.stale, true);
});

// ── Paging state ─────────────────────────────────────────────────────────────

test("a page appends without duplicating, a first page replaces, and more is known from the total", () => {
  const first = appendHistoryPage(undefined, { rows: [row("a"), row("b")], total: 5, offset: 0 });
  assert.deepEqual(first.rows.map((r) => r.id), ["a", "b"]);
  assert.equal(first.total, 5);
  assert.equal(isHistoryLoaded(first), true);
  assert.equal(hasMoreHistory(first), true);

  const second = appendHistoryPage(first, { rows: [row("b"), row("c")], total: 5, offset: 2 });
  assert.deepEqual(second.rows.map((r) => r.id), ["a", "b", "c"]);

  const refreshed = appendHistoryPage(second, { rows: [row("z")], total: 1, offset: 0 });
  assert.deepEqual(refreshed.rows.map((r) => r.id), ["z"]);
  assert.equal(hasMoreHistory(refreshed), false);

  assert.equal(isHistoryLoaded(undefined), false);
  assert.equal(isHistoryLoaded(emptyHistoryPage()), false);
  assert.equal(hasMoreHistory(emptyHistoryPage()), false);
});

test("the load note names what is missing, what is partial, and when nothing is", () => {
  const applied = appendHistoryPage(undefined, { rows: [row("a")], total: 3, offset: 0 });
  const rejected = appendHistoryPage(undefined, { rows: [row("r")], total: 1, offset: 0 });

  const all = historyLoadNote("all", { applied, rejected });
  assert.deepEqual(all.notLoaded, ["dismissed"]);
  assert.deepEqual(all.partial, [{ status: "applied", loaded: 1, total: 3 }]);
  assert.equal(all.complete, false);

  const done = historyLoadNote("rejected", { applied, rejected });
  assert.deepEqual(done, { notLoaded: [], partial: [], complete: true });

  const active = historyLoadNote("pending", {});
  assert.deepEqual(active, { notLoaded: [], partial: [], complete: false });
});

// ── The merged list ──────────────────────────────────────────────────────────

test("active rows win over history rows, pinned rows fill gaps, and cached plans are restored only while their hash matches", () => {
  const plans = {
    a: { plan: "plan a", sha256: "sha-a" },
    h: { plan: "old plan h", sha256: "sha-old" },
    p: { plan: "plan p", sha256: "sha-p" },
  };
  const merged = mergeApprovalRows({
    active: [row("a"), row("h", { status: "approved" })],
    history: [[row("h", { status: "applied" }), row("b", { status: "applied" })]],
    pinned: [row("p", { status: "rejected" }), row("a", { status: "rejected" })],
    plans,
  });
  const byId = Object.fromEntries(merged.map((r) => [r.id, r]));
  assert.equal(merged.length, 4);
  assert.equal(byId.a?.plan, "plan a");
  assert.equal(byId.a?.status, "pending");
  assert.equal(byId.h?.status, "approved", "the active row wins over its history twin");
  assert.equal(byId.h?.plan, undefined, "a cached plan whose hash no longer matches is not put back on the row");
  assert.equal(byId.b?.plan, undefined);
  assert.equal(byId.p?.plan, "plan p");
  assert.equal(byId.p?.status, "rejected");
});

test("a row that already carries plan text keeps it, and a row without plan_sha256 accepts any cached plan", () => {
  const merged = mergeApprovalRows({
    active: [row("full", { plan: "server plan" }), row("legacy", { plan_sha256: undefined })],
    history: [],
    plans: { full: { plan: "cached plan", sha256: "x" }, legacy: { plan: "cached legacy", sha256: "y" } },
  });
  assert.equal(merged[0]?.plan, "server plan");
  assert.equal(merged[1]?.plan, "cached legacy");
});

test("planCacheIsStale is true only when both sides have a hash and they differ", () => {
  assert.equal(planCacheIsStale(row("a"), undefined), false);
  assert.equal(planCacheIsStale(row("a"), { plan: "p", sha256: "sha-a" }), false);
  assert.equal(planCacheIsStale(row("a"), { plan: "p", sha256: "other" }), true);
  assert.equal(planCacheIsStale(row("a", { plan_sha256: undefined }), { plan: "p", sha256: "other" }), false);
});

// ── Counts ───────────────────────────────────────────────────────────────────

const COUNTS: ApprovalCounts = { pending: 1, approved: 2, stale: 1, applied: 1084, rejected: 190, dismissed: 7, total: 1285 };

test("history buckets print the server's count before any history row is loaded; active buckets count rows", () => {
  const rows = [row("a"), row("b", { status: "approved" })];
  const matches = (r: ApprovalView, bucket: string) => r.status === bucket;
  assert.equal(bucketCount("applied", rows, COUNTS, matches), 1084);
  assert.equal(bucketCount("rejected", rows, COUNTS, matches), 190);
  assert.equal(bucketCount("dismissed", rows, COUNTS, matches), 7);
  assert.equal(bucketCount("all", rows, COUNTS, matches), 1285);
  assert.equal(bucketCount("pending", rows, COUNTS, matches), 1);
  // Without counts the page can only say what it holds.
  assert.equal(bucketCount("applied", rows, undefined, matches), 0);
  assert.equal(bucketCount("all", rows, undefined, matches), 2);
});

test("unwrapApprovalCounts fills every known key with zero and keeps unknown numeric keys", () => {
  assert.deepEqual(unwrapApprovalCounts({ counts: { pending: 3, failed: 2 } }), {
    pending: 3,
    approved: 0,
    stale: 0,
    applied: 0,
    rejected: 0,
    dismissed: 0,
    total: 0,
    failed: 2,
  });
  assert.equal(unwrapApprovalCounts({ pending: 4 }).pending, 4);
  assert.equal(unwrapApprovalCounts({ counts: { pending: "4" as unknown as number } }).pending, 0);
});

test("the per-id read is accepted enveloped or bare, and a listing's total is the server's when enveloped", () => {
  const one = row("one", { plan: "text" });
  assert.deepEqual(unwrapApproval({ approval: one }), one);
  assert.deepEqual(unwrapApproval(one), one);
  assert.equal(approvalListTotal({ approvals: [one], total: 1275 }), 1275);
  assert.equal(approvalListTotal({ approvals: [one] }), 1);
  assert.equal(approvalListTotal([one, one]), 2);
});

// ── Binding a decision to a plan ─────────────────────────────────────────────

test("a decision hashes the plan the operator saw, else sends the server's hash, else reads the record first", async () => {
  const calls: string[] = [];
  const deps = {
    hashPlan: async (item: Pick<ApprovalView, "id" | "plan">) => {
      calls.push(`hash:${item.id}:${item.plan}`);
      return `hashed(${item.plan})`;
    },
    fetchFull: async (id: string) => {
      calls.push(`fetch:${id}`);
      return { id, plan: "fetched plan" };
    },
  };
  assert.equal(await approvalDigest({ id: "a", plan: "seen plan", plan_sha256: "server-sha" }, deps), "hashed(seen plan)");
  assert.equal(await approvalDigest({ id: "b", plan_sha256: "server-sha" }, deps), "server-sha");
  assert.equal(await approvalDigest({ id: "c" }, deps), "hashed(fetched plan)");
  assert.deepEqual(calls, ["hash:a:seen plan", "fetch:c", "hash:c:fetched plan"]);
});

// ── Event cards still need agent-update plan text ────────────────────────────

test("only plan-less agent updates without a fresh cached plan need the second read", () => {
  const rows = [
    row("au1", { plugin: "agentupdate" }),
    row("au2", { plugin: "agentupdate", plan: "has plan" }),
    row("au3", { plugin: "agentupdate", plan_sha256: "sha-au3" }),
    row("au4", { plugin: "agentupdate", plan_sha256: "sha-new" }),
    row("nft", { plugin: "nftpolicy" }),
  ];
  const plans = { au3: { plan: "cached", sha256: "sha-au3" }, au4: { plan: "cached", sha256: "sha-old" } };
  assert.deepEqual(
    agentUpdateRowsNeedingPlans(rows, plans).map((r) => r.id),
    ["au1", "au4"],
  );
});

// ── Diff baseline ────────────────────────────────────────────────────────────

test("the diff baseline is the newest earlier applied plan on the same node, plugin and action", () => {
  const current = row("cur", { created_at: "2026-09-03T00:00:00Z" });
  const rows = [
    current,
    row("old1", { status: "applied", plan: "first", created_at: "2026-08-01T00:00:00Z" }),
    row("old2", { status: "applied", plan: "second", created_at: "2026-08-20T00:00:00Z" }),
    row("later", { status: "applied", plan: "future", created_at: "2026-09-04T00:00:00Z" }),
    row("approved", { status: "approved", plan: "not live", created_at: "2026-08-25T00:00:00Z" }),
    row("other", { status: "applied", plan: "other action", action: "arm", created_at: "2026-08-30T00:00:00Z" }),
  ];
  assert.equal(previousAppliedPlan(current, rows), "second");
  assert.equal(previousAppliedPlan(current, [current]), "");
});
