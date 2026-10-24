import assert from "node:assert/strict";
import { test } from "node:test";

import type { LatencyProbePlan, LatencyRollups, LatencySeries } from "@/lib/api/types";

import {
  buildLatencyMatrix,
  cellQuietFor,
  chartCeiling,
  coveragePercent,
  draftFromConfig,
  draftProblems,
  draftTargetReason,
  draftToConfig,
  draftsDiffer,
  formatLoss,
  formatMs,
  groupLatencyRows,
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
  pathSetMethods,
  pathSetPreview,
  setSourceMethod,
  sourcePins,
  sourceMethod,
  alertAfterValid,
  alertPagesLine,
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
  // The path set sheet and the graph's cards interpolate these; the Latency page that read the rest is gone.
  const groups: Record<string, string[]> = {
    reason: ["auto", "included", "excluded", "mainland", "region_unknown", "auto_off", "node_disabled", "config_off", "pairs_off", "no_source"],
    endpointNote: ["last_known", "no_public_address", "udp_only", "no_tcp_line", "no_inventory"],
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

test("matrix rows group by region, near mainland China first, then country and name", () => {
  const m = buildLatencyMatrix(plan(), rollups, "1h", "p50");
  const groups = groupLatencyRows(m.rows);
  assert.deepEqual(
    groups.map((g) => [g.region, g.rows.map((r) => r.node.name)]),
    [
      ["eastAsia", ["hk-relay", "gomami-jp"]],
      ["southeastAsia", ["sg-1"]],
      ["northAmerica", ["us-nat"]],
      ["europe", ["de-fsn"]],
    ],
  );
});

test("coverage under one percent says so instead of rounding to 0%", () => {
  assert.equal(coveragePercent(0.003), "<1");
  assert.equal(coveragePercent(0.2), "20");
  assert.equal(coveragePercent(0), "0");
});

test("a measured cell whose last probe is old reads as quiet; a fresh one does not", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(cellQuietFor({ kind: "measured", lastAt: now - 2 * 86_400_000 }, 60, now), 2 * 86_400_000);
  assert.equal(cellQuietFor({ kind: "measured", lastAt: now - 30_000 }, 60, now), undefined);
  assert.equal(cellQuietFor({ kind: "unknown", lastAt: now - 2 * 86_400_000 }, 60, now), undefined, "nothing heard already says so");
  assert.equal(cellQuietFor({ kind: "failing", lastAt: undefined }, 60, now), undefined);
});

/* ---- The path set's method (design 29 M2a) ---- */

test("method and pins: sent only when set, so a server before M2a is never sent a field it refuses", () => {
  const d = draftFromConfig(plan().config);
  assert.equal(d.method, "");
  assert.deepEqual(d.sourceMethods, {});
  const out = draftToConfig(d);
  assert.equal("method" in out, false);
  assert.equal("source_methods" in out, false);
  const auto = setSourceMethod({ ...d, method: "auto" }, "sh", "icmp");
  assert.deepEqual(draftToConfig(auto).method, "auto");
  assert.deepEqual(draftToConfig(auto).source_methods, { sh: "icmp" });
  // A pin for a node that is no longer a source is not saved.
  assert.equal(draftToConfig(setSourceMethod(d, "gone", "icmp")).source_methods, undefined);
  assert.deepEqual(setSourceMethod(auto, "sh", undefined).sourceMethods, {});
});

test("a stored tcp reads as the empty method it means, so opening and saving changes nothing", () => {
  const stored = { ...plan().config, method: "tcp", source_methods: { sh: "auto", other: "" } };
  const d = draftFromConfig(stored);
  assert.equal(d.method, "");
  assert.deepEqual(d.sourceMethods, { sh: "auto" });
  assert.equal(draftsDiffer(d, draftFromConfig({ ...plan().config, source_methods: { sh: "auto" } })), false);
  assert.equal(sourceMethod(d, "sh"), "auto");
  assert.equal(sourceMethod(d, "elsewhere"), "tcp");
});

test("the preview counts each source's targets by the method it will use", () => {
  const p = plan({
    config: { ...plan().config, sources: ["sh", "bj"] },
    nodes: plan().nodes.map((n) => (n.node_id === "jp" ? { ...n, icmp_target: "203.0.113.3" } : n.node_id === "de" ? { ...n, icmp_target: "203.0.113.9" } : n)),
  });
  const nodes = [
    { id: "sh", name: "cd-hs-sh", online: true, probe_methods: ["http", "icmp", "tcp"] },
    { id: "bj", name: "cd-bj", online: true, probe_methods: ["http", "tcp"] },
    { id: "us", name: "us-nat", online: true },
    { id: "sg", name: "sg-1", online: true, public_ip: "203.0.113.8" },
  ];
  // Targets under the draft: jp, hk (no TCP line), us, de, sg.
  const by = (rows: ReturnType<typeof pathSetPreview>, source: string) => rows.find((r) => r.source === source)!;
  const tcp = pathSetPreview(draftFromConfig(p.config), p, nodes);
  assert.deepEqual(tcp.map((r) => [r.source, r.method, r.tcp, r.icmp, r.none]), [["bj", "tcp", 4, 0, 1], ["sh", "tcp", 4, 0, 1]]);
  const auto = pathSetPreview({ ...draftFromConfig(p.config), method: "auto" }, p, nodes);
  // sh runs icmp: jp, de and sg have a public IPv4; us and hk fall to tcp (us has a line, hk none).
  assert.deepEqual([by(auto, "sh").icmp, by(auto, "sh").tcp, by(auto, "sh").none], [3, 1, 1]);
  // bj does not run icmp: auto falls back to tcp.
  assert.deepEqual([by(auto, "bj").icmp, by(auto, "bj").tcp, by(auto, "bj").none, by(auto, "bj").refusal], [0, 4, 1, undefined]);
  // A target the plan pings but cannot dial over TCP (a note, no line) is unreachable by TCP, not resolved on save.
  const noted = plan({ ...p, nodes: p.nodes.map((n) => (n.node_id === "hk" ? { ...n, target: "probed", endpoint_note: "udp_only" } : n)) });
  assert.equal(by(pathSetPreview(draftFromConfig(noted.config), noted, nodes), "bj").onSave, 0);
  const pinned = pathSetPreview(setSourceMethod({ ...draftFromConfig(p.config), method: "auto" }, "bj", "icmp"), p, nodes);
  // A pin never falls back: bj pinned to icmp reaches nothing and says why.
  assert.deepEqual([by(pinned, "bj").pinned, by(pinned, "bj").icmp, by(pinned, "bj").none, by(pinned, "bj").refusal], [true, 0, 5, "agent_too_old"]);
  // The targets it cannot reach are named, so the preview can say which.
  assert.deepEqual(by(tcp, "sh").noneTargets, ["hk"]);
  assert.equal(by(pinned, "bj").noneTargets.length, 5);
});

test("Beacon joins the path set's methods and pins on an M2b server only", () => {
  assert.deepEqual(pathSetMethods(false), ["", "icmp", "auto"]);
  assert.deepEqual(pathSetMethods(true), ["", "icmp", "beacon", "auto"]);
  assert.deepEqual(sourcePins(false), ["tcp", "icmp", "auto"]);
  assert.deepEqual(sourcePins(true), ["tcp", "icmp", "beacon", "auto"]);
  assert.deepEqual(sourcePins(false, "beacon"), ["tcp", "icmp", "auto", "beacon"], "a pin the server holds stays offered");
});

test("the preview follows D12's order: Beacon where the plan admits the source, ICMP unless filtered, then TCP", () => {
  const base = plan();
  const p: LatencyProbePlan = {
    ...base,
    config: { ...base.config, method: "auto" },
    nodes: base.nodes.map((n) => (n.node_id === "jp" ? { ...n, beacon_target: "203.0.113.3:47231" } : n.node_id === "de" ? { ...n, beacon_target: "203.0.113.9:51388" } : n)),
    pairs: [
      // jp's beacon admits sh and listens: the planner put the pair on beacon.
      { source: "sh", target: "jp", enabled: true, active: true, monitor_id: "mon_latb_jp", method: "beacon" },
      // de has a beacon but has not admitted sh: Auto stays on icmp.
      { source: "sh", target: "de", enabled: true, active: true, monitor_id: "mon_lati_de", method: "icmp" },
      // sg reads icmp_filtered for sh, so Auto kept it on tcp.
      { source: "sh", target: "sg", enabled: true, active: true, monitor_id: "mon_lat_sg", method: "tcp" },
      { source: "sh", target: "us", enabled: true, active: true, monitor_id: "mon_lat_us", method: "tcp" },
      { source: "sh", target: "hk", enabled: true, active: false, method: "tcp", reason: "not_probeable" },
    ],
  };
  const nodes = [
    { id: "sh", name: "cd-hs-sh", online: true, public_ip: "203.0.113.1", probe_methods: ["beacon", "http", "icmp", "tcp"] },
    { id: "jp", name: "gomami-jp", online: true, public_ip: "203.0.113.3", beacon: { responder: true, state: "listening" as const } },
    { id: "de", name: "de-fsn", online: true, public_ip: "203.0.113.9", beacon: { responder: true, state: "listening" as const } },
    { id: "sg", name: "sg-1", online: true, public_ip: "203.0.113.8" },
    { id: "us", name: "us-nat", online: true },
    { id: "hk", name: "hk-relay", online: true },
  ];
  const sg = { ...draftFromConfig(p.config), disabledPairs: [] };
  const auto = pathSetPreview(sg, p, nodes)[0]!;
  assert.deepEqual([auto.beacon, auto.icmp, auto.tcp, auto.none], [1, 1, 2, 1], "jp by beacon, de by icmp, sg (filtered) and us by tcp, hk unreached");

  const pinned = pathSetPreview(setSourceMethod(sg, "sh", "beacon"), p, nodes)[0]!;
  // jp admits sh; de has a beacon that has not admitted sh yet; the rest have no beacon.
  assert.deepEqual([pinned.beacon, pinned.beaconWaiting, pinned.none, pinned.waitingTargets], [1, 1, 3, ["de"]]);
  assert.deepEqual(pinned.noneReasons, { sg: "beacon_not_enabled", us: "beacon_not_enabled", hk: "beacon_not_enabled" }, "a target without a beacon says so");
  // A beacon that cannot answer is not waiting on a plan: no plan fixes it, so it is not reached, with why.
  const withDe = (beacon?: { responder?: boolean; refusal?: string; state?: string }) => nodes.map((n) => (n.id === "de" ? { ...n, beacon } : n));
  const refused = pathSetPreview(setSourceMethod(sg, "sh", "beacon"), p, withDe({ responder: true, refusal: "refused_by_node", state: "listening" as const }))[0]!;
  assert.deepEqual([refused.beaconWaiting, refused.none, refused.noneReasons.de], [0, 4, "refused_by_node"]);
  const tooOld = pathSetPreview(setSourceMethod(sg, "sh", "beacon"), p, withDe(undefined))[0]!;
  assert.equal(tooOld.noneReasons.de, "agent_too_old", "an agent that reports no beacon has no responder");
  const down = pathSetPreview(setSourceMethod(sg, "sh", "beacon"), p, withDe({ responder: true, state: "bind_failed" as const }))[0]!;
  assert.equal(down.noneReasons.de, "beacon_not_listening");

  const old = pathSetPreview(setSourceMethod(sg, "sh", "beacon"), p, [{ ...nodes[0]!, probe_methods: ["http", "icmp", "tcp"] }, ...nodes.slice(1)])[0]!;
  assert.deepEqual([old.refusal, old.refusalMethod, old.beacon, old.none], ["agent_too_old", "beacon", 0, 5]);
});

test("the path set keeps its alert, run count and thresholds through any save, a pause from the path sheet included (design 29 D13)", () => {
  const config = {
    enabled: true,
    interval_sec: 60,
    timeout_sec: 5,
    sources: ["sh"],
    auto_targets: true,
    include_targets: [],
    exclude_targets: [],
    disabled_pairs: [],
    alert: "down_and_degraded",
    alert_after: 4,
    degraded: { loss_percent: 5, latency_margin_ms: 50 },
    version: 7,
  };
  const draft = draftFromConfig(config);
  assert.equal(draft.alert, "down_and_degraded");
  assert.equal(draft.alertAfter, 4);
  const paused = draftToConfig(setPairEnabled(draft, "sh", "jp", false));
  assert.equal(paused.alert, "down_and_degraded");
  assert.equal(paused.alert_after, 4);
  assert.deepEqual(paused.degraded, { loss_percent: 5, latency_margin_ms: 50 });
  assert.deepEqual(paused.disabled_pairs, [{ source: "sh", target: "jp" }]);
  // A stored path set without them sends none of them back: an older server decodes the body strictly.
  const bare = draftToConfig(draftFromConfig({ ...config, alert: undefined, alert_after: undefined, degraded: undefined }));
  assert.equal("alert" in bare || "alert_after" in bare || "degraded" in bare, false);
  // The default run count and default thresholds are not stored.
  const defaults = draftToConfig({ ...draft, alertAfter: 2, degraded: { lossPercent: 2, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 30 } });
  assert.equal(defaults.alert_after, undefined);
  assert.equal(defaults.degraded, undefined);
  assert.deepEqual(draftProblems({ ...draft, alertAfter: 25 }), ["alertAfter"]);
  assert.deepEqual(draftProblems({ ...draft, degraded: { ...draft.degraded, lossFactor: 50 } }), ["degraded"]);
});

test("the path set's alert line names the run count in force, and none while the field holds one the save refuses", () => {
  assert.deepEqual(alertPagesLine({ alert: "", alertAfter: 0 }), { policy: "off" }, "a path set nobody set reads off");
  assert.deepEqual(alertPagesLine({ alert: "off", alertAfter: 25 }), { policy: "off" }, "off pages nothing, whatever the count");
  assert.deepEqual(alertPagesLine({ alert: "down", alertAfter: 0 }), { policy: "down", after: 2 }, "a stored zero reads as the default");
  assert.deepEqual(alertPagesLine({ alert: "down_and_degraded", alertAfter: 5 }), { policy: "down_and_degraded", after: 5 });
  assert.deepEqual(alertPagesLine({ alert: "down", alertAfter: 20 }), { policy: "down", after: 20 });
  // The field says "1 to 20"; the line under it must not say "pages after 25" (or the default for a cleared field).
  for (const bad of [21, 25, -1, 1.5, Number.NaN]) assert.deepEqual(alertPagesLine({ alert: "down", alertAfter: bad }), { policy: "down" }, String(bad));
  // One rule for the line and the save's problem.
  for (const n of [0, 1, 20, 21, -1, 2.5, Number.NaN]) assert.equal(alertAfterValid(n), n === 0 || n === 1 || n === 20, String(n));
});
