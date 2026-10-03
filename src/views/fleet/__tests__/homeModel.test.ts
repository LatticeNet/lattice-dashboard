import assert from "node:assert/strict";
import { test } from "node:test";

import { CHANGES_QUERY, FAILED_TASKS_QUERY, changesOnly, dueThisWeek, flappingNodes, flipQuery, flipReadPartial, homeAttention, nextAfterWeek, readState } from "../homeModel.ts";
import { readRange } from "../../operations/opsQueryModel.ts";

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

test("a server that ignores the exclusions has its flips and observe rows dropped, and says so", () => {
  const rows = [
    { id: "a", action: "plan.apply", decision: "allow" },
    { id: "b", action: "node.offline", decision: "allow" },
    { id: "c", action: "auth.login", decision: "observe" },
    { id: "d", action: "node.online", decision: "allow" },
    { id: "e", action: "node.update", decision: "allow" },
  ];
  const old = changesOnly(rows);
  assert.deepEqual(old.events.map((e) => e.id), ["a", "e"]);
  assert.equal(old.ignored, true);
  const current = changesOnly([rows[0]!, rows[4]!]);
  assert.equal(current.ignored, false);
  assert.equal(current.events.length, 2);
});

test("a flip read that missed rows makes every flapping count a lower bound", () => {
  assert.equal(flipReadPartial({ events: new Array(500), total: 500, complete: true }), false);
  assert.equal(flipReadPartial({ events: new Array(500), total: 731 }), true);
  assert.equal(flipReadPartial({ events: new Array(20), total: 20, complete: false }), true);
  const flaps = [{ nodeId: "mac", count: 14, lastAt: NOW }];
  const nodes = [{ id: "mac", name: "mac-air", status: "online" as const }];
  const partial = homeAttention({ now: NOW, nodes, flaps, flapsPartial: true }).find((i) => i.kind === "flapping");
  const whole = homeAttention({ now: NOW, nodes, flaps }).find((i) => i.kind === "flapping");
  assert.ok(partial?.kind === "flapping" && partial.atLeast === true);
  assert.ok(whole?.kind === "flapping" && whole.atLeast === false);
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

test("a node row is left to a shown incident only when that incident says the same thing", () => {
  const items = homeAttention({
    now: NOW,
    nodes: [
      { id: "dmit", name: "DMIT-4", status: "offline", status_since: hoursAgo(2) },
      { id: "malibu", name: "malibu", status: "degraded", status_reason: "sing-box restarting." },
      { id: "mac", name: "mac-air", status: "online" },
      { id: "gpu", name: "gpu", status: "offline", status_since: hoursAgo(1) },
      { id: "hel", name: "hetzner-hel", status: "offline", status_since: hoursAgo(1) },
    ],
    flaps: [{ nodeId: "mac", count: 14, lastAt: NOW }],
    incidentNodes: new Map([
      ["dmit", new Set(["node.offline"])],
      ["malibu", new Set(["service.down"])],
      ["mac", new Set(["node.offline"])],
      // A failing monitor on a node that then went offline: its offline row stays.
      ["hel", new Set(["monitor.down"])],
    ]),
  });
  assert.deepEqual(items.map((i) => i.key), ["node:gpu", "node:hel"]);
});

test("a node whose incident is still pending is a warning that says when it opens, not a problem", () => {
  const items = homeAttention({
    now: NOW,
    nodes: [
      { id: "mac", name: "mac-air", status: "offline", status_since: new Date(NOW - 52_000).toISOString() },
      { id: "gpu", name: "gpu", status: "offline", status_since: hoursAgo(1) },
      { id: "hel", name: "hetzner-hel", status: "offline", status_since: new Date(NOW - 30_000).toISOString() },
    ],
    pendingNodes: new Map([
      ["mac", new Map([["node.offline", NOW + 60_000]])],
      // Its open time depends on the next check.
      ["hel", new Map([["node.offline", undefined]])],
      // A pending failing monitor says nothing about the node being offline.
      ["gpu", new Map([["monitor.down", NOW + 60_000]])],
    ]),
  });
  const mac = items.find((i) => i.key === "node:mac");
  assert.ok(mac && mac.kind === "node");
  assert.equal(mac.tone, "warning");
  assert.deepEqual(mac.pending, { opensInMs: 60_000 });
  const hel = items.find((i) => i.key === "node:hel");
  assert.ok(hel && hel.kind === "node" && hel.tone === "warning");
  assert.deepEqual(hel.pending, { opensInMs: undefined });
  const gpu = items.find((i) => i.key === "node:gpu");
  assert.ok(gpu && gpu.kind === "node" && gpu.tone === "danger" && gpu.pending === undefined);
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

test("an offline node carries its last report and agent, and failing monitors get one row", () => {
  const items = homeAttention({
    now: NOW,
    nodes: [
      { id: "n4", name: "DMIT-4", status: "offline", status_since: hoursAgo(144), last_seen: hoursAgo(144), agent_version: "0.3.8", status_reason: "No report since ..." },
      { id: "gpu", name: "gpu-box", status: "never_reported", status_since: hoursAgo(11), last_seen: "0001-01-01T00:00:00Z" },
    ],
    failingMonitors: [
      { id: "mon_hk", name: "HK relay port" },
      { id: "mon_api", name: "api health" },
    ],
  });
  const offline = items.find((item) => item.kind === "node" && item.nodeId === "n4");
  assert.ok(offline && offline.kind === "node");
  assert.equal(offline.lastSeenMs, 144 * 3_600_000);
  assert.equal(offline.agentVersion, "0.3.8");
  const never = items.find((item) => item.kind === "node" && item.nodeId === "gpu");
  assert.ok(never && never.kind === "node");
  assert.equal(never.lastSeenMs, undefined, "a zero last_seen is no report, not one 2000 years ago");
  const monitors = items.find((item) => item.kind === "monitors");
  assert.ok(monitors && monitors.kind === "monitors");
  assert.deepEqual([monitors.count, monitors.firstId, monitors.tone], [2, "mon_hk", "danger"]);
});

test("the failed tile opens the failed runs of the last 24 hours, the window it counts", () => {
  // Tasks reads its window from `range` with "all" as the page default; a
  // `since` that is not an RFC 3339 instant is ignored there.
  assert.deepEqual(readRange(FAILED_TASKS_QUERY, "all"), { range: "24h", since: "", until: "" });
  assert.equal(FAILED_TASKS_QUERY.status, "failed");
  assert.equal("since" in FAILED_TASKS_QUERY, false);
});
