import assert from "node:assert/strict";
import { test } from "node:test";

import type { LatencyProbePlan, LatencyRollups, LatencySeries } from "@/lib/api/types";

import {
  buildLatencyMatrix,
  chartCeiling,
  draftFromConfig,
  draftProblems,
  draftTargetReason,
  draftToConfig,
  draftsDiffer,
  formatLoss,
  formatMs,
  latencyBand,
  latencyProblems,
  pairEnabledIn,
  pairKey,
  parsePairKey,
  seriesBars,
  setPairEnabled,
  setSource,
  setTargetMode,
  targetMode,
} from "../latencyModel.ts";

function plan(over: Partial<LatencyProbePlan> = {}): LatencyProbePlan {
  return {
    config: { enabled: true, interval_sec: 60, timeout_sec: 5, sources: ["sh"], auto_targets: true, version: 3 },
    stored: true,
    default_source_name: "cd-hs-sh",
    nodes: [
      { node_id: "sh", name: "cd-hs-sh", country: "CN", region: "mainland", source: true, target: "none", target_reason: "mainland" },
      { node_id: "jp", name: "gomami-jp", country: "JP", region: "outside_mainland", source: false, target: "probed", target_reason: "auto", endpoint: "203.0.113.3:443", monitor_id: "mon_lat_jp" },
      { node_id: "hk", name: "hk-relay", country: "HK", region: "outside_mainland", source: false, target: "not_probeable", target_reason: "auto", endpoint_note: "udp_only" },
      { node_id: "us", name: "us-nat", country: "US", region: "outside_mainland", source: false, target: "probed", target_reason: "auto", endpoint: "edge.example.net:50100", monitor_id: "mon_lat_us" },
      { node_id: "de", name: "de-fsn", country: "DE", region: "outside_mainland", source: false, target: "probed", target_reason: "auto", endpoint: "203.0.113.9:443", monitor_id: "mon_lat_de" },
      { node_id: "sg", name: "sg-1", country: "SG", region: "outside_mainland", source: false, target: "paused", target_reason: "pairs_off", endpoint: "203.0.113.8:443", monitor_id: "mon_lat_sg" },
      { node_id: "bj", name: "cd-bj", country: "CN", region: "mainland", source: false, target: "none", target_reason: "mainland" },
    ],
    pairs: [
      { source: "sh", target: "jp", enabled: true, active: true, monitor_id: "mon_lat_jp" },
      { source: "sh", target: "hk", enabled: true, active: false },
      { source: "sh", target: "us", enabled: true, active: true, monitor_id: "mon_lat_us" },
      { source: "sh", target: "de", enabled: true, active: true, monitor_id: "mon_lat_de" },
      { source: "sh", target: "sg", enabled: false, active: false, monitor_id: "mon_lat_sg" },
    ],
    ...over,
  };
}

const rollups: LatencyRollups = {
  generated_at: "2026-10-03T12:00:00Z",
  interval_sec: 60,
  pairs: [
    { source: "sh", target: "jp", monitor_id: "mon_lat_jp", windows: { "1h": { samples: 60, failures: 1, expected: 60, p50_ms: 42.4, p95_ms: 61.8, loss: 1 / 60 } } },
    { source: "sh", target: "us", monitor_id: "mon_lat_us", windows: { "1h": { samples: 20, failures: 20, expected: 60, loss: 1 } } },
    { source: "sh", target: "de", monitor_id: "mon_lat_de", windows: { "1h": { samples: 0, failures: 0, expected: 60 } } },
    { source: "sh", target: "sg", monitor_id: "mon_lat_sg", windows: { "1h": { samples: 12, failures: 0, expected: 60, p50_ms: 80, p95_ms: 90, loss: 0 } } },
  ],
};

test("targets are rows and sources columns, in name order, mainland nodes left out", () => {
  const m = buildLatencyMatrix(plan(), rollups, "1h", "p50");
  assert.deepEqual(m.sources.map((s) => s.name), ["cd-hs-sh"]);
  assert.deepEqual(m.rows.map((r) => r.node.name), ["de-fsn", "gomami-jp", "hk-relay", "sg-1", "us-nat"]);
  assert.deepEqual(m.counts, { targets: 5, measured: 1, unknown: 1, failing: 1, paused: 1, notProbeable: 1 });
});

test("a pair never heard is unknown and carries no band; green only for a measured p50 under 50 ms", () => {
  const m = buildLatencyMatrix(plan(), rollups, "1h", "p50");
  const cell = (target: string) => m.rows.find((r) => r.node.node_id === target)!.cells[0]!;
  assert.equal(cell("de").kind, "unknown");
  assert.equal(cell("de").band, undefined);
  assert.equal(cell("jp").kind, "measured");
  assert.equal(cell("jp").band, "success");
  assert.equal(cell("jp").valueMs, 42.4);
  // Probes heard, none succeeded: not unknown, not a latency.
  assert.equal(cell("us").kind, "failing");
  assert.equal(cell("us").loss, 1);
  assert.equal(cell("us").partial, true);
  assert.equal(cell("hk").kind, "notProbeable");
  // A switched-off pair keeps its history but draws no band.
  assert.equal(cell("sg").kind, "paused");
  assert.equal(cell("sg").pausedReason, "pair_off");
  assert.equal(cell("sg").hasHistory, true);
  assert.equal(cell("sg").band, undefined);
});

test("with no rollups read yet every running pair is unknown, never green", () => {
  const m = buildLatencyMatrix(plan(), undefined, "24h", "p50");
  for (const row of m.rows) {
    for (const cell of row.cells) {
      assert.notEqual(cell.kind, "measured");
      assert.equal(cell.band, undefined);
    }
  }
});

test("p95 reads the p95 and colours by it", () => {
  const m = buildLatencyMatrix(plan(), rollups, "1h", "p95");
  const jp = m.rows.find((r) => r.node.node_id === "jp")!.cells[0]!;
  assert.equal(jp.valueMs, 61.8);
  assert.equal(jp.band, "chart-2");
});

test("a whole configuration switched off reads config_off; a source that cannot probe reads source", () => {
  const off = plan({ config: { ...plan().config, enabled: false }, pairs: plan().pairs.map((p) => ({ ...p, active: false })) });
  const m = buildLatencyMatrix(off, rollups, "1h", "p50");
  assert.equal(m.rows.find((r) => r.node.node_id === "jp")!.cells[0]!.pausedReason, "config_off");

  const withGhost = plan({ config: { ...plan().config, sources: ["sh", "gone"] }, source_notes: { gone: "unknown_node" } });
  const m2 = buildLatencyMatrix(withGhost, rollups, "1h", "p50");
  assert.deepEqual(m2.sources.map((s) => [s.name, s.note]), [["cd-hs-sh", undefined], ["gone", "unknown_node"]]);
  assert.equal(m2.rows[0]!.cells[1]!.pausedReason, "source");
});

test("a source is never its own target", () => {
  const p = plan({
    config: { ...plan().config, sources: ["sh", "jp"] },
    pairs: [...plan().pairs, { source: "jp", target: "us", enabled: true, active: true, monitor_id: "mon_lat_us" }],
  });
  const jpRow = buildLatencyMatrix(p, rollups, "1h", "p50").rows.find((r) => r.node.node_id === "jp")!;
  assert.equal(jpRow.cells[1]!.kind, "self");
});

test("the attention list holds failing pairs and lossy ones, worst first", () => {
  const lossy: LatencyRollups = {
    ...rollups,
    pairs: rollups.pairs.map((r) => (r.target === "jp" ? { ...r, windows: { "1h": { samples: 60, failures: 15, expected: 60, p50_ms: 180, p95_ms: 260, loss: 0.25 } } } : r)),
  };
  const problems = latencyProblems(buildLatencyMatrix(plan(), lossy, "1h", "p50"));
  assert.deepEqual(problems.map((p) => [p.target.node_id, p.unreachable, p.worstLoss]), [["us", true, 1], ["jp", false, 0.25]]);
});

test("a target several sources cannot reach is one attention entry", () => {
  const three = plan({
    config: { ...plan().config, sources: ["sh", "bj"] },
    pairs: [...plan().pairs, { source: "bj", target: "us", enabled: true, active: true, monitor_id: "mon_lat_us" }],
  });
  const both: LatencyRollups = {
    ...rollups,
    pairs: [...rollups.pairs, { source: "bj", target: "us", monitor_id: "mon_lat_us", windows: { "1h": { samples: 60, failures: 60, expected: 60, loss: 1 } } }],
  };
  const problems = latencyProblems(buildLatencyMatrix(three, both, "1h", "p50"));
  assert.equal(problems.length, 1);
  assert.deepEqual(problems[0]!.pairs.map((p) => p.source.nodeId).sort(), ["bj", "sh"]);
  assert.equal(problems[0]!.unreachable, true);
});

test("formats read the way an operator reads them", () => {
  assert.equal(formatMs(4.24), "4.2 ms");
  assert.equal(formatMs(168.4), "168 ms");
  assert.equal(formatMs(1240), "1.24 s");
  assert.equal(formatMs(undefined), "");
  assert.equal(formatLoss(0), "0%");
  assert.equal(formatLoss(0.004), "<1%");
  assert.equal(formatLoss(0.126), "13%");
  assert.equal(formatLoss(1), "100%");
  assert.equal(latencyBand(undefined), undefined);
  assert.equal(latencyBand(251), "destructive");
  assert.equal(chartCeiling(42), 50);
  assert.equal(chartCeiling(260), 500);
  assert.equal(chartCeiling(1800), 2000);
});

test("pair keys survive a round trip and refuse half a pair", () => {
  assert.deepEqual(parsePairKey(pairKey("node_a", "node_b")), { source: "node_a", target: "node_b" });
  assert.equal(parsePairKey("node_a~"), undefined);
  assert.equal(parsePairKey("~node_b"), undefined);
  assert.equal(parsePairKey(null), undefined);
});

test("the series keeps every bucket, gaps as unknown at full height, measured scaled to a round ceiling", () => {
  const series: LatencySeries = {
    source: "sh",
    target: "jp",
    monitor_id: "mon_lat_jp",
    window: "1h",
    bucket_sec: 60,
    from: "2026-10-03T11:00:00Z",
    to: "2026-10-03T12:00:00Z",
    buckets: [
      { at: "2026-10-03T11:00:00Z", samples: 1, failures: 0, expected: 1, p50_ms: 40, p95_ms: 40, loss: 0 },
      { at: "2026-10-03T11:01:00Z", samples: 0, failures: 0, expected: 1 },
      { at: "2026-10-03T11:02:00Z", samples: 1, failures: 1, expected: 1, loss: 1 },
      { at: "2026-10-03T11:03:00Z", samples: 1, failures: 0, expected: 1, p50_ms: 90, p95_ms: 120, loss: 0 },
    ],
  };
  const { bars, ceilingMs } = seriesBars(series, "p50");
  assert.equal(ceilingMs, 200);
  assert.deepEqual(bars.map((b) => b.kind), ["measured", "unknown", "failing", "measured"]);
  assert.equal(bars[0]!.height, 0.2);
  assert.equal(bars[3]!.p95, 0.6);
  assert.equal(bars[1]!.band, undefined);
});

test("the draft round-trips the configuration and edits only what it is told", () => {
  const config = { enabled: true, interval_sec: 60, timeout_sec: 5, sources: ["sh"], auto_targets: true, include_targets: ["bj"], exclude_targets: [], disabled_pairs: [], version: 3 };
  const draft = draftFromConfig(config);
  assert.equal(draftsDiffer(draft, draftFromConfig(config)), false);
  assert.deepEqual(draftToConfig(draft), { ...config, include_targets: ["bj"] });

  let edited = setTargetMode(draft, "jp", "never");
  assert.equal(targetMode(edited, "jp"), "never");
  edited = setTargetMode(edited, "bj", "auto");
  assert.equal(targetMode(edited, "bj"), "auto");
  edited = setSource(edited, "de", true);
  assert.deepEqual(edited.sources, ["de", "sh"]);
  edited = setPairEnabled(edited, "sh", "us", false);
  assert.equal(pairEnabledIn(edited, "sh", "us"), false);
  edited = setPairEnabled(edited, "sh", "us", true);
  assert.equal(pairEnabledIn(edited, "sh", "us"), true);
  assert.equal(draftsDiffer(draft, edited), true);
  assert.equal(draftToConfig(edited).version, 3, "a save names the version the draft was read at");
});

test("the draft refuses what the server refuses", () => {
  const draft = draftFromConfig({ enabled: true, interval_sec: 60, timeout_sec: 5, sources: [], auto_targets: true, version: 0 });
  assert.deepEqual(draftProblems(draft), []);
  assert.deepEqual(draftProblems({ ...draft, intervalSec: 5 }), ["interval"]);
  assert.deepEqual(draftProblems({ ...draft, timeoutSec: 31 }), ["timeout"]);
  assert.deepEqual(draftProblems({ ...draft, intervalSec: 10, timeoutSec: 10 }), ["timeoutVsInterval"]);
});

test("the editor's target preview follows the server's rule", () => {
  const p = plan();
  const draft = draftFromConfig(p.config);
  const node = (id: string) => p.nodes.find((n) => n.node_id === id)!;
  assert.deepEqual(draftTargetReason(draft, node("jp"), false), { target: true, reason: "auto" });
  assert.deepEqual(draftTargetReason(draft, node("bj"), false), { target: false, reason: "mainland" });
  assert.deepEqual(draftTargetReason(setTargetMode(draft, "bj", "always"), node("bj"), false), { target: true, reason: "included" });
  assert.deepEqual(draftTargetReason(setTargetMode(draft, "jp", "never"), node("jp"), false), { target: false, reason: "excluded" });
  assert.deepEqual(draftTargetReason({ ...draft, autoTargets: false }, node("jp"), false), { target: false, reason: "auto_off" });
  assert.deepEqual(draftTargetReason(draft, node("jp"), true), { target: false, reason: "node_disabled" });
});

test("every code the plan and the page interpolate into a key has copy in both locales", async () => {
  const en = (await import("../../../i18n/locales/en/fleet.ts")).default as Record<string, any>;
  const zh = (await import("../../../i18n/locales/zh-CN/fleet.ts")).default as Record<string, any>;
  const groups: Record<string, string[]> = {
    window: ["1h", "24h", "7d"],
    reason: ["auto", "included", "excluded", "mainland", "region_unknown", "auto_off", "node_disabled", "config_off", "pairs_off", "no_source"],
    endpointNote: ["last_known", "no_public_address", "udp_only", "no_tcp_line", "no_inventory"],
    paused: ["pair_off", "config_off", "source", "target"],
    sourceNote: ["unknown_node", "node_disabled"],
  };
  const configGroups: Record<string, string[]> = { mode: ["auto", "always", "never"], problem: ["interval", "timeout", "timeoutVsInterval"] };
  for (const [locale, messages] of [["en", en], ["zh-CN", zh]] as const) {
    const latency = messages.fleet.monitoring.latency;
    for (const [group, codes] of Object.entries(groups)) {
      for (const code of codes) assert.equal(typeof latency[group]?.[code], "string", `${locale}: fleet.monitoring.latency.${group}.${code}`);
    }
    for (const [group, codes] of Object.entries(configGroups)) {
      for (const code of codes) assert.equal(typeof latency.config[group]?.[code], "string", `${locale}: fleet.monitoring.latency.config.${group}.${code}`);
    }
  }
});
