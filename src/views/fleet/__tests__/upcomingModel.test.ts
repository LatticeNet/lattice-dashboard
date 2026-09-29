import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExpiringItem } from "@/lib/api/types";
import {
  filterByKinds,
  hiddenKindsOf,
  formatAmount,
  formatTotals,
  groupByWeek,
  kindCounts,
  kindFilterQuery,
  parseKindFilter,
  rowHref,
  sumTotals,
  todayOf,
  toggleKind,
  upcomingState,
} from "../upcomingModel.ts";

// Production on 2026-09-29, a Tuesday: the first renewal on 10-06, four DMIT
// machines on 10-20, four more on 10-27.
const TODAY = Date.parse("2026-09-29T08:00:00Z");

function item(title: string, due: string, extra: Partial<ExpiringItem> = {}): ExpiringItem {
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse("2026-09-29T00:00:00Z")) / 86_400_000);
  return {
    kind: "machine_renewal",
    id: title,
    title,
    due_at: `${due}T00:00:00Z`,
    days,
    state: days < 0 ? "overdue" : days <= 7 ? "due" : "upcoming",
    cost_cents: 0,
    currency: "",
    ...extra,
  };
}

const PROD = [
  item("cd-xuezhang-jp-nat", "2026-10-06", { cost_cents: 3500, currency: "CNY" }),
  item("openjobs-vpn-dmit-1", "2026-10-20", { cost_cents: 1298, currency: "USD", state: "auto" }),
  item("openjobs-vpn-dmit-2", "2026-10-20", { cost_cents: 1298, currency: "USD", state: "auto" }),
  item("openjobs-vpn-dmit-3", "2026-10-20", { cost_cents: 1298, currency: "USD", state: "auto" }),
  item("openjobs-vpn-dmit-4", "2026-10-20", { cost_cents: 1298, currency: "USD", state: "auto" }),
  item("cd-gomami-jpn", "2026-10-27", { cost_cents: 2900, currency: "USD" }),
];

test("weeks start on Monday: today, next week, then weeks named by their Monday", () => {
  const groups = groupByWeek(
    [...PROD, item("cd-mkcloud-hr-iplc", "2026-10-04"), item("share /s/cdcd", "2026-09-28", { kind: "share", state: "upcoming", days: -1 })],
    TODAY,
  );
  assert.deepEqual(
    groups.map((g) => [g.kind, g.weekStart ?? "", g.items.map((i) => i.title)]),
    [
      ["overdue", "", ["share /s/cdcd"]],
      // Sunday 10-04 is still this week; Monday 10-05 starts the next.
      ["thisWeek", "", ["cd-mkcloud-hr-iplc"]],
      ["nextWeek", "", ["cd-xuezhang-jp-nat"]],
      ["dated", "2026-10-19", ["openjobs-vpn-dmit-1", "openjobs-vpn-dmit-2", "openjobs-vpn-dmit-3", "openjobs-vpn-dmit-4"]],
      ["dated", "2026-10-26", ["cd-gomami-jpn"]],
    ],
  );
});

test("an auto-roll row a day past its date is not overdue: it has been charged", () => {
  const groups = groupByWeek([item("auto-late", "2026-09-28", { state: "auto" })], TODAY);
  assert.deepEqual(groups.map((g) => g.kind), ["thisWeek"]);
});

test("rows out of order are put in date order, ties by title", () => {
  const groups = groupByWeek([...PROD].reverse(), TODAY);
  assert.deepEqual(groups.flatMap((g) => g.items.map((i) => i.title)), PROD.map((i) => i.title));
});

test("today is the server's day, not the viewer's clock", () => {
  // The viewer's clock says Monday of the following week; the server said Tuesday.
  const today = todayOf({ generated_at: "2026-09-29T23:59:00Z" }, Date.parse("2026-10-05T01:00:00Z"));
  assert.equal(new Date(today).toISOString(), "2026-09-29T00:00:00.000Z");
  assert.equal(new Date(todayOf(undefined, TODAY)).toISOString(), "2026-09-29T00:00:00.000Z");
});

test("totals are per currency, skip unpriced rows, and never add currencies together", () => {
  const rows = [...PROD, item("tls lattice.example", "2026-10-10", { kind: "tls_certificate" }), item("cny2", "2026-10-11", { cost_cents: 18800, currency: "cny" })];
  assert.deepEqual(sumTotals(rows), [
    { currency: "CNY", cost_cents: 22300, count: 2 },
    { currency: "USD", cost_cents: 8092, count: 5 },
  ]);
  assert.equal(formatTotals(sumTotals(rows)), "CNY 223.00 · USD 80.92");
  assert.equal(formatAmount(123456, "USD"), "USD 1,234.56");
  assert.deepEqual(sumTotals([]), []);
});

test("each week carries the totals of its own rows", () => {
  const dmit = groupByWeek(PROD, TODAY).find((g) => g.weekStart === "2026-10-19");
  assert.deepEqual(dmit?.totals, [{ currency: "USD", cost_cents: 5192, count: 4 }]);
});

// ── state ───────────────────────────────────────────────────────────────────

const DATA = { items: PROD };

test("a 404 means the server predates the list, never that nothing is due", () => {
  assert.deepEqual(upcomingState({ loading: false, error: { status: 404 } }), { state: "unsupported", stale: false });
  // Even with rows from before: a server that forgot the endpoint was downgraded.
  assert.deepEqual(upcomingState({ loading: false, error: { status: 404 }, data: DATA }), { state: "unsupported", stale: false });
});

test("a failure after a good load keeps the rows and marks them stale", () => {
  assert.deepEqual(upcomingState({ loading: false, error: { status: 500 }, data: DATA }), { state: "ready", stale: true });
  assert.deepEqual(upcomingState({ loading: false, error: new Error("network"), data: { items: [] } }), { state: "empty", stale: true });
});

test("a failure with nothing loaded is failed, or forbidden for a 403", () => {
  assert.deepEqual(upcomingState({ loading: false, error: { status: 500 } }), { state: "failed", stale: false });
  assert.deepEqual(upcomingState({ loading: false, error: { status: 403 } }), { state: "forbidden", stale: false });
});

test("loading until the first answer; empty is an answer with no rows", () => {
  assert.equal(upcomingState({ loading: true }).state, "loading");
  assert.equal(upcomingState({ loading: false }).state, "loading");
  assert.equal(upcomingState({ loading: false, data: { items: [] } }).state, "empty");
  assert.equal(upcomingState({ loading: false, data: DATA }).state, "ready");
  // The filter can empty a loaded list; that is empty, not failed.
  assert.equal(upcomingState({ loading: false, data: DATA, visible: 0 }).state, "empty");
});

// ── kind filter in the URL ──────────────────────────────────────────────────

test("the kind filter reads comma lists and repeated keys, in chip order, dropping unknown words", () => {
  assert.deepEqual(parseKindFilter("share,machine_renewal"), ["machine_renewal", "share"]);
  assert.deepEqual(parseKindFilter(["vpn_user", "tls_certificate,bogus"]), ["vpn_user", "tls_certificate"]);
  assert.deepEqual(parseKindFilter(undefined), []);
  assert.deepEqual(parseKindFilter(42), []);
  assert.deepEqual(parseKindFilter("machine_renewal,machine_renewal"), ["machine_renewal"]);
});

test("every kind selected is the same as none, and leaves the URL clean", () => {
  assert.deepEqual(parseKindFilter("machine_renewal,vpn_user,share,tls_certificate"), []);
  assert.equal(kindFilterQuery(["machine_renewal", "vpn_user", "share", "tls_certificate"]), undefined);
  assert.equal(kindFilterQuery([]), undefined);
  assert.equal(kindFilterQuery(["share", "vpn_user"]), "vpn_user,share");
});

test("toggling a chip adds or removes its kind", () => {
  assert.deepEqual(toggleKind([], "share"), ["share"]);
  assert.deepEqual(toggleKind(["share", "vpn_user"], "share"), ["vpn_user"]);
  assert.deepEqual(toggleKind(["machine_renewal", "vpn_user", "share"], "tls_certificate"), []);
});

test("no filter shows every row, kinds the console does not know included", () => {
  const rows = [...PROD, item("x", "2026-10-02", { kind: "provider_subscription" }), item("y", "2026-10-03", { kind: "share" })];
  assert.equal(filterByKinds(rows, []).length, rows.length);
  assert.deepEqual(filterByKinds(rows, ["share"]).map((r) => r.title), ["y"]);
  assert.deepEqual(kindCounts(rows), { machine_renewal: 6, vpn_user: 0, share: 1, tls_certificate: 0 });
});

test("a row opens the server's path on this origin, or the page that owns its kind", () => {
  assert.equal(rowHref({ kind: "machine_renewal", href: "/inventory?node=node_001" }), "/inventory?node=node_001");
  assert.equal(rowHref({ kind: "machine_renewal", href: "//evil.example/x" }), "/inventory?group=renewal");
  assert.equal(rowHref({ kind: "share", href: "https://evil.example/" }), "/platform/publishing?origin=share");
  assert.equal(rowHref({ kind: "vpn_user" }), "/plugins/latticenet.vpn-core/users");
  assert.equal(rowHref({ kind: "provider_subscription" }), undefined);
});

test("hidden kinds are named in chip order, and an old server's row count is ignored", () => {
  assert.deepEqual(hiddenKindsOf({ hidden_kinds: ["share", "vpn_user", "share"] }), ["vpn_user", "share"]);
  assert.deepEqual(hiddenKindsOf({ hidden_kinds: ["provider_subscription", "tls_certificate"] }), ["tls_certificate", "provider_subscription"]);
  // The first draft sent `hidden: 3`; a count leaks fleet size, so it is never shown.
  assert.deepEqual(hiddenKindsOf({ hidden: 3 } as never), []);
  assert.deepEqual(hiddenKindsOf(undefined), []);
  assert.deepEqual(hiddenKindsOf({ hidden_kinds: null } as never), []);
});
