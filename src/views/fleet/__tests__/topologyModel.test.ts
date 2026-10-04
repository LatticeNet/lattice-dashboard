import assert from "node:assert/strict";
import { test } from "node:test";

import type { Incident, LatencyProbePlan, LatencyRollups, LineChainView, MonitorView, Node } from "@/lib/api/types";

import {
  CHECK_FAN,
  CONTROL_PLANE,
  COLLAPSE_AT,
  LEFT_W,
  ROW_H,
  SOURCES_TOP,
  TOP_LANE,
  buildTopology,
  chainState,
  checkEndpoint,
  edgeStyle,
  layoutTopology,
  neighbourhood,
  pathsWorstFirst,
  quietAfterMs,
  regionOf,
  rowProbe,
  type TopologyInput,
} from "../topologyModel.ts";

const NOW = Date.parse("2026-10-04T08:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function node(id: string, name: string, country: string | undefined, over: Partial<Node> = {}): Node {
  return {
    id,
    name,
    online: true,
    status: "online",
    last_seen: ago(3000),
    geo: country ? { country } : undefined,
    ...over,
  } as Node;
}

const NODES: Node[] = [
  node("sh", "cd-hs-sh", "CN"),
  node("bj", "cd-bj-iplc", "CN"),
  node("hk", "gomami-hk", "HK"),
  node("jp", "xuezhang-jp", "JP"),
  node("us1", "DMIT-pro-malibu", "US"),
  node("us2", "VIRCS-ATT", "US"),
  node("us4", "DMIT-4", "US", { status: "offline", online: false, last_seen: ago(6 * 86_400_000) }),
  node("de", "hetzner-fsn", "DE"),
  node("x", "no-country", undefined),
];

function plan(over: Partial<LatencyProbePlan> = {}): LatencyProbePlan {
  const target = (id: string, name: string, country: string, extra = {}) => ({
    node_id: id,
    name,
    country,
    region: "outside_mainland",
    source: false,
    target: "probed",
    target_reason: "auto",
    endpoint: `203.0.113.${id.length}:443`,
    monitor_id: `mon_lat_${id}`,
    ...extra,
  });
  return {
    config: { enabled: true, interval_sec: 60, timeout_sec: 5, sources: ["sh"], auto_targets: true, version: 3 },
    stored: true,
    default_source_name: "cd-hs-sh",
    nodes: [
      { node_id: "sh", name: "cd-hs-sh", country: "CN", region: "mainland", source: true, target: "none", target_reason: "mainland" },
      { node_id: "bj", name: "cd-bj-iplc", country: "CN", region: "mainland", source: false, target: "none", target_reason: "mainland" },
      target("hk", "gomami-hk", "HK"),
      target("jp", "xuezhang-jp", "JP", { target: "not_probeable", endpoint: undefined, endpoint_note: "udp_only", monitor_id: undefined }),
      target("us1", "DMIT-pro-malibu", "US"),
      target("us2", "VIRCS-ATT", "US"),
      target("us4", "DMIT-4", "US", { endpoint_note: "last_known" }),
      target("de", "hetzner-fsn", "DE", { target: "paused", target_reason: "pairs_off" }),
    ],
    pairs: [
      { source: "sh", target: "hk", enabled: true, active: true, monitor_id: "mon_lat_hk" },
      { source: "sh", target: "jp", enabled: true, active: false },
      { source: "sh", target: "us1", enabled: true, active: true, monitor_id: "mon_lat_us1" },
      { source: "sh", target: "us2", enabled: true, active: true, monitor_id: "mon_lat_us2" },
      { source: "sh", target: "us4", enabled: true, active: true, monitor_id: "mon_lat_us4" },
      { source: "sh", target: "de", enabled: false, active: false, monitor_id: "mon_lat_de" },
    ],
    ...over,
  };
}

const latest = (monitor: string, at: number, ok = true, ms?: number) => ({ monitor_id: monitor, node_id: "sh", at: ago(at), success: ok, latency_ms: ms });

const ROLLUPS: LatencyRollups = {
  generated_at: ago(0),
  interval_sec: 60,
  pairs: [
    { source: "sh", target: "hk", monitor_id: "mon_lat_hk", windows: { "1h": { samples: 60, failures: 0, expected: 60, p50_ms: 34, p95_ms: 41, loss: 0 }, "7d": { samples: 10_000, failures: 10, expected: 10_080, p50_ms: 36, p95_ms: 50, loss: 0.001 } }, latest: latest("mon_lat_hk", 20_000, true, 33) },
    { source: "sh", target: "us1", monitor_id: "mon_lat_us1", windows: { "1h": { samples: 60, failures: 21, expected: 60, p50_ms: 162, p95_ms: 190, loss: 0.35 } }, latest: latest("mon_lat_us1", 25_000, false) },
    { source: "sh", target: "us2", monitor_id: "mon_lat_us2", windows: { "1h": { samples: 60, failures: 60, expected: 60, loss: 1 } }, latest: latest("mon_lat_us2", 30_000, false) },
    // Offline target: nothing this hour, plenty over the week, last probe two days ago.
    { source: "sh", target: "us4", monitor_id: "mon_lat_us4", windows: { "1h": { samples: 0, failures: 0, expected: 60 }, "7d": { samples: 8000, failures: 80, expected: 10_080, p50_ms: 175, p95_ms: 210, loss: 0.01 } }, latest: latest("mon_lat_us4", 2 * 86_400_000, true, 170) },
    { source: "sh", target: "de", monitor_id: "mon_lat_de", windows: { "1h": { samples: 0, failures: 0, expected: 60 }, "7d": { samples: 3000, failures: 0, expected: 10_080, p50_ms: 241, p95_ms: 260, loss: 0 } } },
  ],
};

const CHAINS: LineChainView[] = [
  { source_line_uuid: "line-bj", source_node_id: "bj", status: "converged", current: { target_node_id: "hk", target_line_uuid: "line-hk", artifact_digest: "a", status: "converged" }, attempt: null },
  { source_line_uuid: "line-hk", source_node_id: "hk", status: "drifted", current: { target_node_id: "us1", target_line_uuid: "line-us1", artifact_digest: "b", status: "drifted" }, attempt: null, last_error: "target_line_changed" },
  { source_line_uuid: "line-new", source_node_id: "jp", status: "planned", current: null, attempt: { operation: "set", approval_id: "apr_1", status: "planned" } },
];

function monitor(over: Partial<MonitorView>): MonitorView {
  return { id: "mon", name: "check", type: "http", target: "https://example.net/healthz", interval_sec: 60, timeout_sec: 10, enabled: true, latest: [], ...over } as MonitorView;
}

function input(over: Partial<TopologyInput> = {}): TopologyInput {
  return { nodes: NODES, plan: plan(), rollups: ROLLUPS, chains: CHAINS, monitors: [], incidents: [], window: "1h", layer: "all", now: NOW, ...over };
}

const edge = (m: ReturnType<typeof buildTopology>, id: string) => m.edges.find((e) => e.id === id)!;

/* ---- Regions ---- */

test("regions run in order of distance from mainland China; Hong Kong is not mainland; no country sorts last", () => {
  assert.equal(regionOf("CN"), "mainland");
  assert.equal(regionOf("hk"), "eastAsia");
  assert.equal(regionOf("TW"), "eastAsia");
  assert.equal(regionOf("SG"), "southeastAsia");
  assert.equal(regionOf("US"), "northAmerica");
  assert.equal(regionOf("FI"), "europe");
  assert.equal(regionOf("ZZ"), "other");
  assert.equal(regionOf(undefined), "unknown");
  const m = buildTopology(input());
  assert.deepEqual(
    m.members.map((n) => n.id),
    ["bj", "hk", "jp", "us4", "us1", "us2", "de", "x"],
    "region, then country, then name; the probe source sits in the left column",
  );
  assert.deepEqual(m.sources.map((n) => n.id), ["sh"]);
});

/* ---- Probe classification ---- */

test("probe edges take the matrix's rule: measured, lossy, failing, unknown, paused; not-probeable draws nothing", () => {
  const m = buildTopology(input());
  assert.equal(edge(m, "probe:sh~hk").state, "measured");
  assert.equal(edge(m, "probe:sh~hk").band, "success");
  assert.equal(edge(m, "probe:sh~us1").state, "lossy", "35% loss is at or over LOSS_ATTENTION");
  assert.equal(edge(m, "probe:sh~us1").band, "warning");
  assert.equal(edge(m, "probe:sh~us2").state, "failing");
  assert.equal(edge(m, "probe:sh~us2").band, undefined);
  assert.equal(edge(m, "probe:sh~us4").state, "unknown", "nothing heard this hour is unknown, never a colour");
  assert.equal(edge(m, "probe:sh~de").state, "paused");
  assert.equal(edge(m, "probe:sh~de").pausedReason, "pair_off");
  assert.equal(m.edges.find((e) => e.to === "jp"), undefined, "a UDP-only target has no probe to draw");
  assert.deepEqual(
    { paths: m.counts.paths, failing: m.counts.failing, lossy: m.counts.lossy, unknown: m.counts.unknown, paused: m.counts.paused, quiet: m.counts.quiet },
    { paths: 5, failing: 1, lossy: 1, unknown: 1, paused: 1, quiet: 0 },
  );
});

test("a 7d number whose last probe is two days old reads as quiet, not as a live colour", () => {
  const m = buildTopology(input({ window: "7d" }));
  const e = edge(m, "probe:sh~us4");
  assert.equal(e.state, "quiet");
  assert.equal(e.quietReason, "old");
  assert.equal(e.p50Ms, 175, "the history stays readable on the card");
  assert.equal(edgeStyle(e).color, "--muted-foreground");
  assert.equal(edgeStyle(e).stroke, "dashed");
  // A pair with a fresh last probe keeps its band over the same window.
  assert.equal(edge(m, "probe:sh~hk").state, "measured");
  assert.equal(quietAfterMs(60), 180_000);
  assert.equal(quietAfterMs(300), 900_000);
});

test("when the source itself stopped reporting, every edge with numbers is history", () => {
  const nodes = NODES.map((n) => (n.id === "sh" ? { ...n, status: "offline", online: false, last_seen: ago(3_600_000) } as Node : n));
  const m = buildTopology(input({ nodes }));
  assert.equal(edge(m, "probe:sh~hk").state, "quiet");
  assert.equal(edge(m, "probe:sh~hk").quietReason, "source");
  assert.equal(edge(m, "probe:sh~us2").state, "quiet");
  assert.equal(edge(m, "probe:sh~us4").state, "unknown", "nothing heard stays unknown");
  assert.equal(edge(m, "probe:sh~de").state, "paused");
});

test("the last sample rides on the edge with its time", () => {
  const m = buildTopology(input());
  assert.deepEqual(edge(m, "probe:sh~hk").last, { at: NOW - 20_000, ok: true, ms: 33, error: undefined });
});

/* ---- Chains ---- */

test("chains run relay to exit; a planned chain with no exit yet is counted, not drawn", () => {
  const m = buildTopology(input());
  const chains = m.edges.filter((e) => e.kind === "chain");
  assert.deepEqual(chains.map((e) => [e.from, e.to, e.state]), [
    ["bj", "hk", "converged"],
    ["hk", "us1", "drifted"],
  ]);
  assert.equal(m.counts.chains, 2);
  assert.equal(m.counts.chainsBroken, 1);
  assert.equal(m.counts.chainsUnplaced, 1);
  assert.equal(m.nodes.get("hk")!.relay && m.nodes.get("hk")!.exit, true, "a middle hop is both");
  assert.equal(edgeStyle(chains[0]!).color, "--primary");
});

test("chain status words", () => {
  assert.equal(chainState({ status: "converged", attempt: null }), "converged");
  assert.equal(chainState({ status: "applying", attempt: null }), "pending");
  assert.equal(chainState({ status: "applied_unobserved", attempt: null }), "pending");
  assert.equal(chainState({ status: "planned", attempt: { operation: "set", approval_id: "a", status: "failed" } }), "failed");
  assert.equal(chainState({ status: "failed", attempt: null }), "failed");
  assert.equal(chainState({ status: "drifted", attempt: null }), "drifted");
});

/* ---- Checks ---- */

test("checks run from their nodes, a certificate watch from the control plane, and stale results say so", () => {
  const monitors = [
    monitor({ id: "relay", name: "HK relay port", type: "tcp", target: "203.0.113.21:443", node_ids: ["us1", "de"], latest: [
      { node_id: "us1", at: ago(10_000), success: false, fail_streak: 3, since: ago(60_000) },
      { node_id: "de", at: ago(3_600_000), success: true, fail_streak: 0, since: ago(86_400_000) },
    ] }),
    monitor({ id: "tls", name: "sub cert", type: "tls", target: "sub.example.net:443", interval_sec: 3600, latest: [{ node_id: "", at: ago(600_000), success: true, fail_streak: 0, since: ago(86_400_000) }] }),
    monitor({ id: "gen", name: "Latency to hk", type: "tcp", managed_by: "latency" }),
  ];
  const m = buildTopology(input({ monitors }));
  assert.deepEqual(m.checks.map((c) => c.monitorId), ["relay", "tls"], "generated monitors are the probes, not checks; failing first");
  assert.equal(edge(m, "check:relay:us1").state, "failing");
  assert.equal(edge(m, "check:relay:de").state, "stale");
  assert.equal(edge(m, "check:tls:@cp").from, CONTROL_PLANE);
  assert.equal(edge(m, "check:tls:@cp").state, "up", "an hourly watch heard ten minutes ago is current");
  assert.equal(m.counts.checksFailing, 1);
});

test("an every-node check draws only the sources with news and counts the rest", () => {
  const latestFor = NODES.filter((n) => n.status !== "offline").map((n, i) => ({ node_id: n.id, at: ago(5_000), success: i !== 2, fail_streak: i === 2 ? 4 : 0, since: ago(60_000) }));
  const m = buildTopology(input({ monitors: [monitor({ id: "all", assign_all: true, latest: latestFor })] }));
  const check = m.checks[0]!;
  assert.equal(check.fannedOut, NODES.length - 0 > CHECK_FAN);
  assert.equal(check.sourceIds.length, NODES.length, "every listed node runs it");
  assert.deepEqual(check.summary, { up: 7, failing: 1, stale: 0, none: 1 });
  assert.deepEqual(m.edges.filter((e) => e.kind === "check").map((e) => [e.from, e.state]).sort(), [["hk", "failing"], ["us4", "none"]]);
});

/* ---- Layers, control plane, incidents ---- */

test("each layer keeps only its own nodes and edges", () => {
  const probes = buildTopology(input({ layer: "probes" }));
  assert.deepEqual(new Set(probes.edges.map((e) => e.kind)), new Set(["probe"]));
  assert.deepEqual(probes.members.map((n) => n.id), ["hk", "jp", "us4", "us1", "us2", "de"]);
  const chains = buildTopology(input({ layer: "chains" }));
  assert.deepEqual(chains.sources, [], "the left column holds probe sources only");
  assert.deepEqual(chains.members.map((n) => n.id), ["bj", "hk", "us1"]);
  const checks = buildTopology(input({ layer: "checks", monitors: [monitor({ id: "m", node_ids: ["de"] })] }));
  assert.deepEqual(checks.members.map((n) => n.id), ["de"]);
});

test("the control plane counts heartbeat freshness over the node list, and says when it had none", () => {
  const nodes = [...NODES, node("never", "gpu-box", "SG", { status: "never_reported", online: false, last_seen: "0001-01-01T00:00:00Z" }), node("off", "kix", "JP", { status: "disabled", disabled: true })];
  const m = buildTopology(input({ nodes }));
  assert.deepEqual(m.cp, { total: 11, fresh: 8, degraded: 0, quiet: 1, never: 1, disabled: 1, known: true });
  assert.equal(m.nodes.get("never")!.lastSeenAt, undefined, "the Go zero time is no beat");
  const blind = buildTopology(input({ nodes: undefined }));
  assert.equal(blind.cp.known, false);
  assert.equal(blind.nodes.get("hk")!.name, "gomami-hk", "names still come from the plan");
  assert.equal(blind.nodes.get("hk")!.freshness, undefined);
});

test("open and acknowledged incidents mark their node; pending and resolved do not", () => {
  const incidents = [
    { id: "i1", key: "k1", kind: "node.offline", severity: "critical", state: "open", node_id: "us4" },
    { id: "i2", key: "k2", kind: "service.down", severity: "warning", state: "acknowledged", node_id: "us4" },
    { id: "pending:k3", key: "k3", kind: "service.down", severity: "warning", state: "pending", node_id: "hk" },
    { id: "i4", key: "k4", kind: "service.down", severity: "warning", state: "resolved", node_id: "hk" },
  ] as Incident[];
  const m = buildTopology(input({ incidents }));
  assert.equal(m.nodes.get("us4")!.incidents, 2);
  assert.equal(m.nodes.get("hk")!.incidents, 0);
});

test("lists run worst first; a row reports its worst probe and how many there are", () => {
  const m = buildTopology(input());
  assert.deepEqual(pathsWorstFirst(m).slice(0, 3).map((e) => e.id), ["probe:sh~us2", "probe:sh~us1", "chain:line-hk"]);
  const three = plan({ config: { ...plan().config, sources: ["sh", "bj"] } });
  three.pairs.push({ source: "bj", target: "hk", enabled: true, active: true, monitor_id: "mon_lat_hk" });
  const rollups = { ...ROLLUPS, pairs: [...ROLLUPS.pairs, { source: "bj", target: "hk", monitor_id: "mon_lat_hk", windows: { "1h": { samples: 60, failures: 60, expected: 60, loss: 1 } } }] };
  const m3 = buildTopology(input({ plan: three, rollups }));
  const row = rowProbe(m3, "hk")!;
  assert.equal(row.count, 2);
  assert.equal(row.edge.state, "failing");
  assert.equal(rowProbe(m3, "jp"), undefined);
});

/* ---- Layout ---- */

test("layout is deterministic and keeps sources left, rows in one column, chains as arcs on its right edge", () => {
  const m = buildTopology(input());
  const a = layoutTopology(m, { width: 1200 });
  const b = layoutTopology(buildTopology(input()), { width: 1200 });
  assert.deepEqual(JSON.parse(JSON.stringify({ ...a, anchorOf: [...a.anchorOf] })), JSON.parse(JSON.stringify({ ...b, anchorOf: [...b.anchorOf] })));
  assert.equal(a.cp.x, 0);
  assert.equal(a.sources[0]!.box.x, 0);
  assert.ok(a.rowsX >= LEFT_W + 72, "a gap for the fan");
  const headers = a.rows.filter((r) => r.type === "header").map((r) => (r.type === "header" ? `${r.region}:${r.count}` : ""));
  assert.deepEqual(headers, ["mainland:1", "eastAsia:2", "northAmerica:3", "europe:1", "unknown:1"]);
  for (const row of a.rows) if (row.type === "node") assert.equal(row.h, ROW_H);
  const chain = a.edges.find((e) => e.edge.id === "chain:line-hk")!;
  const right = a.rowsX + a.rowsW;
  assert.ok(chain.d.startsWith(`M${right} `), "a row to row chain leaves the row's right edge");
  assert.ok(a.edges.findIndex((e) => e.edge.state === "failing") > a.edges.findIndex((e) => e.edge.state === "measured"), "red is drawn over green");
  assert.ok(a.height >= a.rows[a.rows.length - 1]!.y + ROW_H);
});

test("the sources sit right under the control plane and the checks start at the top, however tall the column", () => {
  const monitors = [monitor({ id: "a", node_ids: ["de"] }), monitor({ id: "b", node_ids: ["hk"] })];
  const small = layoutTopology(buildTopology(input({ monitors })), { width: 1200 });
  const tall = layoutTopology(buildTopology(fleet(COLLAPSE_AT, { layer: "all", monitors: [monitor({ id: "a", node_ids: ["n000"] }), monitor({ id: "b", node_ids: ["n001"] })] })), { width: 1200 });
  assert.ok(tall.height > 1500, "a column far taller than one screen");
  for (const a of [small, tall]) {
    const src = a.sources[0]!.box;
    assert.equal(src.y, SOURCES_TOP);
    assert.ok(src.y >= a.cp.y + a.cp.h, "never over the control plane box");
    assert.equal(a.checks[0]!.box.y, 0);
  }
  // Three sources stack down from the same place.
  const three = plan({ config: { ...plan().config, sources: ["sh", "bj", "x"] } });
  const stacked = layoutTopology(buildTopology(input({ plan: three })), { width: 1200 });
  assert.deepEqual(stacked.sources.map((s) => s.box.y), [SOURCES_TOP, SOURCES_TOP + 68, SOURCES_TOP + 136]);
});

test("checks take a right column only when there are checks", () => {
  const none = layoutTopology(buildTopology(input()), { width: 1200 });
  assert.equal(none.checks.length, 0);
  const some = layoutTopology(buildTopology(input({ monitors: [monitor({ id: "m", node_ids: ["de"] })] })), { width: 1200 });
  assert.equal(some.checks.length, 1);
  assert.equal(some.checks[0]!.box.x + some.checks[0]!.box.w, 1200, "pinned to the right edge");
  assert.equal(some.anchorOf.get(checkEndpoint("m")), checkEndpoint("m"));
});

test("a certificate watch's line leaves the control plane over the top of the node column, never through it", () => {
  const tls = monitor({ id: "tls", type: "tls", target: "sub.example.net:443", interval_sec: 3600, latest: [{ node_id: "", at: ago(60_000), success: true, fail_streak: 0, since: ago(86_400_000) }] });
  const a = layoutTopology(buildTopology(input({ monitors: [tls] })), { width: 1200 });
  const line = a.edges.find((e) => e.edge.from === CONTROL_PLANE)!;
  const ys = [...line.d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
  assert.ok(ys.includes(TOP_LANE), line.d);
  // The level run in the lane spans the whole node column.
  const run = line.d.match(new RegExp(`(-?[\\d.]+) ${TOP_LANE} L(-?[\\d.]+) ${TOP_LANE}`))!;
  assert.ok(Number(run[1]) <= a.rowsX && Number(run[2]) >= a.rowsX + a.rowsW, line.d);
});

test("past the fold each country becomes one row and its edges one bundle, coloured by the worst", () => {
  const many: Node[] = [node("sh", "cd-hs-sh", "CN")];
  const targets: LatencyProbePlan["nodes"] = [{ node_id: "sh", name: "cd-hs-sh", country: "CN", region: "mainland", source: true, target: "none" }];
  const pairs: LatencyProbePlan["pairs"] = [];
  const rpairs: LatencyRollups["pairs"] = [];
  const countries = ["US", "JP", "DE", "SG"];
  for (let i = 0; i < COLLAPSE_AT + 40; i++) {
    const id = `n${String(i).padStart(3, "0")}`;
    const country = countries[i % countries.length]!;
    many.push(node(id, `node-${id}`, country));
    targets.push({ node_id: id, name: `node-${id}`, country, region: "outside_mainland", source: false, target: "probed", monitor_id: `m_${id}`, endpoint: "203.0.113.1:443" });
    pairs.push({ source: "sh", target: id, enabled: true, active: true, monitor_id: `m_${id}` });
    // One US node fails outright; the rest measure.
    const failing = id === "n004";
    rpairs.push({ source: "sh", target: id, monitor_id: `m_${id}`, windows: { "1h": failing ? { samples: 60, failures: 60, expected: 60, loss: 1 } : { samples: 60, failures: 0, expected: 60, p50_ms: 150, p95_ms: 170, loss: 0 } }, latest: latest(`m_${id}`, 10_000, !failing, 150) });
  }
  const m = buildTopology({ nodes: many, plan: { ...plan(), nodes: targets, pairs }, rollups: { ...ROLLUPS, pairs: rpairs }, window: "1h", layer: "probes", now: NOW });
  const folded = layoutTopology(m, { width: 1200 });
  assert.equal(folded.collapsed, true);
  const countryRows = folded.rows.filter((r) => r.type === "country");
  assert.equal(countryRows.length, 4);
  assert.equal(folded.rows.filter((r) => r.type === "node").length, 0);
  assert.equal(folded.edges.length, 4, "one bundle per country");
  const us = folded.edges.find((e) => e.key.endsWith(">country:US"))!;
  assert.equal(us.bundle.length, 25);
  assert.equal(us.edge.state, "failing", "the bundle shows its worst member");
  assert.ok(folded.height < 400, "a hundred targets fit in a screen when folded");
  const opened = layoutTopology(m, { width: 1200, expanded: new Set(["US"]) });
  assert.equal(opened.rows.filter((r) => r.type === "node").length, 25);
  assert.equal(opened.anchorOf.get("n004"), "n004");
  assert.equal(opened.anchorOf.get("n001"), "country:JP");
});

test("too narrow for its columns, the drawing keeps them and reports its real width", () => {
  const a = layoutTopology(buildTopology(input({ monitors: [monitor({ id: "m", node_ids: ["de"] })] })), { width: 700 });
  const check = a.checks[0]!.box;
  assert.ok(check.x >= a.rowsX + a.rowsW, "the check column never sits on the node column");
  assert.equal(a.width, check.x + check.w);
});

test("hovering an endpoint lights itself and its neighbours", () => {
  const m = buildTopology(input());
  assert.deepEqual([...neighbourhood(m, "hk")].sort(), ["bj", "hk", "sh", "us1"]);
});

/* ---- Fix pass: rows and bundles, reads, boundaries ---- */

/**
 * One source (sh) and `count` probed targets spread over four countries.
 * `shape` says how each target's probe reads: measured at 150 ms, failing,
 * or measured with a last probe two days old (quiet).
 */
function fleet(
  count: number,
  over: Partial<TopologyInput> & { shape?: (id: string, index: number) => "measured" | "failing" | "old" } = {},
): TopologyInput {
  const { shape = () => "measured", ...rest } = over;
  const nodes: Node[] = [node("sh", "cd-hs-sh", "CN")];
  const targets: LatencyProbePlan["nodes"] = [{ node_id: "sh", name: "cd-hs-sh", country: "CN", region: "mainland", source: true, target: "none" }];
  const pairs: LatencyProbePlan["pairs"] = [];
  const rpairs: LatencyRollups["pairs"] = [];
  const countries = ["US", "JP", "DE", "SG"];
  for (let i = 0; i < count; i++) {
    const id = `n${String(i).padStart(3, "0")}`;
    const country = countries[i % countries.length]!;
    nodes.push(node(id, `node-${id}`, country));
    targets.push({ node_id: id, name: `node-${id}`, country, region: "outside_mainland", source: false, target: "probed", monitor_id: `m_${id}`, endpoint: "203.0.113.1:443" });
    pairs.push({ source: "sh", target: id, enabled: true, active: true, monitor_id: `m_${id}` });
    const kind = shape(id, i);
    const window = kind === "failing" ? { samples: 60, failures: 60, expected: 60, loss: 1 } : { samples: 60, failures: 0, expected: 60, p50_ms: 150, p95_ms: 170, loss: 0 };
    rpairs.push({ source: "sh", target: id, monitor_id: `m_${id}`, windows: { "1h": window }, latest: latest(`m_${id}`, kind === "old" ? 2 * 86_400_000 : 10_000, kind !== "failing", 150) });
  }
  return { nodes, plan: { ...plan(), nodes: targets, pairs }, rollups: { ...ROLLUPS, pairs: rpairs }, chains: [], monitors: [], incidents: [], window: "1h", layer: "probes", now: NOW, ...rest };
}

test("a row speaks for its live probes: one source that stopped reporting does not grey what the others measure", () => {
  const nodes = [...NODES.map((n) => (n.id === "bj" ? ({ ...n, status: "offline", online: false, last_seen: ago(3_600_000) } as Node) : n)), node("gz", "cd-gz", "CN")];
  const three = plan({ config: { ...plan().config, sources: ["sh", "bj", "gz"] } });
  three.pairs.push({ source: "bj", target: "hk", enabled: true, active: true, monitor_id: "mon_lat_hk" }, { source: "gz", target: "hk", enabled: true, active: true, monitor_id: "mon_lat_hk" });
  const win = (p50: number) => ({ "1h": { samples: 60, failures: 0, expected: 60, p50_ms: p50, p95_ms: p50 + 10, loss: 0 } });
  const rollups = {
    ...ROLLUPS,
    pairs: [
      ...ROLLUPS.pairs,
      { source: "bj", target: "hk", monitor_id: "mon_lat_hk", windows: win(40), latest: latest("mon_lat_hk", 20_000, true, 40) },
      { source: "gz", target: "hk", monitor_id: "mon_lat_hk", windows: win(160), latest: latest("mon_lat_hk", 20_000, true, 160) },
    ],
  };
  const m = buildTopology(input({ nodes, plan: three, rollups }));
  assert.equal(edge(m, "probe:bj~hk").state, "quiet", "the dead source's edge is history");
  const row = rowProbe(m, "hk")!;
  assert.equal(row.count, 3);
  assert.equal(row.edge.from, "gz", "the worst live measurement, not the grey history");
  assert.equal(row.edge.state, "measured");
  assert.equal(row.edge.p50Ms, 160);
  // With nothing live, the grey is all there is to show.
  const allDead = buildTopology(input({ nodes: nodes.map((n) => (n.id === "gz" || n.id === "sh" ? ({ ...n, status: "offline", online: false, last_seen: ago(3_600_000) } as Node) : n)), plan: three, rollups }));
  assert.equal(rowProbe(allDead, "hk")!.edge.state, "quiet");
  // Lists still put the quiet path above the healthy ones.
  assert.ok(pathsWorstFirst(m).findIndex((e) => e.id === "probe:bj~hk") < pathsWorstFirst(m).findIndex((e) => e.id === "probe:gz~hk"));
});

test("a folded bundle is drawn as its worst live member; grey only when every member is history", () => {
  // n000, n004, n008 ... are US. One US probe is two days old; the rest measure.
  const some = layoutTopology(buildTopology(fleet(COLLAPSE_AT + 4, { shape: (id) => (id === "n004" ? "old" : "measured") })), { width: 1200 });
  const us = some.edges.find((e) => e.key.endsWith(">country:US"))!;
  assert.ok(us.bundle.some((e) => e.state === "quiet"));
  assert.equal(us.edge.state, "measured");
  const allOld = layoutTopology(buildTopology(fleet(COLLAPSE_AT + 4, { shape: (_id, i) => (i % 4 === 0 ? "old" : "measured") })), { width: 1200 });
  assert.equal(allOld.edges.find((e) => e.key.endsWith(">country:US"))!.edge.state, "quiet");
});

test("chains are drawn as two rails, so shape and not only hue tells them from probes", () => {
  const m = buildTopology(input());
  for (const e of m.edges) assert.equal(!!edgeStyle(e).double, e.kind === "chain", e.id);
});
