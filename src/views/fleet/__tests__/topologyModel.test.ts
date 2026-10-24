import assert from "node:assert/strict";
import { test } from "node:test";

import type { Incident, LatencyProbePlan, LineChainView, Node, PathView, PathsResponse } from "@/lib/api/types";

import enFleet from "../../../i18n/locales/en/fleet.ts";
import zhFleet from "../../../i18n/locales/zh-CN/fleet.ts";

import { quietAfterMs } from "../latencyModel.ts";
import { buildPathsMatrix, everyPath } from "../pathsModel.ts";
import { addressLineValue, edgeValue, rowSummaryValue, stateLabel } from "../topologyCopy.ts";
import {
  DEFAULT_DRAWN_SOURCES,
  PATH_TONE,
  drawnSources,
  formatDrawnSources,
  parseDrawnSources,
  parseTopologyLayer,
  sourceOrder,
  rowMarks,
  CONTROL_PLANE,
  COLLAPSE_AT,
  FAN_MIN_W,
  LEFT_W,
  ROW_H,
  ROW_MARK_W,
  ROW_SUMMARY_EXTRA_W,
  SOURCES_TOP,
  TOP_LANE,
  addressEndpoint,
  buildTopology,
  chainState,
  edgeStyle,
  endMatched,
  keyboardOrder,
  layerEmpty,
  layoutTopology,
  missingReads,
  neighbourhood,
  placeCard,
  readState,
  readsFor,
  regionOf,
  rovingMove,
  rovingStop,
  rowPath,
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

type PathSpec = Partial<PathView> & { state: string };

/** A path set path from `source` to `target` as the paths route sends it. */
function probe(source: string, target: string, spec: PathSpec): PathView {
  return { source, target_node: target, target: "203.0.113.1:443", monitor_id: `mon_lat_${target}`, managed: true, method: "tcp", samples: 60, expected: 60, ...spec };
}

/** A path of an operator check: to a node when `target_node` is given, else to the address it dials. */
function check(source: string, monitorId: string, spec: PathSpec & { target: string }): PathView {
  return { source, monitor_id: monitorId, managed: false, method: "tcp", samples: 60, expected: 60, ...spec };
}

const CHECK_NAMES: Record<string, string> = { ping: "ICMP to hk", web: "Status page", cert: "sub cert", relay: "HK relay port" };

/** The matrix of an M3 server: one row per target, one column per source. */
function matrixOf(paths: PathView[], sources: { node_id: string; name: string }[] = [{ node_id: "sh", name: "cd-hs-sh" }]) {
  const targets = [...new Set(paths.map((p) => p.target_node!).filter(Boolean))].map((id) => {
    const n = NODES.find((x) => x.id === id);
    return { node_id: id, name: n?.name ?? id, country: n?.geo?.country };
  });
  const response: PathsResponse = { window: "1h", observed_at: ago(0), degraded_at: ago(30_000), sources, targets, paths };
  return buildPathsMatrix(response, { checkName: (id) => CHECK_NAMES[id] });
}

/** The ids of an input's paths with these keys: what the page's query hands the drawing. */
function idsOf(over: Pick<TopologyInput, "matrix">, keys: readonly string[]): Set<string> {
  return new Set((over.matrix?.paths ?? []).filter((p) => keys.includes(p.key)).map((p) => p.id));
}

/** The same matrix with the pairs that are not measured shown, as the Topology view reads it on request (design 32 R2). */
function revealed(paths: PathView[], sources?: { node_id: string; name: string }[]) {
  const m = matrixOf(paths, sources);
  return { ...m, paths: everyPath(m) };
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

function input(over: Partial<TopologyInput> = {}): TopologyInput {
  return { nodes: NODES, plan: plan(), matrix: matrixOf(PATHS), chains: CHAINS, incidents: [], window: "1h", layer: "all", ...over };
}

const edge = (m: ReturnType<typeof buildTopology>, id: string) => {
  const found = m.edges.find((e) => e.id === id);
  assert.ok(found, `edge ${id}`);
  return found;
};

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
    "region, then country, then name; the source sits in the left column",
  );
  assert.deepEqual(m.sources.map((n) => n.id), ["sh"]);
});

/* ---- Edges from the matrix ---- */

test("path edges are the matrix's measured paths in their display state; a skipped or paused pair is drawn only when asked for", () => {
  const m = buildTopology(input());
  assert.equal(edge(m, "path:sh>hk").state, "up");
  assert.equal(edge(m, "path:sh>us1").state, "degraded");
  assert.equal(edge(m, "path:sh>us1").reason, "degraded_loss");
  assert.equal(edge(m, "path:sh>us2").state, "down");
  assert.equal(edge(m, "path:sh>us4").state, "unknown", "a stale path is the server's unknown, never a colour");
  assert.equal(edge(m, "path:sh>us4").reason, "results_stopped");
  // Design 32 R2: a pair its check skips or the operator paused is not a path, so the default drawing leaves it out.
  assert.equal(m.edges.some((e) => e.id === "path:sh>de" || e.id === "path:sh>jp"), false);
  assert.equal(m.counts.drawn, 4);
  assert.equal(m.counts.undrawn, 0);
  // Shown on request, each in its own state, the skipped one with its reason.
  const shown = buildTopology(input({ matrix: revealed(PATHS) }));
  assert.equal(edge(shown, "path:sh>de").state, "paused");
  assert.equal(edge(shown, "path:sh>jp").state, "skipped");
  assert.equal(edge(shown, "path:sh>jp").reason, "not_probeable");
  assert.equal(shown.counts.drawn, 6);
});

test("state tones are the only colour: up, degraded and down solid in their tone, unknown dashed, paused and skipped dotted, all muted", () => {
  const m = buildTopology(input({ matrix: revealed(PATHS) }));
  const style = (id: string) => edgeStyle(edge(m, id));
  assert.deepEqual([style("path:sh>hk").color, style("path:sh>hk").stroke], ["--success", "solid"]);
  assert.deepEqual([style("path:sh>us1").color, style("path:sh>us1").stroke], ["--warning", "solid"]);
  assert.deepEqual([style("path:sh>us2").color, style("path:sh>us2").stroke], ["--destructive", "solid"]);
  assert.deepEqual([style("path:sh>us4").color, style("path:sh>us4").stroke], ["--muted-foreground", "dashed"]);
  assert.deepEqual([style("path:sh>de").color, style("path:sh>de").stroke], ["--muted-foreground", "dotted"]);
  assert.deepEqual([style("path:sh>jp").color, style("path:sh>jp").stroke], ["--muted-foreground", "dotted"]);
  for (const e of m.edges.filter((x) => x.kind === "path")) assert.ok(Object.values(PATH_TONE).includes(edgeStyle(e).color), e.id);
});

test("freshness is the server's: a path it reads up stays up whatever the node list says of its source", () => {
  const nodes = NODES.map((n) => (n.id === "sh" ? ({ ...n, status: "offline", online: false, last_seen: ago(3_600_000) } as Node) : n));
  const m = buildTopology(input({ nodes }));
  assert.equal(edge(m, "path:sh>hk").state, "up");
  assert.equal(edge(m, "path:sh>us4").state, "unknown");
});

test("the last sample rides on the edge with its time", () => {
  const m = buildTopology(input());
  assert.deepEqual(edge(m, "path:sh>hk").last, { at: NOW - 20_000, ok: undefined }, "a path says when it last heard, not how that run went");
  assert.equal(edge(m, "path:sh>us2").last!.ok, false);
});

/* ---- Checks are paths ---- */

test("a check to a node is an edge between two real nodes: no pseudo-node, and one target appears once", () => {
  const ping = check("sh", "ping", { target_node: "hk", target: "203.0.113.2", method: "icmp", state: "down", loss: 1 });
  const m = buildTopology(input({ matrix: matrixOf([...PATHS, ping]) }));
  const pair = edge(m, "path:sh>hk");
  // Two checks measure sh to hk: one edge, in the worst live state, that lists each check; both are the one pair (design 32 R1).
  assert.equal(pair.state, "down");
  assert.deepEqual(pair.paths!.map((p) => [p.key, p.checkId]), [["sh~hk", "ping"], ["sh~hk", "mon_lat_hk"]]);
  assert.equal(pair.pathKey, "sh~hk", "it opens the pair, whose sheet lists both");
  assert.equal(m.edges.filter((e) => e.to === "hk" && e.kind === "path").length, 1);
  assert.ok(!m.members.some((n) => n.id.startsWith("@")), "every row is a node");
  assert.deepEqual(m.addresses, []);
  assert.equal(m.counts.drawn, 5);
});

test("a check that cannot run does not grey a pair another check measures; shown on request, the edge lists it", () => {
  const ping = check("sh", "ping", { target_node: "hk", target: "203.0.113.2", method: "icmp", state: "unknown", reason: "icmp_not_permitted", samples: 0 });
  const m = buildTopology(input({ matrix: matrixOf([...PATHS, ping]) }));
  const pair = edge(m, "path:sh>hk");
  assert.equal(pair.state, "up");
  assert.equal(pair.p50Ms, 34);
  assert.deepEqual(pair.paths!.map((p) => p.checkId), ["mon_lat_hk"], "a skipped check is not a path (design 32 R2)");
  const shown = edge(buildTopology(input({ matrix: revealed([...PATHS, ping]) })), "path:sh>hk");
  assert.equal(shown.state, "up");
  assert.deepEqual(shown.paths!.map((p) => p.checkId), ["mon_lat_hk", "ping"]);
  // Only checks that cannot run: no edge, and shown, the pair reads skipped with the reason.
  assert.equal(buildTopology(input({ matrix: matrixOf([ping]) })).edges.some((e) => e.id === "path:sh>hk"), false);
  const alone = buildTopology(input({ matrix: revealed([ping]) }));
  assert.equal(edge(alone, "path:sh>hk").state, "skipped");
  assert.equal(edge(alone, "path:sh>hk").reason, "icmp_not_permitted");
});

test("an address keeps one terminal however many checks and sources dial it; a certificate check leaves the control plane", () => {
  const sources = [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }, { node_id: "", name: "Control plane" }];
  const url = "https://status.example.net/healthz";
  const paths = [
    ...PATHS,
    check("sh", "web", { target: url, method: "http", state: "up", p50_ms: 120 }),
    check("bj", "web", { target: url, method: "http", state: "down", loss: 1 }),
    check("", "cert", { target: "sub.example.net:443", method: "tls", state: "up" }),
  ];
  const two = plan({ config: { ...plan().config, sources: ["sh", "bj"] } });
  const m = buildTopology(input({ plan: two, matrix: matrixOf(paths, sources) }));
  assert.deepEqual(
    m.addresses.map((a) => [a.id, a.address, a.methods, a.checks, a.counts.paths, a.counts.down]),
    [
      // Down first, then by address.
      [addressEndpoint(url), url, ["http"], ["Status page"], 2, 1],
      [addressEndpoint("sub.example.net:443"), "sub.example.net:443", ["tls"], ["sub cert"], 1, 0],
    ],
  );
  assert.equal(edge(m, `path:sh>${addressEndpoint(url)}`).state, "up");
  assert.equal(edge(m, `path:bj>${addressEndpoint(url)}`).state, "down");
  assert.equal(edge(m, `path:${CONTROL_PLANE}>${addressEndpoint("sub.example.net:443")}`).from, CONTROL_PLANE);
  // Every measured path is drawn; the skipped and the paused pair of PATHS are not paths.
  assert.equal(m.counts.drawn, paths.length - 2);
  // The terminal's line: red when one of its paths is down.
  const t = (key: string, named: Record<string, unknown> = {}) => `${key.split(".").pop()} ${Object.values(named).join("/")}`;
  assert.deepEqual(addressLineValue(t, m.addresses[0]!), { text: "down 1/2", tone: "text-destructive" });
  assert.deepEqual(addressLineValue(t, m.addresses[1]!), { text: "up 1/1", tone: "text-muted-foreground" });
});

/* ---- Sources: one fan each, the picker, ?topo.sources= ---- */

const NINE = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];

function ninePaths(change: (p: PathView) => PathView = (p) => p): PathView[] {
  const paths: PathView[] = [];
  NINE.forEach((source, i) => {
    paths.push(change(probe(source, "hk", { state: i === 1 ? "down" : "up", p50_ms: 30 + i })));
    paths.push(change(probe(source, "de", { state: i === 2 ? "degraded" : "up", p50_ms: 240 + i, reason: i === 2 ? "degraded_latency" : undefined })));
  });
  return paths;
}

function nineSources(change?: (p: PathView) => PathView): TopologyInput {
  const sources = NINE.map((id) => ({ node_id: id, name: `src-${id}` }));
  // The path set's order is its own (sorted ids), not the matrix's.
  const p = plan({ config: { ...plan().config, sources: [...NINE].reverse() } });
  return input({ plan: p, matrix: matrixOf(ninePaths(change), sources), chains: [], layer: "paths" });
}

test("by default the first four sources in the path set's order are drawn, each with its own fan", () => {
  const m = buildTopology(nineSources());
  assert.equal(DEFAULT_DRAWN_SOURCES, 4);
  assert.deepEqual(m.sources.map((n) => n.id), ["s9", "s8", "s7", "s6"]);
  assert.deepEqual(m.drawnSourceIds, ["s9", "s8", "s7", "s6"]);
  assert.equal(m.sourceChoices.length, 9, "the picker lists every source");
  assert.deepEqual(m.sourceChoices.filter((c) => c.drawn).map((c) => c.node.id), ["s9", "s8", "s7", "s6"]);
  for (const source of m.drawnSourceIds) assert.equal(m.edges.filter((e) => e.kind === "path" && e.from === source).length, 2, `${source}'s fan`);
  assert.equal(m.edges.filter((e) => e.kind === "path").length, 8, "undrawn sources draw nothing");
  // The page's count holds every path: the drawing says how many it leaves to the picker.
  assert.equal(m.counts.drawn, 8);
  assert.equal(m.counts.undrawn, 10);
  const layout = layoutTopology(m, { width: 1200 });
  assert.equal(layout.sources.length, 4);
  for (const le of layout.edges) assert.equal(le.bundle.length, 1, "one line per source and target: fans never merge");
});

test("the picker's choice draws those sources in the path set's order; one that stopped running falls back to the default", () => {
  const m = buildTopology({ ...nineSources(), drawnSources: ["s2", "s3", "s1"] });
  assert.deepEqual(m.drawnSourceIds, ["s3", "s2", "s1"]);
  assert.equal(edge(m, "path:s2>hk").state, "down");
  assert.equal(edge(m, "path:s3>de").state, "degraded");
  const reach = m.sourceChoices.find((c) => c.node.id === "s2")!.reach;
  assert.deepEqual([reach.up, reach.down, reach.degraded, reach.total], [1, 1, 0, 2], "reach counts for the picker");
  assert.deepEqual(buildTopology({ ...nineSources(), drawnSources: ["gone"] }).drawnSourceIds, ["s9", "s8", "s7", "s6"]);
  assert.deepEqual(drawnSources(["a", "b"], undefined), ["a", "b"]);
  assert.deepEqual(sourceOrder(undefined, matrixOf(PATHS)), ["sh"], "without the plan, the matrix's sources");
});

test("a source the plan notes as gone comes last but can still be drawn, so every path the page counts can be", () => {
  const sources = [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "old", name: "retired" }, { node_id: "bj", name: "cd-bj-iplc" }];
  const paths = [...PATHS, probe("old", "hk", { state: "unknown", reason: "source_unavailable", samples: 0 }), probe("bj", "hk", { state: "up", p50_ms: 30 })];
  const p = plan({ config: { ...plan().config, sources: ["old", "sh", "bj"] }, source_notes: { old: "deleted" } } as Partial<LatencyProbePlan>);
  assert.deepEqual(sourceOrder(p, matrixOf(paths, sources)), ["sh", "bj", "old"]);
  const m = buildTopology(input({ plan: p, matrix: matrixOf(paths, sources), drawnSources: ["sh"] }));
  assert.equal(m.counts.undrawn, 2);
  // "Draw all" draws it: nothing the page counts is out of reach.
  const every = buildTopology(input({ plan: p, matrix: matrixOf(paths, sources), drawnSources: m.sourceChoices.map((c) => c.node.id) }));
  assert.equal(every.counts.undrawn, 0);
  assert.equal(edge(every, "path:old>hk").state, "unknown");
});

test("a check's own sources are offered after the path set's, so a check from any node can be drawn", () => {
  const sources = [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "us1", name: "DMIT-pro-malibu" }];
  const relay = check("us1", "relay", { target_node: "hk", target: "203.0.113.21:443", state: "up", p50_ms: 160 });
  const m = buildTopology(input({ matrix: matrixOf([...PATHS, relay], sources) }));
  assert.deepEqual(m.sourceChoices.map((c) => c.node.id), ["sh", "us1"]);
  assert.deepEqual(m.drawnSourceIds, ["sh", "us1"]);
  assert.equal(edge(m, "path:us1>hk").state, "up");
  assert.ok(!m.members.some((n) => n.id === "us1"), "a drawn source sits in the left column only");
});

test("a target row carries one mark per drawn source, in the picker's order", () => {
  const m = buildTopology({ ...nineSources(), drawnSources: ["s1", "s2", "s3"] });
  assert.deepEqual(rowMarks(m, "hk"), [
    { source: "s3", state: "up" },
    { source: "s2", state: "down" },
    { source: "s1", state: "up" },
  ]);
  assert.deepEqual(rowMarks(m, "jp"), [{ source: "s3", state: undefined }, { source: "s2", state: undefined }, { source: "s1", state: undefined }], "not measured, no state");
});

test("several sources: a target row summarises across every source that probes it; one failing source does not read as the node down", () => {
  const m = buildTopology({ ...nineSources(), drawnSources: ["s1", "s2", "s3", "s4"] });
  // hk: s2 is down, the other eight reach it, drawn or not.
  assert.deepEqual(rowSummary(m, "hk"), { state: "down", n: 1, of: 9 });
  // de: s3 is degraded, the rest up.
  assert.deepEqual(rowSummary(m, "de"), { state: "degraded", n: 1, of: 9 });
  // Drawing more or other sources never changes what a row says (design 32 D1: one count).
  for (const drawn of [["s5", "s6"], NINE]) {
    const other = buildTopology({ ...nineSources(), drawnSources: [...drawn] });
    assert.deepEqual(rowSummary(other, "hk"), rowSummary(m, "hk"), `drawn ${drawn.join(",")}`);
  }
  // Every source up: the row says so across all of them, not the slowest one's p50.
  const allUp = (change?: (p: PathView) => PathView) => nineSources((p) => {
    const next = p.source === "s2" && p.target_node === "hk" ? { ...p, state: "up" } : p;
    return change ? change(next) : next;
  });
  assert.deepEqual(rowSummary(buildTopology({ ...allUp(), drawnSources: ["s1", "s4", "s5"] }), "hk"), { state: "up", n: 9, of: 9 });
  // A source whose path went unknown is counted among those with a path, not among the up ones.
  const stale = { state: "unknown", reason: "results_stopped", samples: 0 };
  const unknownOne = allUp((p) => (p.source === "s4" && p.target_node === "hk" ? { ...p, ...stale } : p));
  assert.deepEqual(rowSummary(buildTopology({ ...unknownOne, drawnSources: ["s1", "s4", "s5"] }), "hk"), { state: "up", n: 8, of: 9 });
  // Nothing live: the worst of the rest speaks, and says why.
  const dead = nineSources((p) => (p.target_node === "hk" ? { ...p, ...stale } : p));
  assert.deepEqual(rowSummary(buildTopology({ ...dead, drawnSources: ["s1", "s4"] }), "hk"), { state: "unknown", n: 9, of: 9, reason: "results_stopped" });
  // One source drawn: no summary, the edge's own value speaks.
  assert.equal(rowSummary(buildTopology({ ...nineSources(), drawnSources: ["s2"] }), "hk"), undefined);
  assert.equal(rowSummary(m, "jp"), undefined, "no path into the row");
});

/* ---- One vocabulary (design 32 D1) ---- */

/** A tiny t over a locale's messages: walks the key path and fills {placeholders}; a missing key comes back as the key. */
function translator(messages: Record<string, unknown>) {
  return (key: string, named: Record<string, unknown> = {}) => {
    const found = key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), messages);
    return typeof found === "string" ? found.replace(/\{(\w+)\}/g, (_, k: string) => String(named[k] ?? "")) : key;
  };
}

test("the row summary's words exist in both locales, and unknown says why", () => {
  for (const messages of [enFleet, zhFleet] as unknown as Record<string, unknown>[]) {
    const t = translator(messages);
    for (const summary of [
      { state: "down", n: 1, of: 4 },
      { state: "degraded", n: 2, of: 4 },
      { state: "up", n: 3, of: 4 },
      { state: "up", n: 4, of: 4 },
      { state: "unknown", n: 4, of: 4, reason: "agent_offline" },
      { state: "unknown", n: 1, of: 4, reason: "results_stopped" },
      { state: "paused", n: 1, of: 1 },
      { state: "paused", n: 1, of: 2 },
    ] as const) {
      const v = rowSummaryValue(t, summary);
      assert.ok(!v.text.startsWith("fleet."), `${v.text} resolves`);
      // Every source unknown or paused: the marks say "all", the words say why.
      if (summary.n !== summary.of || summary.state === "down" || summary.state === "degraded" || summary.state === "up") assert.match(v.text, new RegExp(String(summary.of)));
      if (summary.state === "unknown") assert.ok(v.text.includes(t(`fleet.monitoring.paths.reasonShort.${summary.reason}`)), `${v.text} carries its reason`);
    }
  }
  const en = translator(enFleet as unknown as Record<string, unknown>);
  assert.deepEqual(rowSummaryValue(en, { state: "down", n: 1, of: 4 }), { text: "down from 1 of 4", tone: "text-destructive" });
  assert.deepEqual(rowSummaryValue(en, { state: "down", n: 4, of: 4 }), { text: "down from all 4", tone: "text-destructive" });
  assert.deepEqual(rowSummaryValue(en, { state: "degraded", n: 3, of: 3 }), { text: "degraded from all 3", tone: "text-warning-text" });
  assert.deepEqual(rowSummaryValue(en, { state: "up", n: 4, of: 4 }), { text: "up from all 4", tone: "text-foreground" });
  assert.deepEqual(rowSummaryValue(en, { state: "unknown", n: 2, of: 2, reason: "agent_offline" }), { text: "unknown: agent offline", tone: "text-muted-foreground" });
});

test("an edge says up, degraded, down, paused or unknown, and unknown always carries its reason", () => {
  const removed = /no path|not probed|nothing heard|no data/i;
  for (const messages of [enFleet, zhFleet] as unknown as Record<string, unknown>[]) {
    const t = translator(messages);
    const m = buildTopology(input({ matrix: revealed(PATHS) }));
    for (const e of m.edges.filter((x) => x.kind === "path")) {
      const words = [stateLabel(t, e), edgeValue(t, e).text];
      for (const w of words) assert.ok(!w.startsWith("fleet."), `${e.id}: ${w} resolves`);
      if (e.state === "unknown" || e.state === "skipped") assert.ok(stateLabel(t, e).includes(t(`fleet.monitoring.paths.reasonShort.${e.reason}`)), `${e.id} says why`);
      if (messages === (enFleet as unknown)) for (const w of words) assert.doesNotMatch(w, removed, `${e.id}: ${w}`);
    }
  }
  const en = translator(enFleet as unknown as Record<string, unknown>);
  const m = buildTopology(input({ matrix: revealed(PATHS) }));
  assert.equal(stateLabel(en, edge(m, "path:sh>us4")), "unknown: results stopped");
  assert.equal(stateLabel(en, edge(m, "path:sh>jp")), "skipped: nothing to dial");
  assert.equal(edgeValue(en, edge(m, "path:sh>de")).text, "paused");
  assert.equal(edgeValue(en, edge(m, "path:sh>hk")).text, "34 ms");
  // An unknown reason the console has no words for is shown as the server sent it.
  assert.equal(stateLabel(en, { kind: "path", state: "unknown", reason: "brand_new_reason" }), "unknown: brand_new_reason");
  assert.equal(stateLabel(en, { kind: "path", state: "unknown" }), "unknown: no reason given");
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

test("?topo= keeps all, paths and chains; the old probes and checks filters both show paths", () => {
  assert.equal(parseTopologyLayer(undefined), "all");
  assert.equal(parseTopologyLayer("chains"), "chains");
  assert.equal(parseTopologyLayer("paths"), "paths");
  assert.equal(parseTopologyLayer("probes"), "paths");
  assert.equal(parseTopologyLayer("checks"), "paths");
  assert.equal(parseTopologyLayer("nonsense"), "all");
});

/* ---- The query in graph mode ---- */

test("a query keeps matching edges and their ends at full strength and fades the rest; every match is drawn", () => {
  const all = buildTopology(nineSources());
  assert.equal(all.filtering, false);
  assert.ok(all.edges.every((e) => e.matched), "without a query everything keeps full strength");
  assert.ok(endMatched(all, "s9") && endMatched(all, "hk"));
  // s5 is not among the default four, and its path to hk matches: it is drawn while the query holds.
  // The query keeps paths by id, one per check (design 32 R1).
  const matching = idsOf(nineSources(), ["s5~hk", "s2~hk"]);
  const m = buildTopology({ ...nineSources(), matching });
  assert.deepEqual(m.drawnSourceIds, ["s9", "s8", "s7", "s6", "s5", "s2"]);
  assert.deepEqual(m.edges.filter((e) => e.matched).map((e) => e.id).sort(), ["path:s2>hk", "path:s5>hk"]);
  assert.equal(edge(m, "path:s9>hk").matched, false);
  assert.equal(edge(m, "path:s5>de").matched, false);
  assert.ok(endMatched(m, "s5") && endMatched(m, "s2") && endMatched(m, "hk"));
  assert.ok(!endMatched(m, "s9") && !endMatched(m, "de"));
  // The graph and the list count the same: every path the query keeps is on a matching edge.
  const onEdges = m.edges.flatMap((e) => (e.matched ? e.paths!.filter((p) => matching.has(p.id)) : []));
  assert.equal(onEdges.length, matching.size);
  // The query's sources are drawn but not picked: the picker locks them and never writes them to the address.
  assert.deepEqual(m.sourceChoices.filter((c) => c.forced).map((c) => c.node.id), ["s5", "s2"]);
  assert.deepEqual(m.sourceChoices.filter((c) => c.drawn && !c.forced).map((c) => c.node.id), ["s9", "s8", "s7", "s6"]);
  assert.ok(all.sourceChoices.every((c) => !c.forced));
  // A query that keeps one of a pair's checks keeps the pair's edge, and the path sheet opens the pair (design 32 R1).
  const ping = check("sh", "ping", { target_node: "hk", target: "203.0.113.2", method: "icmp", state: "up", p50_ms: 36 });
  const withPing = input({ matrix: matrixOf([...PATHS, ping]) });
  const pair = buildTopology({ ...withPing, matching: new Set(withPing.matrix!.paths.filter((p) => p.checkId === "ping").map((p) => p.id)) });
  assert.equal(edge(pair, "path:sh>hk").pathKey, "sh~hk");
  assert.equal(edge(pair, "path:sh>hk").matched, true);
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
  assert.ok(chains.every((e) => e.matched), "without a query every chain keeps full strength");
  const filtered = buildTopology(input({ matching: idsOf(input(), ["sh~hk"]) }));
  assert.ok(filtered.edges.filter((e) => e.kind === "chain").every((e) => !e.matched), "the query reads paths, so a chain fades under one");
});

test("chain status words", () => {
  assert.equal(chainState({ status: "converged", attempt: null }), "converged");
  assert.equal(chainState({ status: "applying", attempt: null }), "pending");
  assert.equal(chainState({ status: "applied_unobserved", attempt: null }), "pending");
  assert.equal(chainState({ status: "planned", attempt: { operation: "set", approval_id: "a", status: "failed" } }), "failed");
  assert.equal(chainState({ status: "failed", attempt: null }), "failed");
  assert.equal(chainState({ status: "drifted", attempt: null }), "drifted");
});

/* ---- Layers, control plane, incidents ---- */

test("each filter keeps only its own nodes and edges", () => {
  const paths = buildTopology(input({ layer: "paths" }));
  assert.deepEqual(new Set(paths.edges.map((e) => e.kind)), new Set(["path"]));
  assert.deepEqual(paths.members.map((n) => n.id), ["hk", "jp", "us4", "us1", "us2", "de"]);
  const chains = buildTopology(input({ layer: "chains" }));
  assert.deepEqual(chains.sources, [], "the left column holds sources only");
  assert.deepEqual(chains.members.map((n) => n.id), ["bj", "hk", "us1"]);
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

test("a row reports its worst path and how many there are", () => {
  const two = plan({ config: { ...plan().config, sources: ["sh", "bj"] } });
  const paths = [...PATHS, probe("bj", "hk", { state: "down", loss: 1 })];
  const m = buildTopology(input({ plan: two, matrix: matrixOf(paths, [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }]) }));
  const row = rowPath(m, "hk")!;
  assert.equal(row.count, 2);
  assert.equal(row.edge.state, "down");
  assert.equal(rowPath(m, "x"), undefined);
});

/* ---- Layout ---- */

/** A check to an address from `source`, so the drawing has a terminal column. */
const ADDRESS_CHECK = (source = "sh") => check(source, "web", { target: "https://status.example.net/healthz", method: "http", state: "up", p50_ms: 120 });

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

test("the sources sit right under the control plane and the addresses start at the top, however tall the column", () => {
  const small = layoutTopology(buildTopology(input({ matrix: matrixOf([...PATHS, ADDRESS_CHECK()]) })), { width: 1200 });
  const tallInput = fleet(COLLAPSE_AT, { layer: "all" });
  const tall = layoutTopology(buildTopology({ ...tallInput, matrix: buildPathsMatrix({ ...fleetResponse(COLLAPSE_AT), paths: [...fleetResponse(COLLAPSE_AT).paths, ADDRESS_CHECK()] }) }), { width: 1200 });
  assert.ok(tall.height > 1500, "a column far taller than one screen");
  for (const a of [small, tall]) {
    const src = a.sources[0]!.box;
    assert.equal(src.y, SOURCES_TOP);
    assert.ok(src.y >= a.cp.y + a.cp.h, "never over the control plane box");
    assert.equal(a.addresses[0]!.box.y, 0);
  }
  // Three sources stack down from the same place.
  const three = plan({ config: { ...plan().config, sources: ["sh", "bj", "x"] } });
  const threeMatrix = matrixOf([...PATHS, probe("bj", "hk", { state: "up", p50_ms: 30 }), probe("x", "hk", { state: "up", p50_ms: 31 })], [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }, { node_id: "x", name: "no-country" }]);
  const stacked = layoutTopology(buildTopology(input({ plan: three, matrix: threeMatrix })), { width: 1200 });
  assert.deepEqual(stacked.sources.map((s) => s.box.y), [SOURCES_TOP, SOURCES_TOP + 68, SOURCES_TOP + 136]);
});

test("addresses take a right column only when a check dials one", () => {
  const none = layoutTopology(buildTopology(input()), { width: 1200 });
  assert.equal(none.addresses.length, 0);
  const some = layoutTopology(buildTopology(input({ matrix: matrixOf([...PATHS, ADDRESS_CHECK()]) })), { width: 1200 });
  assert.equal(some.addresses.length, 1);
  assert.equal(some.addresses[0]!.box.x + some.addresses[0]!.box.w, 1200, "pinned to the right edge");
  const id = addressEndpoint("https://status.example.net/healthz");
  assert.equal(some.anchorOf.get(id), id);
  assert.equal(some.edges.find((e) => e.edge.to === id)!.toColumn, "address");
});

test("a certificate check's line leaves the control plane over the top of the node column, never through it", () => {
  const sources = [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "", name: "Control plane" }];
  const cert = check("", "cert", { target: "sub.example.net:443", method: "tls", state: "up" });
  const a = layoutTopology(buildTopology(input({ matrix: matrixOf([...PATHS, cert], sources) })), { width: 1200 });
  const line = a.edges.find((e) => e.edge.from === CONTROL_PLANE)!;
  const ys = [...line.d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
  assert.ok(ys.includes(TOP_LANE), line.d);
  // The level run in the lane spans the whole node column.
  const run = line.d.match(new RegExp(`(-?[\\d.]+) ${TOP_LANE} L(-?[\\d.]+) ${TOP_LANE}`))!;
  assert.ok(Number(run[1]) <= a.rowsX && Number(run[2]) >= a.rowsX + a.rowsW, line.d);
});

test("the arrow keys walk the lines source by source, each source's the tall column top to bottom before the addresses", () => {
  const sources = [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }];
  const two = plan({ config: { ...plan().config, sources: ["sh", "bj"] } });
  const paths = [...PATHS, ADDRESS_CHECK("sh"), probe("bj", "hk", { state: "up", p50_ms: 30 })];
  const a = layoutTopology(buildTopology(input({ plan: two, matrix: matrixOf(paths, sources), chains: [] })), { width: 1200 });
  const order = keyboardOrder(a);
  assert.deepEqual(
    order.map((le) => `${le.edge.from}>${le.edge.to}`),
    [...["hk", "us4", "us1", "us2", addressEndpoint("https://status.example.net/healthz")].map((to) => `sh>${to}`), "bj>hk"],
    "in the order the boxes are drawn, then by where they end: the rows top to bottom, then the addresses",
  );
  // Every drawn line is reachable exactly once.
  assert.equal(new Set(order.map((le) => le.key)).size, a.edges.length);
});

test("the lines are one tab stop: the line the keyboard was last on, else the open path's, else the first", () => {
  const walk = ["a", "b", "c", "d"];
  assert.equal(rovingStop(walk, [undefined, undefined]), "a");
  assert.equal(rovingStop(walk, ["c", "b"]), "c", "Tab comes back to the line the keyboard left");
  assert.equal(rovingStop(walk, [null, "b"]), "b", "else the open path's line");
  // A line the query faded is out of the walk: the stop moves to one it keeps.
  assert.equal(rovingStop(["b", "d"], ["c", "a"]), "b");
  assert.equal(rovingStop([], ["a"]), undefined, "nothing to stop on");
});

test("the arrow keys, Home and End move along the walk and stop at its ends; other keys do nothing", () => {
  const walk = ["a", "b", "c"];
  assert.equal(rovingMove(walk, "a", "ArrowDown"), "b");
  assert.equal(rovingMove(walk, "a", "ArrowRight"), "b");
  assert.equal(rovingMove(walk, "c", "ArrowDown"), "c", "no wrap past the last line");
  assert.equal(rovingMove(walk, "b", "ArrowUp"), "a");
  assert.equal(rovingMove(walk, "b", "ArrowLeft"), "a");
  assert.equal(rovingMove(walk, "a", "ArrowUp"), "a", "no wrap before the first");
  assert.equal(rovingMove(walk, "b", "Home"), "a");
  assert.equal(rovingMove(walk, "a", "End"), "c");
  // From a faded line the pointer opened: the nearest kept line that way, in the order every line has.
  const order = ["a", "f1", "b", "f2", "c"];
  assert.equal(rovingMove(walk, "f2", "ArrowDown", order), "c");
  assert.equal(rovingMove(walk, "f2", "ArrowUp", order), "b");
  assert.equal(rovingMove(walk, "f1", "ArrowLeft", order), "a");
  assert.equal(rovingMove(["a", "b"], "f2", "ArrowDown", order), "b", "nothing kept that way: the walk's end on that side");
  assert.equal(rovingMove(walk, "a", "Tab"), undefined);
  assert.equal(rovingMove(walk, "a", "Enter"), undefined);
  assert.equal(rovingMove([], "a", "ArrowDown"), undefined);
});

test("with a query the walk holds only the lines it keeps, in the same order", () => {
  const m = buildTopology({ ...nineSources(), drawnSources: ["s1", "s2", "s3", "s4"], matching: idsOf(nineSources(), ninePaths().filter((p) => p.target_node === "hk").map((p) => `${p.source}~hk`)) });
  const a = layoutTopology(m, { width: 1200 });
  const walk = keyboardOrder(a).filter((le) => le.bundle.some((e) => e.matched));
  assert.ok(walk.length > 0 && walk.length < a.edges.length, `${walk.length} of ${a.edges.length}`);
  assert.ok(walk.every((le) => le.edge.to === "hk"));
});

test("a card stays inside the window: below the point, or above it when below would leave the screen", () => {
  const room = { hostW: 1200, hostH: 2000, visibleTop: 0, visibleBottom: 900, cardW: 288, cardH: 120, margin: 4 };
  // Room below: the card sits under the point.
  assert.deepEqual(placeCard({ x: 300, y: 400 }, room), { x: 314, y: 414 });
  // Near the window's bottom, though the drawing runs on below it: above the point.
  assert.deepEqual(placeCard({ x: 300, y: 850 }, room), { x: 314, y: 850 - 14 - 120 });
  // The drawing scrolled up by 600 px: the window shows host rows 600 to 1500.
  const scrolled = { ...room, visibleTop: 600, visibleBottom: 1500 };
  assert.equal(placeCard({ x: 300, y: 1450 }, scrolled).y, 1450 - 14 - 120);
  // Never above the window's top edge either.
  assert.equal(placeCard({ x: 300, y: 620 }, { ...scrolled, cardH: 400, visibleBottom: 1000 }).y, 604);
  // The point itself below the window (a long line focused from its source): the card still ends on screen.
  assert.equal(placeCard({ x: 300, y: 1176 }, { ...room, visibleTop: 129, visibleBottom: 1129, hostH: 1210, cardH: 229 }).y, 1129 - 4 - 229);
  // Near the right edge: to the left of the point.
  assert.equal(placeCard({ x: 1100, y: 400 }, room).x, 1100 - 288 - 14);
});

test("a box's card sits beside it and moves up, or flips above the box, to stay on screen", () => {
  const room = { hostW: 1200, hostH: 2000, visibleTop: 0, visibleBottom: 900, cardW: 288, cardH: 120, margin: 4 };
  // Beside the box, level with its top.
  assert.deepEqual(placeCard({ x: 500, y: 300, w: 200, h: 32, anchored: true }, room), { x: 508, y: 300 });
  // The box's top near the window's bottom: the card moves up to end on screen.
  assert.equal(placeCard({ x: 500, y: 860, w: 200, h: 32, anchored: true }, room).y, 900 - 4 - 120);
  // No room on either side: under the box, or above it when under would leave the screen.
  const narrow = { ...room, hostW: 400 };
  assert.equal(placeCard({ x: 380, y: 300, w: 360, h: 32, anchored: true }, narrow).y, 300 + 32 + 4);
  assert.equal(placeCard({ x: 380, y: 800, w: 360, h: 32, anchored: true }, narrow).y, 800 - 4 - 120);
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

test("the row column grows with the drawn sources, from width the fan does not need, so target names keep their room", () => {
  // Several sources add a summary and a mark per source to each target row; both keep their width, so the name pays unless the column grows.
  const three = plan({ config: { ...plan().config, sources: ["sh", "bj", "x"] } });
  const threeMatrix = matrixOf(
    [...PATHS, ADDRESS_CHECK(), probe("bj", "hk", { state: "up", p50_ms: 30 }), probe("x", "hk", { state: "up", p50_ms: 31 })],
    [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }, { node_id: "x", name: "no-country" }],
  );
  const several = buildTopology(input({ plan: three, matrix: threeMatrix }));
  const one = buildTopology(input({ matrix: matrixOf([...PATHS, ADDRESS_CHECK()]) }));
  assert.equal(several.drawnSourceIds.length, 3);
  assert.equal(one.drawnSourceIds.length, 1);
  // 1440 px page: a 1358 px frame.
  const wide1 = layoutTopology(one, { width: 1358 });
  const wide3 = layoutTopology(several, { width: 1358 });
  assert.equal(wide1.rowsW, 380, "one source: the value is a figure, the column as it was");
  assert.equal(wide3.rowsW, 380 + ROW_SUMMARY_EXTRA_W + 3 * ROW_MARK_W);
  assert.ok(wide3.rowsX - LEFT_W >= FAN_MIN_W, "the fan keeps its gap");
  const six = layoutTopology({ ...several, drawnSourceIds: ["sh", "bj", "x", "a", "b", "c"] }, { width: 1358 });
  assert.equal(six.rowsW - wide3.rowsW, 3 * ROW_MARK_W, "each drawn source adds a mark's width");
  for (const a of [wide1, wide3, six]) assert.ok(a.addresses[0]!.box.x >= a.rowsX + a.rowsW, "never under the address column");
  // Narrow: the column grows only as far as the fan's minimum allows, and never shrinks below its old width.
  const mid = layoutTopology(several, { width: 1060 });
  assert.equal(mid.rowsX - LEFT_W, FAN_MIN_W);
  assert.ok(mid.rowsW > layoutTopology(one, { width: 1060 }).rowsW);
  const narrow = layoutTopology(several, { width: 900 });
  assert.equal(narrow.rowsW, layoutTopology(one, { width: 900 }).rowsW);
});

test("too narrow for its columns, the drawing keeps them and reports its real width", () => {
  const a = layoutTopology(buildTopology(input({ matrix: matrixOf([...PATHS, ADDRESS_CHECK()]) })), { width: 700 });
  const box = a.addresses[0]!.box;
  assert.ok(box.x >= a.rowsX + a.rowsW, "the address column never sits on the node column");
  assert.equal(a.width, box.x + box.w);
});

test("hovering an endpoint lights itself and its neighbours", () => {
  const m = buildTopology(input());
  assert.deepEqual([...neighbourhood(m, "hk")].sort(), ["bj", "hk", "sh", "us1"]);
});

/* ---- Rows and bundles, reads, boundaries ---- */

function fleetResponse(count: number, shape: (id: string, index: number) => "up" | "down" | "stale" = () => "up"): PathsResponse {
  const countries = ["US", "JP", "DE", "SG"];
  const targets: PathsResponse["targets"] = [];
  const paths: PathView[] = [];
  for (let i = 0; i < count; i++) {
    const id = `n${String(i).padStart(3, "0")}`;
    targets.push({ node_id: id, name: `node-${id}`, country: countries[i % countries.length]! });
    const kind = shape(id, i);
    paths.push(probe("sh", id, kind === "down" ? { state: "down", loss: 1 } : kind === "stale" ? { state: "unknown", reason: "results_stopped", samples: 0 } : { state: "up", p50_ms: 150, p95_ms: 170, loss: 0, last_at: ago(10_000) }));
  }
  return { window: "1h", degraded_at: ago(30_000), sources: [{ node_id: "sh", name: "cd-hs-sh" }], targets, paths };
}

/**
 * One source (sh) and `count` targets spread over four countries. `shape`
 * says how each target's path reads: up at 150 ms, down, or stale (the
 * server's unknown, results stopped).
 */
function fleet(count: number, over: Partial<TopologyInput> & { shape?: (id: string, index: number) => "up" | "down" | "stale" } = {}): TopologyInput {
  const { shape = () => "up", ...rest } = over;
  const nodes: Node[] = [node("sh", "cd-hs-sh", "CN")];
  const planNodes: LatencyProbePlan["nodes"] = [{ node_id: "sh", name: "cd-hs-sh", country: "CN", region: "mainland", source: true, target: "none" }];
  const pairs: LatencyProbePlan["pairs"] = [];
  const response = fleetResponse(count, shape);
  for (const target of response.targets ?? []) {
    nodes.push(node(target.node_id, target.name ?? target.node_id, target.country));
    planNodes.push({ node_id: target.node_id, name: target.name ?? target.node_id, country: target.country, region: "outside_mainland", source: false, target: "probed", monitor_id: `m_${target.node_id}`, endpoint: "203.0.113.1:443" });
    pairs.push({ source: "sh", target: target.node_id, enabled: true, active: true, monitor_id: `m_${target.node_id}` });
  }
  return { nodes, plan: { ...plan(), nodes: planNodes, pairs }, matrix: buildPathsMatrix(response), chains: [], incidents: [], window: "1h", layer: "paths", ...rest };
}

test("a row speaks for its live paths: one source whose path went unknown does not grey what the others measure", () => {
  const three = plan({ config: { ...plan().config, sources: ["sh", "bj", "gz"] } });
  const sources = [{ node_id: "sh", name: "cd-hs-sh" }, { node_id: "bj", name: "cd-bj-iplc" }, { node_id: "gz", name: "cd-gz" }];
  const paths = [
    ...PATHS,
    probe("bj", "hk", { state: "unknown", reason: "agent_offline", samples: 0 }),
    probe("gz", "hk", { state: "up", p50_ms: 160, p95_ms: 170 }),
  ];
  const m = buildTopology(input({ plan: three, matrix: matrixOf(paths, sources) }));
  const row = rowPath(m, "hk")!;
  assert.equal(row.count, 3);
  assert.equal(row.edge.from, "gz", "the slowest live measurement, not the grey");
  assert.equal(row.edge.state, "up");
  assert.equal(row.edge.p50Ms, 160);
  // With nothing live, the grey is all there is to show.
  const dead = paths.map((p) => (p.target_node === "hk" && p.source !== "bj" ? { ...p, state: "unknown", reason: "results_stopped" } : p));
  assert.equal(rowPath(buildTopology(input({ plan: three, matrix: matrixOf(dead, sources) })), "hk")!.edge.state, "unknown");
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

test("a chain out of a source rides below the path to the same row", () => {
  const sh: LineChainView = { source_line_uuid: "line-sh", source_node_id: "sh", status: "converged", current: { target_node_id: "hk", target_line_uuid: "line-hk", artifact_digest: "e", status: "converged" }, attempt: null };
  const a = layoutTopology(buildTopology(input({ chains: [...CHAINS, sh] })), { width: 1200 });
  const path = a.edges.find((e) => e.edge.id === "path:sh>hk")!;
  const chain = a.edges.find((e) => e.edge.id === "chain:line-sh")!;
  assert.equal(chain.end.y, path.end.y + 6);
});

test("chains are drawn as two rails, so shape and not only hue tells them from paths", () => {
  const m = buildTopology(input());
  for (const e of m.edges) assert.equal(!!edgeStyle(e).double, e.kind === "chain", e.id);
});

test("a source that does not measure a target draws no edge to it", () => {
  const m = buildTopology(input({ matrix: matrixOf(PATHS.filter((p) => p.target_node !== "us1")) }));
  assert.equal(m.edges.find((e) => e.id === "path:sh>us1"), undefined);
  assert.equal(m.counts.drawn, buildTopology(input()).counts.drawn - 1);
});

test("an interval under a minute still waits three minutes before calling a path quiet", () => {
  assert.equal(quietAfterMs(20), 180_000);
});

const OK: TopoReadStatus = { allowed: true, hasData: true, failed: false };
const FAILED: TopoReadStatus = { allowed: true, hasData: false, failed: true };
const STALE: TopoReadStatus = { allowed: true, hasData: true, failed: true };
const LOADING: TopoReadStatus = { allowed: true, hasData: false, failed: false };
const DENIED: TopoReadStatus = { allowed: false, hasData: false, failed: false };
const reads = (over: Partial<TopoReadStatuses> = {}): TopoReadStatuses => ({ plan: OK, paths: OK, nodes: OK, incidents: OK, chains: OK, ...over });

test("a filter's reads are the ones its drawing is built from, never one the session cannot send", () => {
  assert.deepEqual(readsFor("all", reads()), ["plan", "paths", "nodes", "incidents", "chains"]);
  assert.deepEqual(readsFor("paths", reads()), ["plan", "paths", "nodes", "incidents"]);
  assert.deepEqual(readsFor("chains", reads({ nodes: DENIED })), ["plan", "incidents", "chains"]);
  assert.deepEqual(readsFor("all", reads({ chains: DENIED })), ["plan", "paths", "nodes", "incidents"]);
});

test("a read that never landed and failed is missing; a failed refresh after a good read is only stale", () => {
  assert.equal(readState(FAILED), "failed");
  assert.equal(readState(STALE), "read");
  assert.equal(readState(LOADING), "loading");
  assert.equal(readState(DENIED), "unreadable");
  assert.deepEqual(missingReads("all", reads({ chains: FAILED, nodes: FAILED, incidents: STALE })), ["nodes", "chains"]);
  assert.deepEqual(missingReads("paths", reads({ chains: FAILED })), [], "the Paths filter draws no chains");
  assert.deepEqual(missingReads("all", reads({ nodes: { ...FAILED, allowed: false } })), [], "a read never sent cannot fail");
});

test("the Chains filter says denied, failed, loading or none, in that order of what is known", () => {
  const none = buildTopology(input({ layer: "chains", chains: [] }));
  assert.equal(layerEmpty(none, reads({ chains: DENIED })), "chainsDenied");
  assert.equal(layerEmpty(none, reads({ chains: FAILED })), "chainsFailed");
  assert.equal(layerEmpty(none, reads({ chains: LOADING })), "loading");
  assert.equal(layerEmpty(none, reads()), "noChains");
  assert.equal(layerEmpty(buildTopology(input({ layer: "chains" })), reads()), null);
  assert.equal(layerEmpty(buildTopology(input({ layer: "paths", matrix: matrixOf([]) })), reads()), "noSources");
});
