import assert from "node:assert/strict";
import { test } from "node:test";

import { CHANGES_QUERY, dueThisWeek, flappingNodes, flipQuery, homeAttention, nextAfterWeek, readState } from "../homeModel.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

test("flips are counted per node and only nodes past the threshold are flapping", () => {
  const events = [
    ...Array.from({ length: 14 }, (_, i) => ({ node_id: "mac", action: "node.offline", at: hoursAgo(i + 1) })),
    ...Array.from({ length: 2 }, (_, i) => ({ node_id: "home", action: "node.offline", at: hoursAgo(i + 1) })),
    { node_id: "mac", action: "node.online", at: hoursAgo(1) },
    { action: "node.offline", at: hoursAgo(2) },
  ];
  const flaps = flappingNodes(events);
  assert.deepEqual(flaps.map((f) => [f.nodeId, f.count]), [["mac", 14]]);
  assert.equal(flaps[0]!.lastAt, Date.parse(hoursAgo(1)));
});

test("the flip read asks for one action over the last day, and changes drop flips and observe", () => {
  const q = flipQuery(NOW);
  assert.equal(q.action, "node.offline");
  assert.equal(q.at_from, "2026-09-29T12:00:00.000Z");
  assert.equal(CHANGES_QUERY.exclude_action, "node.online,node.offline");
  assert.equal(CHANGES_QUERY.exclude_decision, "observe");
});

test("offline nodes say how long; disabled nodes and online ones are not attention", () => {
  const items = homeAttention({
    now: NOW,
    nodes: [
      { id: "n1", name: "DMIT-4", status: "offline", status_since: hoursAgo(147) },
      { id: "n2", name: "retired", status: "disabled", status_since: hoursAgo(400) },
      { id: "n3", name: "fine", status: "online" },
      { id: "n4", name: "gpu", status: "never_reported", status_since: hoursAgo(11) },
      { id: "n5", name: "malibu", status: "degraded", status_reason: "sing-box restarting." },
    ],
  });
  assert.deepEqual(items.map((i) => i.key), ["node:n4", "node:n1", "node:n5"]);
  const dmit = items.find((i) => i.key === "node:n1");
  assert.ok(dmit && dmit.kind === "node" && dmit.tone === "danger" && dmit.sinceMs === 147 * 3_600_000);
  assert.ok(items.find((i) => i.key === "node:n5")?.tone === "warning");
});

test("a flapping node gets a row unless it is offline (its row says it) or disabled", () => {
  const items = homeAttention({
    now: NOW,
    nodes: [
      { id: "mac", name: "mac-air", status: "online" },
      { id: "dmit", name: "DMIT-4", status: "offline" },
      { id: "off", name: "retired", status: "disabled" },
    ],
    flaps: [
      { nodeId: "mac", count: 14, lastAt: NOW - 3_600_000 },
      { nodeId: "dmit", count: 5, lastAt: NOW },
      { nodeId: "off", count: 4, lastAt: NOW },
    ],
  });
  assert.deepEqual(items.map((i) => i.key), ["node:dmit", "flap:mac"]);
});

test("stalled tasks, failing DDNS and renewals are one row each; auto-renewals are not attention", () => {
  const items = homeAttention({
    now: NOW,
    counts: { stalled: 1 },
    ddns: [{ name: "a.dyn", last_error: "cloudflare: 403" }, { name: "b.dyn" }, { name: "c.dyn", last_error: "timeout" }],
    expiring: [
      { title: "late", days: -2, state: "overdue" },
      { title: "soon", days: 5, state: "due" },
      { title: "auto", days: 3, state: "auto" },
      { title: "later", days: 12, state: "upcoming" },
    ],
  });
  assert.deepEqual(items.map((i) => i.kind), ["stalled", "ddns", "overdue", "due"]);
  const ddns = items.find((i) => i.kind === "ddns");
  assert.ok(ddns && ddns.kind === "ddns" && ddns.count === 2 && ddns.error === "cloudflare: 403");
});

test("reads that have not landed add nothing", () => {
  assert.deepEqual(homeAttention({ now: NOW }), []);
  assert.deepEqual(homeAttention({ now: NOW, counts: { stalled: 0 }, ddns: [], expiring: [] }), []);
});

test("the week lists what needs a hand, at most five, and counts the auto-renewals", () => {
  const items = [
    ...Array.from({ length: 7 }, (_, i) => ({ title: `m${i}`, days: 6 - i, state: "due" as const })),
    { title: "auto", days: 2, state: "auto" as const },
    { title: "next", days: 9, state: "upcoming" as const },
  ];
  const week = dueThisWeek(items);
  assert.deepEqual(week.shown.map((i) => i.title), ["m6", "m5", "m4", "m3", "m2"]);
  assert.equal(week.more, 2);
  assert.equal(week.auto, 1);
  assert.equal(nextAfterWeek(items)?.title, "next");
});

test("a read is ready while it holds data, and otherwise says why there is no number", () => {
  assert.equal(readState({}), "reading");
  assert.equal(readState({ data: { pending: 0 } }), "ready");
  assert.equal(readState({ data: { pending: 0 }, error: { status: 502 } }), "ready");
  assert.equal(readState({ error: { status: 502 } }), "failed");
  assert.equal(readState({ error: { status: 403 } }), "forbidden");
  assert.equal(readState({ data: { pending: 0 }, error: { status: 404 } }), "unsupported");
});
