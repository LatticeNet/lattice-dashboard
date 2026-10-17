import assert from "node:assert/strict";
import { test } from "node:test";

import type { Incident, LatencyProbePlan, LineChainView, MonitorView, Node, PathView, PathsResponse } from "@/lib/api/types";

import { buildPathsMatrix } from "../pathsModel.ts";
import {
  CHECK_FAN,
  DEFAULT_DRAWN_SOURCES,
  PROBE_TONE,
  drawnSources,
  formatDrawnSources,
  parseDrawnSources,
  probeSourceOrder,
  rowMarks,
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
  layerEmpty,
  layoutTopology,
  missingReads,
  neighbourhood,
  pathsWorstFirst,
  quietAfterMs,
  readState,
  readsFor,
  regionOf,
  rowProbe,
  rowSummary,
  type TopoReadStatus,
  type TopoReadStatuses,
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

type ProbeSpec = Partial<PathView> & { state: string };

/** A path set path from `source` to `target` as the paths route sends it. */
function probe(source: string, target: string, spec: ProbeSpec): PathView {
  return { source, target_node: target, target: "203.0.113.1:443", monitor_id: `mon_lat_${target}`, managed: true, method: "tcp", samples: 60, expected: 60, ...spec };
}

/** The matrix of an M3 server: one row per target, one column per source. */
function matrixOf(paths: PathView[], sources: { node_id: string; name: string }[] = [{ node_id: "sh", name: "cd-hs-sh" }]) {
  const targets = [...new Set(paths.map((p) => p.target_node!).filter(Boolean))].map((id) => {
    const n = NODES.find((x) => x.id === id);
    return { node_id: id, name: n?.name ?? id, country: n?.geo?.country };
  });
  const response: PathsResponse = { window: "1h", observed_at: ago(0), degraded_at: ago(30_000), sources, targets, paths };
  return buildPathsMatrix(response);
}

/** cd-hs-sh's paths over the hour: up, degraded, down, stale, paused, and a UDP-only target with nothing to dial. */
const PATHS: PathView[] = [
  probe("sh", "hk", { state: "up", p50_ms: 34, p95_ms: 41, loss: 0, last_at: ago(20_000) }),
  probe("sh", "jp", { state: "unknown", reason: "not_probeable", target: "", monitor_id: "", samples: 0, expected: 0 }),
  probe("sh", "us1", { state: "degraded", reason: "degraded_loss", p50_ms: 162, p95_ms: 190, loss: 0.35, last_at: ago(25_000) }),
  probe("sh", "us2", { state: "down", loss: 1, last_at: ago(30_000) }),
  probe("sh", "us4", { state: "unknown", reason: "results_stopped", samples: 0 }),
  probe("sh", "de", { state: "unknown", reason: "path_paused", samples: 0, expected: 0 }),
];

const CHAINS: LineChainView[] = [
  { source_line_uuid: "line-bj", source_node_id: "bj", status: "converged", current: { target_node_id: "hk", target_line_uuid: "line-hk", artifact_digest: "a", status: "converged" }, attempt: null },
  { source_line_uuid: "line-hk", source_node_id: "hk", status: "drifted", current: { target_node_id: "us1", target_line_uuid: "line-us1", artifact_digest: "b", status: "drifted" }, attempt: null, last_error: "target_line_changed" },
  { source_line_uuid: "line-new", source_node_id: "jp", status: "planned", current: null, attempt: { operation: "set", approval_id: "apr_1", status: "planned" } },
];

function monitor(over: Partial<MonitorView>): MonitorView {
  return { id: "mon", name: "check", type: "http", target: "https://example.net/healthz", interval_sec: 60, timeout_sec: 10, enabled: true, latest: [], ...over } as MonitorView;
}

function input(over: Partial<TopologyInput> = {}): TopologyInput {
  return { nodes: NODES, plan: plan(), matrix: matrixOf(PATHS), chains: CHAINS, monitors: [], incidents: [], window: "1h", layer: "all", now: NOW, ...over };
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

test("probe edges are the matrix's paths in their display state; not-probeable draws nothing", () => {
  const m = buildTopology(input());
  assert.equal(edge(m, "probe:sh~hk").state, "up");
  assert.equal(edge(m, "probe:sh~us1").state, "degraded");
  assert.equal(edge(m, "probe:sh~us1").reason, "degraded_loss");
  assert.equal(edge(m, "probe:sh~us2").state, "down");
  assert.equal(edge(m, "probe:sh~us4").state, "unknown", "a stale path is the server's unknown, never a colour");
  assert.equal(edge(m, "probe:sh~us4").reason, "results_stopped");
  assert.equal(edge(m, "probe:sh~de").state, "paused");
  assert.equal(m.edges.find((e) => e.to === "jp"), undefined, "a UDP-only target has no probe to draw");
  assert.deepEqual(
    { paths: m.counts.paths, down: m.counts.down, degraded: m.counts.degraded, unknown: m.counts.unknown, paused: m.counts.paused },
    { paths: 5, down: 1, degraded: 1, unknown: 1, paused: 1 },
  );
});

test("state tones are the only colour: up, degraded and down solid in their tone, unknown dashed and paused dotted, both muted", () => {
  const m = buildTopology(input());
  const style = (id: string) => edgeStyle(edge(m, id));
  assert.deepEqual([style("probe:sh~hk").color, style("probe:sh~hk").stroke], ["--success", "solid"]);
  assert.deepEqual([style("probe:sh~us1").color, style("probe:sh~us1").stroke], ["--warning", "solid"]);
  assert.deepEqual([style("probe:sh~us2").color, style("probe:sh~us2").stroke], ["--destructive", "solid"]);
  assert.deepEqual([style("probe:sh~us4").color, style("probe:sh~us4").stroke], ["--muted-foreground", "dashed"]);
  assert.deepEqual([style("probe:sh~de").color, style("probe:sh~de").stroke], ["--muted-foreground", "dotted"]);
  // No latency band colours a probe any more: fast or slow, an up path is the up tone.
  for (const e of m.edges.filter((x) => x.kind === "probe")) assert.ok(Object.values(PROBE_TONE).includes(edgeStyle(e).color), e.id);
});

test("freshness is the server's: a path it reads up stays up whatever the node list says of its source", () => {
  const nodes = NODES.map((n) => (n.id === "sh" ? ({ ...n, status: "offline", online: false, last_seen: ago(3_600_000) } as Node) : n));
  const m = buildTopology(input({ nodes }));
  assert.equal(edge(m, "probe:sh~hk").state, "up");
  assert.equal(edge(m, "probe:sh~us4").state, "unknown");
});

test("the last sample rides on the edge with its time", () => {
  const m = buildTopology(input());
  assert.deepEqual(edge(m, "probe:sh~hk").last, { at: NOW - 20_000, ok: undefined }, "a path says when it last heard, not how that run went");
  assert.equal(edge(m, "probe:sh~us2").last!.ok, false);
});

/* ---- Sources: one fan each, the picker, ?topo.sources= ---- */

const NINE = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];

function nineSources(): TopologyInput {
  const sources = NINE.map((id) => ({ node_id: id, name: `src-${id}` }));
  const paths: PathView[] = [];
  NINE.forEach((source, i) => {
    paths.push(probe(source, "hk", { state: i === 1 ? "down" : "up", p50_ms: 30 + i }));
    paths.push(probe(source, "de", { state: i === 2 ? "degraded" : "up", p50_ms: 240 + i, reason: i === 2 ? "degraded_latency" : undefined }));
  });
  // The path set's order is its own (sorted ids), not the matrix's.
  const p = plan({ config: { ...plan().config, sources: [...NINE].reverse() } });
  return input({ plan: p, matrix: matrixOf(paths, sources), chains: [], layer: "probes" });
}

/** nineSources with its paths changed before the matrix is built. */
function withPaths(change: (p: PathView) => PathView): TopologyInput {
  const sources = NINE.map((id) => ({ node_id: id, name: `src-${id}` }));
  const paths: PathView[] = [];
  NINE.forEach((source, i) => {
    paths.push(change(probe(source, "hk", { state: i === 1 ? "down" : "up", p50_ms: 30 + i })));
    paths.push(change(probe(source, "de", { state: i === 2 ? "degraded" : "up", p50_ms: 240 + i, reason: i === 2 ? "degraded_latency" : undefined })));
  });
  return { ...nineSources(), matrix: matrixOf(paths, sources) };
}

test("by default the first four sources in the path set's order are drawn, each with its own fan", () => {
  const m = buildTopology(nineSources());
  assert.equal(DEFAULT_DRAWN_SOURCES, 4);
  assert.deepEqual(m.sources.map((n) => n.id), ["s9", "s8", "s7", "s6"]);
  assert.deepEqual(m.drawnSourceIds, ["s9", "s8", "s7", "s6"]);
  assert.equal(m.sourceChoices.length, 9, "the picker lists every source");
  assert.deepEqual(m.sourceChoices.filter((c) => c.drawn).map((c) => c.node.id), ["s9", "s8", "s7", "s6"]);
  for (const source of m.drawnSourceIds) assert.equal(m.edges.filter((e) => e.kind === "probe" && e.from === source).length, 2, `${source}'s fan`);
  assert.equal(m.edges.filter((e) => e.kind === "probe").length, 8, "undrawn sources draw nothing");
  assert.equal(m.counts.paths, 8);
  const layout = layoutTopology(m, { width: 1200 });
  assert.equal(layout.sources.length, 4);
  for (const le of layout.edges) assert.equal(le.bundle.length, 1, "one line per source and target: fans never merge");
});

test("the picker's choice draws those sources in the path set's order; one that stopped probing falls back to the default", () => {
  const m = buildTopology({ ...nineSources(), drawnSources: ["s2", "s3", "s1"] });
  assert.deepEqual(m.drawnSourceIds, ["s3", "s2", "s1"]);
  assert.equal(edge(m, "probe:s2~hk").state, "down");
  assert.equal(edge(m, "probe:s3~de").state, "degraded");
  const reach = m.sourceChoices.find((c) => c.node.id === "s2")!.reach;
  assert.deepEqual([reach.up, reach.down, reach.degraded, reach.total], [1, 1, 0, 2], "reach counts for the picker");
  assert.deepEqual(buildTopology({ ...nineSources(), drawnSources: ["gone"] }).drawnSourceIds, ["s9", "s8", "s7", "s6"]);
  assert.deepEqual(drawnSources(["a", "b"], undefined), ["a", "b"]);
  assert.deepEqual(probeSourceOrder(undefined, matrixOf(PATHS)), ["sh"], "without the plan, the matrix's sources");
});

test("a target row carries one mark per drawn source, in the picker's order", () => {
  const m = buildTopology({ ...nineSources(), drawnSources: ["s1", "s2", "s3"] });
  assert.deepEqual(rowMarks(m, "hk"), [
    { source: "s3", state: "up" },
    { source: "s2", state: "down" },
    { source: "s1", state: "up" },
  ]);
  assert.deepEqual(rowMarks(m, "jp"), [{ source: "s3", state: undefined }, { source: "s2", state: undefined }, { source: "s1", state: undefined }], "no path, no state");
});

test("several sources: a target row summarises across them; one failing source does not read as the node down", () => {
  const m = buildTopology({ ...nineSources(), drawnSources: ["s1", "s2", "s3", "s4"] });
  // hk: s2 is down, s1, s3 and s4 reach it.
  assert.deepEqual(rowSummary(m, "hk"), { state: "down", n: 1, of: 4 });
  // de: s3 is degraded, the rest up.
  assert.deepEqual(rowSummary(m, "de"), { state: "degraded", n: 1, of: 4 });
  // Every drawn source up: the row says so across all of them, not the slowest one's p50.
  const up = buildTopology({ ...nineSources(), drawnSources: ["s1", "s4", "s5"] });
  assert.deepEqual(rowSummary(up, "hk"), { state: "up", n: 3, of: 3 });
  // A source whose path went unknown is counted among those with a path, not among the up ones.
  const stale = { state: "unknown", reason: "results_stopped", samples: 0 };
  const unknownOne = withPaths((p) => (p.source === "s4" && p.target_node === "hk" ? { ...p, ...stale } : p));
  assert.deepEqual(rowSummary(buildTopology({ ...unknownOne, drawnSources: ["s1", "s4", "s5"] }), "hk"), { state: "up", n: 2, of: 3 });
  // Nothing live: the worst of the rest speaks.
  const dead = withPaths((p) => (p.target_node === "hk" ? { ...p, ...stale } : p));
  assert.equal(rowSummary(buildTopology({ ...dead, drawnSources: ["s1", "s4"] }), "hk")!.state, "unknown");
  // One source drawn: no summary, the edge's own value speaks.
  assert.equal(rowSummary(buildTopology({ ...nineSources(), drawnSources: ["s2"] }), "hk"), undefined);
  assert.equal(rowSummary(m, "jp"), undefined, "no path into the row");
});

test("?topo.sources= round trips: ids comma separated, the default written as nothing", () => {
  assert.deepEqual(parseDrawnSources("s2,s1, s2 ,"), ["s2", "s1"]);
  assert.equal(parseDrawnSources(""), undefined);
  assert.equal(parseDrawnSources(undefined), undefined);
  assert.deepEqual(parseDrawnSources(["s1", "s3"]), ["s1", "s3"]);
  assert.equal(formatDrawnSources(["s9", "s8", "s7", "s6"], ["s9", "s8", "s7", "s6"]), undefined);
  assert.equal(formatDrawnSources(["s1", "s2"], ["s9", "s8", "s7", "s6"]), "s1,s2");
  assert.deepEqual(parseDrawnSources(formatDrawnSources(["s1", "s2"], [])), ["s1", "s2"]);
  assert.equal(formatDrawnSources([], ["a"]), undefined);
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
  const two = plan({ config: { ...plan().config, sources: ["sh", "bj"] } });
  const paths = [...PATHS, probe("bj", "hk", { state: "down", loss: 1 })];
  const m3 = buildTopology(input({ plan: two, matrix: matrixOf(paths, [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }]) }));
  const row = rowProbe(m3, "hk")!;
  assert.equal(row.count, 2);
  assert.equal(row.edge.state, "down");
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
  assert.ok(a.edges.findIndex((e) => e.edge.state === "down") > a.edges.findIndex((e) => e.edge.state === "up"), "red is drawn over green");
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
  const threeMatrix = matrixOf([...PATHS, probe("bj", "hk", { state: "up", p50_ms: 30 }), probe("x", "hk", { state: "up", p50_ms: 31 })], [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }, { node_id: "x", name: "no-country" }]);
  const stacked = layoutTopology(buildTopology(input({ plan: three, matrix: threeMatrix })), { width: 1200 });
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
  // One US node is down; the rest are up.
  const m = buildTopology(fleet(COLLAPSE_AT + 40, { shape: (id) => (id === "n004" ? "down" : "up") }));
  const folded = layoutTopology(m, { width: 1200 });
  assert.equal(folded.collapsed, true);
  const countryRows = folded.rows.filter((r) => r.type === "country");
  assert.equal(countryRows.length, 4);
  assert.equal(folded.rows.filter((r) => r.type === "node").length, 0);
  assert.equal(folded.edges.length, 4, "one bundle per country");
  const us = folded.edges.find((e) => e.key.endsWith(">country:US"))!;
  assert.equal(us.bundle.length, 25);
  assert.equal(us.edge.state, "down", "the bundle shows its worst member");
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
 * `shape` says how each target's path reads: up at 150 ms, down, or stale
 * (the server's unknown, results stopped).
 */
function fleet(count: number, over: Partial<TopologyInput> & { shape?: (id: string, index: number) => "up" | "down" | "stale" } = {}): TopologyInput {
  const { shape = () => "up", ...rest } = over;
  const nodes: Node[] = [node("sh", "cd-hs-sh", "CN")];
  const targets: LatencyProbePlan["nodes"] = [{ node_id: "sh", name: "cd-hs-sh", country: "CN", region: "mainland", source: true, target: "none" }];
  const pairs: LatencyProbePlan["pairs"] = [];
  const paths: PathView[] = [];
  const countries = ["US", "JP", "DE", "SG"];
  for (let i = 0; i < count; i++) {
    const id = `n${String(i).padStart(3, "0")}`;
    const country = countries[i % countries.length]!;
    nodes.push(node(id, `node-${id}`, country));
    targets.push({ node_id: id, name: `node-${id}`, country, region: "outside_mainland", source: false, target: "probed", monitor_id: `m_${id}`, endpoint: "203.0.113.1:443" });
    pairs.push({ source: "sh", target: id, enabled: true, active: true, monitor_id: `m_${id}` });
    const kind = shape(id, i);
    paths.push(probe("sh", id, kind === "down" ? { state: "down", loss: 1 } : kind === "stale" ? { state: "unknown", reason: "results_stopped", samples: 0 } : { state: "up", p50_ms: 150, p95_ms: 170, loss: 0, last_at: ago(10_000) }));
  }
  const response: PathsResponse = {
    window: "1h",
    degraded_at: ago(30_000),
    sources: [{ node_id: "sh", name: "cd-hs-sh" }],
    targets: targets.filter((t) => t.node_id !== "sh").map((t) => ({ node_id: t.node_id, name: t.name, country: t.country })),
    paths,
  };
  return { nodes, plan: { ...plan(), nodes: targets, pairs }, matrix: buildPathsMatrix(response), chains: [], monitors: [], incidents: [], window: "1h", layer: "probes", now: NOW, ...rest };
}

test("a row speaks for its live probes: one source whose path went unknown does not grey what the others measure", () => {
  const three = plan({ config: { ...plan().config, sources: ["sh", "bj", "gz"] } });
  const sources = [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }, { node_id: "gz", name: "cd-gz" }];
  const paths = [
    ...PATHS,
    probe("bj", "hk", { state: "unknown", reason: "agent_offline", samples: 0 }),
    probe("gz", "hk", { state: "up", p50_ms: 160, p95_ms: 170 }),
  ];
  const m = buildTopology(input({ plan: three, matrix: matrixOf(paths, sources) }));
  const row = rowProbe(m, "hk")!;
  assert.equal(row.count, 3);
  assert.equal(row.edge.from, "gz", "the slowest live measurement, not the grey");
  assert.equal(row.edge.state, "up");
  assert.equal(row.edge.p50Ms, 160);
  // With nothing live, the grey is all there is to show.
  const dead = paths.map((p) => (p.target_node === "hk" && p.source !== "bj" ? { ...p, state: "unknown", reason: "results_stopped" } : p));
  assert.equal(rowProbe(buildTopology(input({ plan: three, matrix: matrixOf(dead, sources) })), "hk")!.edge.state, "unknown");
  // Lists still put the unknown path above the healthy ones.
  assert.ok(pathsWorstFirst(m).findIndex((e) => e.id === "probe:bj~hk") < pathsWorstFirst(m).findIndex((e) => e.id === "probe:gz~hk"));
});

test("a folded bundle is drawn as its worst live member; grey only when every member is unknown", () => {
  // n000, n004, n008 ... are US. One US path is stale; the rest are up.
  const some = layoutTopology(buildTopology(fleet(COLLAPSE_AT + 4, { shape: (id) => (id === "n004" ? "stale" : "up") })), { width: 1200 });
  const us = some.edges.find((e) => e.key.endsWith(">country:US"))!;
  assert.ok(us.bundle.some((e) => e.state === "unknown"));
  assert.equal(us.edge.state, "up");
  const allStale = layoutTopology(buildTopology(fleet(COLLAPSE_AT + 4, { shape: (_id, i) => (i % 4 === 0 ? "stale" : "up") })), { width: 1200 });
  assert.equal(allStale.edges.find((e) => e.key.endsWith(">country:US"))!.edge.state, "unknown");
});

test("countries fold only past COLLAPSE_AT rows", () => {
  assert.equal(layoutTopology(buildTopology(fleet(COLLAPSE_AT)), { width: 1200 }).collapsed, false);
  assert.equal(layoutTopology(buildTopology(fleet(COLLAPSE_AT + 1)), { width: 1200 }).collapsed, true);
});

test("a chain between two nodes of one folded country is not drawn; one across countries is", () => {
  const chain = (from: string, to: string): LineChainView => ({ source_line_uuid: `line-${from}`, source_node_id: from, status: "converged", current: { target_node_id: to, target_line_uuid: `line-${to}`, artifact_digest: "d", status: "converged" }, attempt: null });
  // n000 and n004 are both US; n001 is JP.
  const m = buildTopology(fleet(COLLAPSE_AT + 1, { layer: "all", chains: [chain("n000", "n004"), chain("n000", "n001")] }));
  assert.equal(m.counts.chains, 2, "both chains are in the model");
  const a = layoutTopology(m, { width: 1200 });
  assert.deepEqual(a.edges.filter((e) => e.edge.kind === "chain").map((e) => e.key), ["chain:country:US>country:JP"]);
});

test("a chain out of a probe source rides below the probe to the same row", () => {
  const sh: LineChainView = { source_line_uuid: "line-sh", source_node_id: "sh", status: "converged", current: { target_node_id: "hk", target_line_uuid: "line-hk", artifact_digest: "e", status: "converged" }, attempt: null };
  const a = layoutTopology(buildTopology(input({ chains: [...CHAINS, sh] })), { width: 1200 });
  const probe = a.edges.find((e) => e.edge.id === "probe:sh~hk")!;
  const chain = a.edges.find((e) => e.edge.id === "chain:line-sh")!;
  assert.equal(chain.end.y, probe.end.y + 6);
});

test("chains are drawn as two rails, so shape and not only hue tells them from probes", () => {
  const m = buildTopology(input());
  for (const e of m.edges) assert.equal(!!edgeStyle(e).double, e.kind === "chain", e.id);
});

test("a disabled check draws nothing and counts as no failure", () => {
  const off = monitor({ id: "off", enabled: false, node_ids: ["us1"], latest: [{ node_id: "us1", at: ago(10_000), success: false, fail_streak: 9, since: ago(600_000) }] });
  const m = buildTopology(input({ monitors: [off] }));
  assert.equal(m.checks.length, 1);
  assert.equal(m.checks[0]!.enabled, false);
  assert.equal(m.checks[0]!.summary.failing, 1, "the result is still counted on the check");
  assert.equal(m.edges.filter((e) => e.kind === "check").length, 0);
  assert.equal(m.counts.checksFailing, 0);
});

test("a source that does not probe a target draws no edge to it", () => {
  const m = buildTopology(input({ matrix: matrixOf(PATHS.filter((p) => p.target_node !== "us1")) }));
  assert.equal(m.edges.find((e) => e.id === "probe:sh~us1"), undefined);
  assert.equal(m.counts.paths, buildTopology(input()).counts.paths - 1);
});

test("an every-node check fans out from CHECK_FAN + 1 sources, not at CHECK_FAN", () => {
  const runners = (n: number) => Array.from({ length: n }, (_, i) => node(`r${i}`, `runner-${i}`, "JP"));
  const allUp = (list: Node[]) => monitor({ id: "all", assign_all: true, latest: list.map((n) => ({ node_id: n.id, at: ago(5_000), success: true, fail_streak: 0, since: ago(60_000) })) });
  const at = runners(CHECK_FAN);
  const atFan = buildTopology(input({ nodes: at, monitors: [allUp(at)] }));
  assert.equal(atFan.checks[0]!.fannedOut, false);
  assert.equal(atFan.edges.filter((e) => e.kind === "check").length, CHECK_FAN, "every source drawn");
  const past = runners(CHECK_FAN + 1);
  const pastFan = buildTopology(input({ nodes: past, monitors: [allUp(past)] }));
  assert.equal(pastFan.checks[0]!.fannedOut, true);
  assert.equal(pastFan.edges.filter((e) => e.kind === "check").length, 0, "healthy sources are counted, not drawn");
});

test("a probe interval under a minute still waits three minutes before calling a path quiet", () => {
  assert.equal(quietAfterMs(20), 180_000);
});

const OK: TopoReadStatus = { allowed: true, hasData: true, failed: false };
const FAILED: TopoReadStatus = { allowed: true, hasData: false, failed: true };
const STALE: TopoReadStatus = { allowed: true, hasData: true, failed: true };
const LOADING: TopoReadStatus = { allowed: true, hasData: false, failed: false };
const DENIED: TopoReadStatus = { allowed: false, hasData: false, failed: false };
const reads = (over: Partial<TopoReadStatuses> = {}): TopoReadStatuses => ({ plan: OK, paths: OK, nodes: OK, incidents: OK, monitors: OK, chains: OK, ...over });

test("the proof line speaks for every read the filter draws from, and never for one the session cannot send", () => {
  assert.deepEqual(readsFor("all", reads()), ["plan", "paths", "nodes", "incidents", "monitors", "chains"]);
  assert.deepEqual(readsFor("probes", reads()), ["plan", "paths", "nodes", "incidents"]);
  assert.deepEqual(readsFor("checks", reads()), ["plan", "nodes", "incidents", "monitors"]);
  assert.deepEqual(readsFor("chains", reads({ nodes: DENIED })), ["plan", "incidents", "chains"]);
  assert.deepEqual(readsFor("all", reads({ chains: DENIED })), ["plan", "paths", "nodes", "incidents", "monitors"]);
});

test("a read that never landed and failed is missing; a failed refresh after a good read is only stale", () => {
  assert.equal(readState(FAILED), "failed");
  assert.equal(readState(STALE), "read");
  assert.equal(readState(LOADING), "loading");
  assert.equal(readState(DENIED), "unreadable");
  assert.deepEqual(missingReads("all", reads({ monitors: FAILED, nodes: FAILED, incidents: STALE })), ["nodes", "monitors"]);
  assert.deepEqual(missingReads("probes", reads({ monitors: FAILED })), [], "the Probes filter draws no checks");
  assert.deepEqual(missingReads("all", reads({ nodes: { ...FAILED, allowed: false } })), [], "a read never sent cannot fail");
});

test("the Checks filter tells an unread monitor list from an empty one", () => {
  const unread = buildTopology(input({ layer: "checks", monitors: undefined }));
  assert.equal(layerEmpty(unread, reads({ monitors: FAILED })), "monitorsFailed");
  assert.equal(layerEmpty(unread, reads({ monitors: LOADING })), "loading");
  assert.equal(layerEmpty(buildTopology(input({ layer: "checks", monitors: [] })), reads()), "noChecks");
  const some = buildTopology(input({ layer: "checks", monitors: [monitor({ id: "m", node_ids: ["de"] })] }));
  assert.equal(layerEmpty(some, reads({ monitors: STALE })), null, "a stale list still draws its checks");
});

test("the Chains filter says denied, failed, loading or none, in that order of what is known", () => {
  const none = buildTopology(input({ layer: "chains", chains: [] }));
  assert.equal(layerEmpty(none, reads({ chains: DENIED })), "chainsDenied");
  assert.equal(layerEmpty(none, reads({ chains: FAILED })), "chainsFailed");
  assert.equal(layerEmpty(none, reads({ chains: LOADING })), "loading");
  assert.equal(layerEmpty(none, reads()), "noChains");
  assert.equal(layerEmpty(buildTopology(input({ layer: "chains" })), reads()), null);
  assert.equal(layerEmpty(buildTopology(input({ layer: "probes", plan: plan({ config: { ...plan().config, sources: [] } }), matrix: matrixOf([]) })), reads()), "noSources");
});
