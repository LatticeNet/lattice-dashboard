import assert from "node:assert/strict";
import { test } from "node:test";

import { failingMonitors, healthRank, latestPerNode, monitorHealth, staleAfterMs } from "../monitorHealthModel.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();
const monitor = (over: Partial<{ id: string; enabled: boolean; interval_sec: number }> = {}) => ({
  id: "mon_hk",
  enabled: true,
  interval_sec: 30,
  ...over,
});

test("the state comes from each node's newest result, so one failing node fails the monitor", () => {
  const results = [
    { node_id: "fsn", at: secondsAgo(90), success: true, latency_ms: 40 },
    { node_id: "fsn", at: secondsAgo(30), success: false },
    { node_id: "la", at: secondsAgo(20), success: true, latency_ms: 120 },
  ];
  assert.deepEqual(
    latestPerNode(results).map((r) => [r.node_id, r.success]),
    [
      ["fsn", false],
      ["la", true],
    ],
  );
  const state = monitorHealth(monitor(), results, NOW);
  assert.equal(state.kind, "failing");
  assert.equal(state.kind === "failing" && `${state.failing} of ${state.total}`, "1 of 2");
});

test("passing nodes read up with the mean of their newest latencies", () => {
  const state = monitorHealth(
    monitor(),
    [
      { node_id: "fsn", at: secondsAgo(10), success: true, latency_ms: 40 },
      { node_id: "la", at: secondsAgo(12), success: true, latency_ms: 120 },
    ],
    NOW,
  );
  assert.deepEqual(state, { kind: "up", total: 2, latencyMs: 80, lastAt: Date.parse(secondsAgo(10)) });
});

test("an old pass is not a current reading: it reads stale, never up", () => {
  // 30 s interval: three intervals is 90 s, under the three-minute floor.
  assert.equal(staleAfterMs({ interval_sec: 30 }), 180_000);
  assert.equal(staleAfterMs({ interval_sec: 3600 }), 3 * 3_600_000);
  const old = [{ node_id: "fsn", at: secondsAgo(600), success: true, latency_ms: 40 }];
  assert.equal(monitorHealth(monitor(), old, NOW).kind, "stale");
  // A certificate watch checks hourly, so a 50-minute-old result is current.
  const hourly = [{ node_id: "", at: secondsAgo(3000), success: true }];
  assert.equal(monitorHealth(monitor({ interval_sec: 3600 }), hourly, NOW).kind, "up");
});

test("disabled, unread and empty are told apart, and none of them is up", () => {
  assert.equal(monitorHealth(monitor({ enabled: false }), [], NOW).kind, "disabled");
  assert.equal(monitorHealth(monitor(), undefined, NOW).kind, "unread");
  assert.equal(monitorHealth(monitor(), [], NOW).kind, "none");
});

test("failing sorts first and the most-failing monitor leads the attention list", () => {
  const order = (["up", "disabled", "failing", "none", "stale", "unread"] as const)
    .map((kind) => ({ kind }) as Parameters<typeof healthRank>[0])
    .sort((a, b) => healthRank(a) - healthRank(b))
    .map((h) => h.kind);
  assert.deepEqual(order, ["failing", "stale", "none", "unread", "up", "disabled"]);

  const monitors = [monitor({ id: "a" }), monitor({ id: "b" }), monitor({ id: "c" })];
  const states = {
    a: { kind: "failing", failing: 1, total: 3, lastAt: NOW },
    b: { kind: "up", total: 1, lastAt: NOW },
    c: { kind: "failing", failing: 2, total: 2, lastAt: NOW },
  } as const;
  assert.deepEqual(
    failingMonitors(monitors, (m) => states[m.id as keyof typeof states]).map((f) => f.monitor.id),
    ["c", "a"],
  );
});

test("the list's latest field is the state, for every monitor however many there are", () => {
  // The server sends each node's newest result with the list. Sixty monitors
  // used to stop at fifty reads, and the rest said "not read".
  const listed = Array.from({ length: 60 }, (_, i) => ({
    ...monitor({ id: `mon_${i}` }),
    latest: [
      { node_id: "fsn", at: secondsAgo(20), success: i % 25 !== 24, latency_ms: 40, fail_streak: i % 25 === 24 ? 3 : 0, since: secondsAgo(90) },
    ],
  }));
  const states = listed.map((m) => monitorHealth(m, m.latest, NOW));
  assert.equal(states.filter((s) => s.kind === "unread").length, 0);
  assert.deepEqual(
    failingMonitors(listed, (m) => monitorHealth(m, m.latest, NOW)).map((f) => f.monitor.id),
    ["mon_24", "mon_49"],
  );
  // A list without the field (an older server) is not read, never up.
  assert.equal(monitorHealth(monitor(), undefined, NOW).kind, "unread");
});
