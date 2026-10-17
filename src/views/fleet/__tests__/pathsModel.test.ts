import assert from "node:assert/strict";
import { test } from "node:test";

import enFleet from "../../../i18n/locales/en/fleet.ts";
import zhFleet from "../../../i18n/locales/zh-CN/fleet.ts";

import type { LatencyProbePlan, LatencyRollups, PathsResponse } from "@/lib/api/types";
import { applyQuery, compileQuery } from "@/lib/query/engine";

import {
  attentionQuery,
  availability,
  DEGRADED_LEAVE_AFTER_MS,
  DEGRADED_REASONS,
  formatShare,
  quoteQueryValue,
  judgesDegraded,
  PATH_STATES,
  PATHS_QUERY_EXAMPLES,
  readDegradation,
  stateRank,
  availableWindows,
  buildPathsMatrix,
  cellKey,
  decodePathKey,
  effectiveWindow,
  encodePathKey,
  formatDeltaLoss,
  formatDeltaMs,
  groupPathRows,
  isChosenUnknown,
  isMissingRoute,
  legacyMonitoringRedirect,
  legacyWindow,
  looksLikePaths,
  matrixSections,
  methodsBySource,
  normalizeState,
  parseWindow,
  pathAttention,
  pathDelta,
  pathsFromLatency,
  pathsQuerySchema,
  reachBySource,
  reachQuery,
  reasonCode,
  visibleMatrix,
  runEchoes,
  runRows,
  UNKNOWN_REASONS,
  LOSS_FILL,
  LOSS_TEXT,
  lossTone,
} from "../pathsModel.ts";

function response(over: Partial<PathsResponse> = {}): PathsResponse {
  return {
    window: "24h",
    observed_at: "2026-10-16T08:00:00Z",
    sources: [{ node_id: "sh", name: "cd-hs-sh" }],
    targets: [
      { node_id: "hk", name: "gomami-hk", country: "HK" },
      { node_id: "jp", name: "xuezhang-jp-nat", country: "JP" },
      { node_id: "kix", name: "Oracle-KIX-arm", country: "JP" },
      { node_id: "fsn", name: "hetzner-fsn", country: "DE" },
      { node_id: "la", name: "racknerd-la", country: "US" },
      { node_id: "nat", name: "Aaitr-Frontier-NAT", country: "US" },
    ],
    paths: [
      { source: "sh", target_node: "hk", target: "203.0.113.1:443", monitor_id: "mon_lat_hk", managed: true, method: "tcp", state: "up", p50_ms: 34, p95_ms: 41, jitter_ms: 2, loss: 0, samples: 288, expected: 288, prev: { p50_ms: 30, loss: 0.01 } },
      { source: "sh", target_node: "jp", target: "203.0.113.9:50100", monitor_id: "mon_lat_jp", managed: true, method: "tcp", state: "down", reason: "dial tcp 203.0.113.9:50100: i/o timeout", loss: 1, samples: 288, expected: 288 },
      { source: "sh", target_node: "kix", target: "", monitor_id: "", managed: true, method: "tcp", state: "unknown", reason: "udp_only", samples: 0, expected: 0 },
      { source: "sh", target_node: "fsn", target: "203.0.113.4:443", monitor_id: "mon_lat_fsn", managed: true, method: "tcp", state: "up", p50_ms: 241, p95_ms: 280, loss: 0.04, samples: 276, expected: 288 },
      { source: "sh", target_node: "la", target: "203.0.113.5:443", monitor_id: "mon_lat_la", managed: true, method: "tcp", state: "unknown", reason: "path_paused", samples: 0, expected: 0 },
      { source: "sh", target_node: "nat", target: "", monitor_id: "", managed: true, method: "tcp", state: "unknown", reason: "no_public_address", samples: 0, expected: 0 },
      { source: "sh", target: "https://status.example.com/health", monitor_id: "mon_http", managed: false, method: "http", state: "up", p50_ms: 120, samples: 2880, expected: 2880 },
    ],
    ...over,
  };
}

test("windows: 14 days only with 14 days of fine history, three on a legacy server", () => {
  assert.deepEqual(availableWindows("paths", 7), ["1h", "6h", "24h", "3d", "7d"]);
  assert.deepEqual(availableWindows("paths", 14), ["1h", "6h", "24h", "3d", "7d", "14d"]);
  assert.deepEqual(availableWindows("unknown"), ["1h", "6h", "24h", "3d", "7d"]);
  assert.deepEqual(availableWindows("legacy", 14), ["1h", "24h", "7d"]);
});

test("windows: a window the server cannot answer falls back to the longest one not longer", () => {
  assert.equal(parseWindow("3d"), "3d");
  assert.equal(parseWindow("30d"), "1h");
  assert.equal(parseWindow(undefined), "1h");
  assert.equal(effectiveWindow("6h", ["1h", "24h", "7d"]), "1h");
  assert.equal(effectiveWindow("3d", ["1h", "24h", "7d"]), "24h");
  assert.equal(effectiveWindow("14d", ["1h", "6h", "24h", "3d", "7d"]), "7d");
  assert.equal(effectiveWindow("24h", ["1h", "24h", "7d"]), "24h");
  assert.equal(legacyWindow("14d"), "7d");
  assert.equal(legacyWindow("6h"), "1h");
});

test("old links: latency becomes paths with its pair, monitors becomes checks", () => {
  assert.deepEqual(legacyMonitoringRedirect({ view: "latency", pair: "sh~jp", window: "24h" }), { view: "paths", path: "sh~jp", window: "24h" });
  assert.deepEqual(legacyMonitoringRedirect({ view: "latency" }), { view: "paths" });
  assert.deepEqual(legacyMonitoringRedirect({ view: "monitors", open: "mon_1" }), { view: "checks", open: "mon_1" });
  assert.deepEqual(legacyMonitoringRedirect({ view: "keepalive" }), { view: "incidents" });
  assert.deepEqual(legacyMonitoringRedirect({ tab: "keepalive" }), { view: "incidents" });
  assert.deepEqual(legacyMonitoringRedirect({ tab: "latency", pair: "a~b" }), { view: "paths", path: "a~b" });
  // A pair without a layer is a path link; an explicit path wins over a pair.
  assert.deepEqual(legacyMonitoringRedirect({ pair: "a~b" }), { view: "paths", path: "a~b" });
  assert.deepEqual(legacyMonitoringRedirect({ view: "paths", pair: "a~b", path: "c~d" }), { view: "paths", path: "c~d" });
  assert.equal(legacyMonitoringRedirect({ view: "paths" }), null);
  assert.equal(legacyMonitoringRedirect({}), null);
});

test("path keys: generated paths keep the old pair spelling, operator checks name the check", () => {
  assert.equal(encodePathKey({ source: "sh", targetNode: "jp" }), "sh~jp");
  assert.equal(encodePathKey({ source: "sh", monitorId: "mon_http" }), "sh~@mon_http");
  assert.equal(encodePathKey({ source: "", monitorId: "mon_tls" }), "_~@mon_tls");
  assert.deepEqual(decodePathKey("sh~jp"), { source: "sh", targetNode: "jp" });
  assert.deepEqual(decodePathKey("sh~@mon_http"), { source: "sh", monitorId: "mon_http" });
  assert.deepEqual(decodePathKey("_~@mon_tls"), { source: "", monitorId: "mon_tls" });
  assert.equal(decodePathKey("sh~@"), undefined);
  assert.equal(decodePathKey("~jp"), undefined);
  assert.equal(decodePathKey("nope"), undefined);
});

test("states: degraded only from a server that judges it; anything else unknown, never up", () => {
  assert.equal(normalizeState("up"), "up");
  assert.equal(normalizeState("down"), "down");
  assert.equal(normalizeState("degraded"), "degraded");
  assert.equal(normalizeState("degraded", false), "unknown", "a server that sends no degraded_at does not judge degraded");
  assert.equal(normalizeState("slow"), "unknown");
  assert.equal(normalizeState(undefined), "unknown");
});

test("reasons: known codes and their aliases read as one code, others stay as sent", () => {
  assert.equal(reasonCode("udp_only"), "udp_only");
  assert.equal(reasonCode("pair_off"), "path_paused");
  assert.equal(reasonCode("config_off"), "path_set_paused");
  assert.equal(reasonCode("Agent Offline"), "agent_offline");
  // The four reasons the design 29 server sends.
  for (const code of ["agent_offline", "source_paused", "not_probeable", "no_data"]) assert.equal(reasonCode(code), code);
  assert.equal(isChosenUnknown("source_paused"), true, "the server's one pause reason covers every pause");
  assert.equal(reasonCode("something new"), undefined);
  assert.equal(reasonCode(""), undefined);
  assert.equal(isChosenUnknown("path_paused"), true);
  assert.equal(isChosenUnknown("udp_only"), false);
});

test("matrix: node targets as rows by region, operator checks as rows of their own", () => {
  const m = buildPathsMatrix(response(), { checkName: (id) => (id === "mon_http" ? "Status page" : undefined) });
  assert.deepEqual(m.sources, [{ nodeId: "sh", name: "cd-hs-sh" }]);
  assert.equal(m.rows.length, 7);
  assert.deepEqual(m.counts, { paths: 7, up: 3, degraded: 0, down: 1, unknown: 2, paused: 1 }, "a pause is counted apart from unknown");
  assert.equal(m.judgesDegraded, false, "an M2 server sends no degraded_at");
  const check = m.rows.find((r) => r.kind === "check")!;
  assert.equal(check.key, "@mon_http");
  assert.equal(check.name, "Status page");
  const cell = m.cells.get(cellKey("@mon_http", "sh"))!;
  assert.equal(cell.key, "sh~@mon_http");
  assert.equal(m.cells.get(cellKey("jp", "sh"))!.key, "sh~jp");
  const groups = groupPathRows(m.rows).map((g) => [g.group, g.rows.map((r) => r.key)]);
  assert.deepEqual(groups, [
    ["eastAsia", ["hk", "kix", "jp"]],
    ["northAmerica", ["nat", "la"]],
    ["europe", ["fsn"]],
    ["checks", ["@mon_http"]],
  ]);
  assert.equal(m.observedAt, Date.parse("2026-10-16T08:00:00Z"));
});

test("matrix: a source the server did not list still gets a column; the control plane has a name", () => {
  const m = buildPathsMatrix(
    response({
      paths: [{ source: "", target: "example.com:443", monitor_id: "mon_tls", managed: false, method: "tls", state: "up", samples: 24, expected: 24 }],
    }),
    { controlPlane: "Control plane" },
  );
  assert.deepEqual(m.sources.map((s) => s.name), ["cd-hs-sh", "Control plane"]);
  assert.equal(m.paths[0]!.key, "_~@mon_tls");
});

test("matrix: the control plane the server lists as a source is named in the console's words", () => {
  // The server sends it with no node id and its English name, first in its name order.
  const tls = { source: "", target: "example.com:443", monitor_id: "mon_tls", managed: false, method: "tls", state: "up", samples: 24, expected: 24 };
  const r = response({ paths: [tls] });
  r.sources = [{ node_id: "", name: "Control plane", region: "" }, ...r.sources];
  const zh = buildPathsMatrix(r, { controlPlane: "控制面" });
  assert.deepEqual(zh.sources.map((s) => [s.nodeId, s.name]), [["", "控制面"], ["sh", "cd-hs-sh"]]);
  assert.equal(zh.paths[0]!.sourceName, "控制面");
  // Without a label of its own the console keeps the server's name.
  assert.equal(buildPathsMatrix(r).sources[0]!.name, "Control plane");
});

test("matrix: two checks in one cell show the worse state", () => {
  const base = response().paths[0]!;
  const m = buildPathsMatrix(response({ paths: [base, { ...base, monitor_id: "mon_latb_hk", method: "beacon", state: "down" }] }));
  assert.equal(m.cells.get(cellKey("hk", "sh"))!.state, "down");
  assert.equal(m.paths.length, 2);
});

test("attention: downs one per target first, then unknowns grouped by reason, pauses last as one line", () => {
  const extra = response();
  extra.sources.push({ node_id: "sh2", name: "volc-sh" });
  extra.paths.push(
    { source: "sh2", target_node: "jp", target: "203.0.113.9:50100", monitor_id: "mon_lat_jp", managed: true, method: "tcp", state: "down", loss: 0.6, samples: 288, expected: 288 },
    { source: "sh2", target_node: "kix", target: "", monitor_id: "", managed: true, method: "tcp", state: "unknown", reason: "udp_only", samples: 0, expected: 0 },
    { source: "sh2", target_node: "fsn", target: "203.0.113.4:443", monitor_id: "mon_lat_fsn", managed: true, method: "tcp", state: "down", loss: 0.3, samples: 288, expected: 288 },
  );
  const items = pathAttention(buildPathsMatrix(extra));
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.kind === "down" ? `${i.rowKey}:${i.paths.length}/${i.measuredBy}` : i.kind === "unknown" ? `${i.reason}:${i.paths.length}` : i.paths.length}`),
    ["down:jp:2/2", "down:fsn:1/2", "unknown:udp_only:2", "unknown:no_public_address:1", "paused:1"],
  );
  const jp = items[0]!;
  assert.equal(jp.kind === "down" && jp.paths[0]!.sourceName, "cd-hs-sh", "the worse loss leads");
  assert.equal(attentionQuery(items[0]!), 'state:down target:=xuezhang-jp-nat');
  assert.equal(attentionQuery(items[2]!), "state:unknown reason:=udp_only");
  assert.equal(attentionQuery(items[4]!), "state:paused");
  assert.equal(attentionQuery({ kind: "down", rowKey: "x", targetName: "[cd] hk mini", paths: [], worstLoss: 1, measuredBy: 1 }), 'state:down target:="[cd] hk mini"');
});

test("attention: an offline agent is one line for its source, not one per path", () => {
  const r = response();
  r.sources.push({ node_id: "hr", name: "mkcloud hr" });
  for (const target of ["hk", "fsn", "la"]) r.paths.push({ source: "hr", target_node: target, target: "", monitor_id: `mon_lat_${target}`, managed: true, method: "tcp", state: "unknown", reason: "agent_offline", samples: 0, expected: 60 });
  const items = pathAttention(buildPathsMatrix(r));
  const offline = items.find((i) => i.kind === "offline")!;
  assert.equal(offline.kind === "offline" && offline.sourceName, "mkcloud hr");
  assert.equal(offline.paths.length, 3);
  assert.equal(attentionQuery(offline), 'state:unknown source:="mkcloud hr"');
  assert.ok(items.findIndex((i) => i.kind === "offline") < items.findIndex((i) => i.kind === "unknown"), "offline sources come before other unknowns");
});

test("reach: each source's paths by state", () => {
  const reach = reachBySource(buildPathsMatrix(response()));
  assert.deepEqual(reach, [{ source: "sh", name: "cd-hs-sh", up: 2, degraded: 0, down: 1, unknown: 2, paused: 1, total: 6 }], "the operator check to a URL is not reach; a pause is not unknown");
  assert.equal(reachQuery(reach[0]!, "down"), "source:=cd-hs-sh state:down");
});

test("delta and availability", () => {
  assert.deepEqual(pathDelta({ p50Ms: 34, loss: 0, prev: { p50Ms: 30, loss: 0.01 } }), { p50Ms: 4, loss: -0.01 });
  assert.deepEqual(pathDelta({ p50Ms: 34, loss: 0, prev: undefined }), {});
  assert.deepEqual(pathDelta({ p50Ms: undefined, loss: 0.2, prev: { p50Ms: 30 } }), {});
  assert.equal(formatDeltaMs(12.4), "+12 ms");
  assert.equal(formatDeltaMs(-3.44), "-3.4 ms");
  assert.equal(formatDeltaMs(0.01), "0 ms");
  assert.equal(formatDeltaMs(1500), "+1.50 s");
  assert.equal(formatDeltaLoss(0.12), "+12 pt");
  assert.equal(formatDeltaLoss(-0.005), "-0.5 pt");
  assert.equal(formatDeltaLoss(0), "0 pt");
  assert.equal(availability({ samples: 276, expected: 288, loss: 0.04 }), (276 * 0.96) / 288);
  assert.equal(availability({ samples: 0, expected: 0 }), undefined);
});

test("query: state, source, target, reason words, loss in percent and p50 in ms", () => {
  const m = buildPathsMatrix(response(), { checkName: (id) => (id === "mon_http" ? "Status page" : undefined) });
  const schema = pathsQuerySchema({ reasonText: (r) => (r === "udp_only" ? "serves UDP only" : r ?? "") });
  const run = (text: string) => {
    const compiled = compileQuery(text, schema);
    assert.ok(compiled.ok, `${text} should compile`);
    return applyQuery(m.paths, compiled.query).map((p) => p.key);
  };
  assert.deepEqual(run("state:down"), ["sh~jp"]);
  assert.deepEqual(run("state:failing"), ["sh~jp"]);
  assert.deepEqual(run("state:paused"), ["sh~la"]);
  assert.deepEqual(run("state:unknown").sort(), ["sh~kix", "sh~nat"], "a pause is not unknown in the query either");
  assert.deepEqual(run("target:jp source:cd-hs-sh state:down"), ["sh~jp"]);
  assert.deepEqual(run("reason:udp"), ["sh~kix"]);
  assert.deepEqual(run("reason:\"UDP only\""), ["sh~kix"]);
  assert.deepEqual(run("loss>1% state:up"), ["sh~fsn"]);
  assert.deepEqual(run("p50>200"), ["sh~fsn"]);
  assert.deepEqual(run("method:http"), ["sh~@mon_http"]);
  assert.deepEqual(run("check:status"), ["sh~@mon_http"]);
  assert.deepEqual(run("-is:managed"), ["sh~@mon_http"]);
  assert.deepEqual(run("region:europe"), ["sh~fsn"]);
  const bad = compileQuery("state:sideways", schema);
  assert.equal(bad.ok, false);
});

test("query: the matrix keeps rows and columns that hold a match, and dims the rest", () => {
  const m = buildPathsMatrix(response());
  const all = visibleMatrix(m, undefined);
  assert.equal(all.rows.length, 7);
  const filtered = visibleMatrix(m, new Set(["sh~jp", "sh~fsn"]));
  assert.deepEqual(filtered.rows.map((r) => r.key).sort(), ["fsn", "jp"]);
  assert.deepEqual(filtered.sources.map((s) => s.nodeId), ["sh"]);
  assert.equal(filtered.matches(m.cells.get(cellKey("hk", "sh"))!), false);
});

test("sections: check sources do not widen the node matrix", () => {
  const r = response();
  r.paths.push({ source: "fsn", target: "https://status.example.com/health", monitor_id: "mon_http", managed: false, method: "http", state: "up", samples: 10, expected: 10 });
  r.paths.push({ source: "", target: "example.com:443", monitor_id: "mon_tls", managed: false, method: "tls", state: "up", samples: 1, expected: 1 });
  const m = buildPathsMatrix(r);
  const sections = matrixSections(m, visibleMatrix(m, undefined));
  assert.deepEqual(
    sections.map((s) => [s.kind, s.sources.map((c) => c.nodeId), s.groups.map((g) => g.group)]),
    [
      ["nodes", ["sh"], ["eastAsia", "northAmerica", "europe"]],
      ["checks", ["sh", "fsn", ""], ["checks"]],
    ],
  );
  const onlyDown = matrixSections(m, visibleMatrix(m, new Set(["sh~jp"])));
  assert.deepEqual(onlyDown.map((s) => s.kind), ["nodes"]);
});

function plan(): LatencyProbePlan {
  return {
    config: { enabled: true, interval_sec: 60, timeout_sec: 5, sources: ["sh", "gone"], auto_targets: true, version: 3, disabled_pairs: [{ source: "sh", target: "la" }] },
    stored: true,
    default_source_name: "cd-hs-sh",
    source_notes: { gone: "unknown_node" },
    nodes: [
      { node_id: "sh", name: "cd-hs-sh", country: "CN", region: "mainland", source: true, target: "none" },
      { node_id: "hk", name: "gomami-hk", country: "HK", region: "outside_mainland", source: false, target: "probed", endpoint: "203.0.113.1:443", monitor_id: "mon_lat_hk" },
      { node_id: "jp", name: "xuezhang-jp-nat", country: "JP", region: "outside_mainland", source: false, target: "probed", endpoint: "203.0.113.9:50100", monitor_id: "mon_lat_jp" },
      { node_id: "kix", name: "Oracle-KIX-arm", country: "JP", region: "outside_mainland", source: false, target: "not_probeable", endpoint_note: "udp_only" },
      { node_id: "la", name: "racknerd-la", country: "US", region: "outside_mainland", source: false, target: "paused", target_reason: "pairs_off", endpoint: "203.0.113.5:443", monitor_id: "mon_lat_la" },
      { node_id: "dark", name: "DMIT-4", country: "US", region: "outside_mainland", source: false, target: "probed", endpoint: "203.0.113.6:443", monitor_id: "mon_lat_dark" },
      { node_id: "new", name: "fresh", country: "SG", region: "outside_mainland", source: false, target: "probed", endpoint: "203.0.113.7:443", monitor_id: "mon_lat_new" },
    ],
    pairs: [
      { source: "sh", target: "hk", enabled: true, active: true, monitor_id: "mon_lat_hk" },
      { source: "sh", target: "jp", enabled: true, active: true, monitor_id: "mon_lat_jp" },
      { source: "sh", target: "kix", enabled: true, active: false },
      { source: "sh", target: "la", enabled: false, active: false, monitor_id: "mon_lat_la" },
      { source: "sh", target: "dark", enabled: true, active: true, monitor_id: "mon_lat_dark" },
      { source: "sh", target: "new", enabled: true, active: true, monitor_id: "mon_lat_new" },
    ],
  };
}

const NOW = Date.parse("2026-10-16T08:00:00Z");

function rollups(): LatencyRollups {
  const stats = (p50?: number, loss = 0) => ({ samples: 60, failures: Math.round(60 * loss), expected: 60, p50_ms: p50, p95_ms: p50 ? p50 * 1.2 : undefined, loss });
  return {
    generated_at: "2026-10-16T08:00:00Z",
    interval_sec: 60,
    pairs: [
      { source: "sh", target: "hk", monitor_id: "mon_lat_hk", windows: { "1h": stats(34), "24h": stats(36) }, latest: { monitor_id: "mon_lat_hk", node_id: "sh", at: "2026-10-16T07:59:40Z", success: true, latency_ms: 33 } },
      { source: "sh", target: "jp", monitor_id: "mon_lat_jp", windows: { "1h": stats(undefined, 1) }, latest: { monitor_id: "mon_lat_jp", node_id: "sh", at: "2026-10-16T07:59:30Z", success: false, error: "dial tcp 203.0.113.9:50100: i/o timeout" } },
      { source: "sh", target: "dark", monitor_id: "mon_lat_dark", windows: { "1h": { samples: 0, failures: 0, expected: 60 } }, latest: { monitor_id: "mon_lat_dark", node_id: "sh", at: "2026-10-10T05:00:00Z", success: true } },
    ],
  };
}

test("legacy: the latency plan and rollups make the same matrix shape, with the plan's reasons", () => {
  const r = pathsFromLatency(plan(), rollups(), "6h", NOW);
  assert.equal(r.window, "1h", "6h reads the 1h rollup on a legacy server");
  const by = new Map(r.paths.map((p) => [`${p.source}~${p.target_node}`, p]));
  assert.equal(by.get("sh~hk")!.state, "up");
  assert.equal(by.get("sh~hk")!.p50_ms, 34);
  assert.equal(by.get("sh~jp")!.state, "down");
  assert.match(by.get("sh~jp")!.reason!, /i\/o timeout/);
  assert.equal(by.get("sh~kix")!.reason, "udp_only");
  assert.equal(by.get("sh~la")!.reason, "path_paused");
  assert.equal(by.get("sh~dark")!.reason, "results_stopped");
  assert.equal(by.get("sh~new")!.reason, "no_results");
  // The configured source that cannot probe has no pairs, so every one of its paths is unknown with its note.
  assert.equal(by.get("gone~hk")!.reason, "unknown_node");
  assert.equal(reasonCode(by.get("gone~hk")!.reason), "source_unavailable");
  const m = buildPathsMatrix(r);
  assert.equal(m.counts.down, 1);
  assert.equal(m.counts.up, 1);
  const paused = pathsFromLatency({ ...plan(), config: { ...plan().config, enabled: false } }, rollups(), "1h", NOW);
  assert.equal(paused.paths.find((p) => p.target_node === "hk" && p.source === "sh")!.reason, "path_set_paused");
});

test("legacy detection: 404 and 405 mean the route is missing; a non-matrix body is not paths", () => {
  assert.equal(isMissingRoute({ status: 404 }), true);
  assert.equal(isMissingRoute({ status: 405 }), true);
  assert.equal(isMissingRoute({ status: 502 }), false);
  assert.equal(isMissingRoute(new Error("x")), false);
  assert.equal(looksLikePaths({ paths: [] }), true);
  assert.equal(looksLikePaths("<!doctype html>"), false);
  assert.equal(looksLikePaths(undefined), false);
});

test("the M2a reasons have their own sentences", () => {
  for (const code of ["agent_too_old", "icmp_not_permitted", "icmp_filtered", "destination_refused"]) assert.equal(reasonCode(code), code);
  assert.equal(reasonCode("unsupported_method"), "agent_too_old");
});

test("a multi-packet run lists its echoes; a single-probe run has none", () => {
  assert.deepEqual(runEchoes({ sent: 5, lost: 1, rtts_ms: [68.24, 70.06, 69.8, 71] }), { sent: 5, lost: 1, rtts: ["68.2", "70.1", "69.8", "71.0"] });
  assert.equal(runEchoes({}), undefined);
  assert.equal(runEchoes({ sent: 0 }), undefined);
  assert.deepEqual(runEchoes({ sent: 3, lost: 7 }), { sent: 3, lost: 3, rtts: [] }, "lost never exceeds sent");
});

test("every unknown reason has a sentence and a cell form in both locales", () => {
  for (const messages of [enFleet, zhFleet] as unknown as { fleet: { monitoring: { paths: { reason: Record<string, string>; reasonShort: Record<string, string> } } } }[]) {
    const paths = messages.fleet.monitoring.paths;
    for (const code of UNKNOWN_REASONS) {
      assert.equal(typeof paths.reason[code], "string", `reason.${code}`);
      assert.equal(typeof paths.reasonShort[code], "string", `reasonShort.${code}`);
    }
  }
});

test("runs that measured nothing for one reason are one row with a count, newest first", () => {
  const runs = [
    { at: "5", reason: "icmp_not_permitted" },
    { at: "4", reason: "icmp_not_permitted" },
    { at: "3", reason: "icmp_not_permitted" },
    { at: "2", success: true },
    { at: "1", reason: "destination_refused" },
    { at: "0", reason: "icmp_not_permitted" },
  ];
  const rows = runRows(runs);
  assert.deepEqual(
    rows.map((r) => (r.kind === "run" ? `run ${r.run.at}` : `${r.reason} x${r.count} ${r.newest.at}..${r.oldest.at}`)),
    ["icmp_not_permitted x3 5..3", "run 2", "destination_refused x1 1..1", "icmp_not_permitted x1 0..0"],
  );
  assert.deepEqual(runRows([]), []);
});

test("on a path that reads unknown, failed runs fold into one row with the path's reason", () => {
  const runs = [
    { at: "3", success: false, error: "no echo" },
    { at: "2", success: false, error: "no echo" },
    { at: "1", success: true },
    { at: "0", success: false, reason: "agent_too_old" },
  ];
  const rows = runRows(runs, "icmp_filtered");
  assert.deepEqual(
    rows.map((r) => (r.kind === "run" ? `run ${r.run.at}` : `${r.reason} x${r.count}`)),
    ["icmp_filtered x2", "run 1", "agent_too_old x1"],
    "a run's own reason wins; a success stays a run",
  );
  assert.deepEqual(runRows(runs).map((r) => r.kind), ["run", "run", "run", "unmeasured"], "without a path reason a failure is a failure");
});

test("each source's methods: one names the column, several put the method on each cell", () => {
  const by = methodsBySource([
    { source: "sh", method: "icmp" },
    { source: "sh", method: "icmp" },
    { source: "mk", method: "tcp" },
    { source: "mk", method: "icmp" },
    { source: "old", method: "" },
  ]);
  assert.deepEqual(by.get("sh"), ["icmp"]);
  assert.deepEqual(by.get("mk"), ["icmp", "tcp"]);
  assert.equal(by.has("old"), false, "a path from before M2a names no method");
});

test("the beacon's reasons are known codes, and refused_by_node is its own reason, not a refused method", () => {
  for (const code of ["beacon_not_enabled", "firewall_pending", "beacon_source_pending", "refused_by_node", "beacon_not_listening", "beacon_filtered", "beacon_stale", "beacon_unknown_epoch", "beacon_rate_limited", "beacon_no_key"]) {
    assert.equal(reasonCode(code), code, code);
    assert.equal(isChosenUnknown(code), false, `${code} is not a pause`);
  }
  assert.equal(reasonCode("refused by node"), "refused_by_node");
  assert.equal(reasonCode("method_refused"), "method_refused");
});

test("a beacon's reachability check is not a path: the matrix leaves it out", () => {
  const m = buildPathsMatrix({
    window: "1h",
    sources: [{ node_id: "sh", name: "cd-hs-sh" }],
    targets: [{ node_id: "jp", name: "xuezhang-jp-nat", country: "JP" }],
    paths: [
      { source: "sh", target_node: "jp", target: "203.0.113.12:50231", monitor_id: "mon_latb_jp", managed: true, method: "beacon", state: "up", p50_ms: 66, samples: 60, expected: 60 },
      { source: "sh", target_node: "jp", target: "203.0.113.12:50231", monitor_id: "mon_beaconr_jp", managed: false, method: "beacon", state: "up", p50_ms: 66, samples: 1, expected: 1 },
    ],
  });
  assert.deepEqual(m.paths.map((p) => p.monitorId), ["mon_latb_jp"]);
  assert.equal(m.counts.paths, 1);
  assert.equal(m.rows.length, 1, "no row for the reachability check");
});

/* ---- Design 29 M3 (contract D13): degraded ---- */

const DEGRADED = {
  since: "2026-10-16T07:20:00Z",
  evaluated_at: "2026-10-16T07:59:00Z",
  loss: { value: 0.042, baseline: 0.004, trigger: 0.02, sent: 290, lost: 12 },
};

function m3(over: Partial<PathsResponse> = {}): PathsResponse {
  const r = response({ degraded_at: "2026-10-16T07:59:30Z", ...over });
  r.paths[0] = { ...r.paths[0]!, state: "degraded", reason: "degraded_loss", degraded: DEGRADED };
  return r;
}

test("degraded: read from an M3 server with its evidence, counted, ranked between down and unknown", () => {
  const m = buildPathsMatrix(m3());
  assert.equal(m.judgesDegraded, true);
  assert.equal(m.degradedAt, Date.parse("2026-10-16T07:59:30Z"));
  const hk = m.paths.find((p) => p.key === "sh~hk")!;
  assert.equal(hk.state, "degraded");
  assert.equal(hk.reason, "degraded_loss");
  assert.deepEqual(hk.degraded, {
    since: Date.parse(DEGRADED.since),
    evaluatedAt: Date.parse(DEGRADED.evaluated_at),
    clearingSince: undefined,
    loss: { value: 0.042, baseline: 0.004, trigger: 0.02, sent: 290, lost: 12 },
  });
  assert.equal(m.counts.degraded, 1);
  assert.equal(m.counts.up, 2);
  assert.deepEqual(["up", "unknown", "degraded", "down"].map((s) => stateRank(s as "up")), [3, 2, 1, 0]);
  assert.deepEqual(PATH_STATES, ["down", "degraded", "unknown", "paused", "up"]);
  assert.ok(PATHS_QUERY_EXAMPLES.some((e) => e.query === "state:degraded"));
});

test("degraded: degraded_at null before the evaluator's first run still marks an M3 server; no key marks an older one", () => {
  assert.equal(judgesDegraded({ degraded_at: null }), true);
  assert.equal(judgesDegraded({}), false);
  assert.equal(buildPathsMatrix(response({ degraded_at: null })).degradedAt, undefined);
  const older = response();
  older.paths[0] = { ...older.paths[0]!, state: "degraded" };
  assert.equal(buildPathsMatrix(older).paths[0]!.state, "unknown", "a state the server does not compute is never shown");
});

test("degraded: a clearing path keeps its state and says when the condition went; an unreadable arm drops", () => {
  const r = m3();
  r.paths[0] = { ...r.paths[0]!, reason: "degraded_latency", degraded: { since: DEGRADED.since, evaluated_at: DEGRADED.evaluated_at, clearing_since: "2026-10-16T07:56:00Z", loss: null, latency: { p50_ms: 140, runs: 15, baseline_ms: 64, trigger_ms: 128 } } };
  const d = buildPathsMatrix(r).paths[0]!.degraded!;
  assert.equal(d.clearingSince, Date.parse("2026-10-16T07:56:00Z"));
  assert.deepEqual(d.latency, { p50Ms: 140, runs: 15, baselineMs: 64, triggerMs: 128 });
  assert.equal(d.loss, undefined);
  assert.equal(readDegradation({ since: "x", evaluated_at: "y", latency: { p50_ms: Number.NaN, runs: 1, baseline_ms: 1, trigger_ms: 2 } })!.latency, undefined);
  assert.equal(readDegradation(null), undefined);
});

test("degraded: the three reasons are known codes with sentences, and never a pause", () => {
  for (const code of DEGRADED_REASONS) {
    assert.equal(reasonCode(code), code);
    assert.equal(isChosenUnknown(code), false);
  }
  for (const messages of [enFleet, zhFleet] as unknown as { fleet: { monitoring: { paths: { reason: Record<string, string>; reasonShort: Record<string, string>; state: Record<string, string> } } } }[]) {
    const paths = messages.fleet.monitoring.paths;
    for (const code of DEGRADED_REASONS) {
      assert.equal(typeof paths.reason[code], "string", `reason.${code}`);
      assert.equal(typeof paths.reasonShort[code], "string", `reasonShort.${code}`);
    }
    assert.equal(typeof paths.state.degraded, "string");
  }
});

test("degraded: the query finds it by state, and reach counts it apart from up and down", () => {
  const m = buildPathsMatrix(m3());
  const schema = pathsQuerySchema({ reasonText: (r) => r ?? "" });
  const run = (text: string) => applyQuery(m.paths, compileQuery(text, schema).query).map((p) => p.key);
  assert.deepEqual(run("state:degraded"), ["sh~hk"]);
  assert.deepEqual(run("state:slow"), ["sh~hk"]);
  assert.deepEqual(run("reason:degraded_loss"), ["sh~hk"]);
  const reach = reachBySource(m)[0]!;
  assert.equal(reach.degraded, 1);
  assert.equal(reach.up, 1);
  assert.equal(reachQuery(reach, "degraded"), "source:=cd-hs-sh state:degraded");
});

function threeSources(): PathsResponse {
  const p = (source: string, target: string, state: string, over: Partial<PathsResponse["paths"][number]> = {}) => ({ source, target_node: target, target: "203.0.113.9:443", monitor_id: `mon_lat_${target}`, managed: true, method: "tcp", state, samples: 60, expected: 60, ...over });
  const deg = (kind: "loss" | "latency") => ({ reason: `degraded_${kind}`, degraded: kind === "loss" ? DEGRADED : { ...DEGRADED, loss: undefined, latency: { p50_ms: 150, runs: 15, baseline_ms: 60, trigger_ms: 120 } } });
  return {
    window: "1h",
    degraded_at: "2026-10-16T07:59:30Z",
    sources: [
      { node_id: "sh", name: "cd-hs-sh" },
      { node_id: "volc", name: "volc-sh" },
      { node_id: "hr", name: "mkcloud-hr" },
    ],
    targets: ["dmit4", "a", "b", "c", "d", "tyo", "lon", "par"].map((id) => ({ node_id: id, name: id })),
    paths: [
      // DMIT-4 down from all three: the target.
      p("sh", "dmit4", "down"),
      p("volc", "dmit4", "down"),
      p("hr", "dmit4", "down"),
      // volc-sh fails four targets the others reach, and reports on five: its network.
      ...["a", "b", "c", "d"].flatMap((t) => [p("volc", t, "down"), p("sh", t, "up"), p("hr", t, "up")]),
      p("volc", "tyo", "up"),
      // tyo degraded from cd-hs-sh alone: this path, quality family.
      p("sh", "tyo", "degraded", deg("latency")),
      p("hr", "tyo", "up"),
      // lon degraded from every fresh source; mkcloud's path is stale.
      p("sh", "lon", "degraded", deg("loss")),
      p("volc", "lon", "degraded", deg("loss")),
      p("hr", "lon", "unknown", { reason: "results_stopped" }),
      p("sh", "par", "unknown", { reason: "path_paused" }),
    ],
  };
}

test("attention with triangulation: down by target, down by source, degraded by target, then unknown and paused", () => {
  const items = pathAttention(buildPathsMatrix(threeSources()));
  const shape = items.map((i) => {
    switch (i.kind) {
      case "down":
      case "degraded":
        return `${i.kind}:${i.rowKey}:${i.paths.length}:${i.verdict?.kind}`;
      case "downSource":
      case "degradedSource":
        return `${i.kind}:${i.source}:${i.paths.length}:${i.verdict.kind}`;
      case "unknown":
        return `unknown:${i.reason}`;
      default:
        return i.kind;
    }
  });
  assert.deepEqual(shape, ["down:dmit4:3:target", "downSource:volc:4:source", "degraded:lon:2:target", "degraded:tyo:1:path", "unknown:results_stopped", "paused"]);
  const source = items[1]!;
  assert.equal(attentionQuery(source), "state:down source:=volc-sh target:=a,b,c,d");
  // Show lists exactly the item's paths: volc-sh's down path to dmit4 carries the target verdict and is not in it.
  const m = buildPathsMatrix(threeSources());
  const schema = pathsQuerySchema({ reasonText: (r) => r ?? "" });
  const shown = applyQuery(m.paths, compileQuery(attentionQuery(source), schema).query).map((p) => p.key);
  assert.deepEqual(shown.sort(), source.paths.map((p) => p.key).sort());
  assert.equal(shown.length, 4);
  assert.deepEqual(source.kind === "downSource" && source.verdict.evidence, { kind: "source", source: "volc-sh", bad: 5, fresh: 7, elsewhere: 4 });
  assert.equal(attentionQuery(items[2]!), "state:degraded target:=lon");
  const tyo = items[3]!;
  assert.deepEqual(tyo.kind === "degraded" && tyo.verdict?.evidence, { kind: "path", target: "tyo", others: 2 });
});

test("attention: with one source every down and degraded item reads this path", () => {
  const r = m3();
  const items = pathAttention(buildPathsMatrix(r));
  const judged = items.filter((i) => i.kind === "down" || i.kind === "degraded");
  assert.deepEqual(judged.map((i) => i.kind), ["down", "degraded"]);
  for (const i of judged) assert.equal((i as { verdict?: { kind: string } }).verdict?.kind, "path");
});

test("a source item's Show quotes names the query would split, and lists each target once", () => {
  assert.equal(quoteQueryValue("[cd]-linode-sgp"), "[cd]-linode-sgp");
  assert.equal(quoteQueryValue("hk, sg"), '"hk, sg"', "a comma would separate two values");
  const r = threeSources();
  r.targets = r.targets!.map((t) => (t.node_id === "a" ? { ...t, name: "[cd] hk mini" } : t.node_id === "b" ? { ...t, name: "edge,sg" } : t));
  const m = buildPathsMatrix(r);
  const item = pathAttention(m).find((i) => i.kind === "downSource")!;
  const q = attentionQuery(item);
  assert.equal(q, 'state:down source:=volc-sh target:="[cd] hk mini",c,d,"edge,sg"', "in the item's target order");
  const shown = applyQuery(m.paths, compileQuery(q, pathsQuerySchema({ reasonText: (x) => x ?? "" })).query).map((p) => p.key);
  assert.deepEqual(shown.sort(), item.paths.map((p) => p.key).sort());
});

test("a degraded target's item is led by the path furthest over its trigger, on either arm", () => {
  const r = threeSources();
  // lon: cd-hs-sh's loss is 1.5 times its trigger; volc-sh's latency is 3 times its trigger, so volc-sh leads.
  r.paths = r.paths.map((p) => {
    if (p.target_node !== "lon") return p;
    if (p.source === "sh") return { ...p, reason: "degraded_loss", degraded: { ...DEGRADED, loss: { value: 0.03, baseline: 0.004, trigger: 0.02, sent: 290, lost: 9 } } };
    if (p.source === "volc") return { ...p, reason: "degraded_latency", degraded: { since: DEGRADED.since, evaluated_at: DEGRADED.evaluated_at, latency: { p50_ms: 360, runs: 15, baseline_ms: 60, trigger_ms: 120 } } };
    return p;
  });
  const lon = pathAttention(buildPathsMatrix(r)).find((i) => i.kind === "degraded" && i.rowKey === "lon")!;
  assert.deepEqual(lon.paths.map((p) => p.source), ["volc", "sh"], "the worse arm leads, whichever arm it is");
  // A path that held both arms is ranked by the worse of the two, not the milder.
  r.paths = r.paths.map((p) => (p.target_node === "lon" && p.source === "sh" ? { ...p, reason: "degraded_loss_latency", degraded: { ...DEGRADED, loss: { value: 0.03, baseline: 0.004, trigger: 0.02, sent: 290, lost: 9 }, latency: { p50_ms: 480, runs: 15, baseline_ms: 60, trigger_ms: 120 } } } : p));
  const again = pathAttention(buildPathsMatrix(r)).find((i) => i.kind === "degraded" && i.rowKey === "lon")!;
  assert.deepEqual(again.paths.map((p) => p.source), ["sh", "volc"], "4 times over on latency beats 3 times");
});

test("formatShare: one decimal under ten percent, whole from ten, never negative", () => {
  assert.equal(formatShare(0.042), "4.2%");
  assert.equal(formatShare(0.004), "0.4%");
  assert.equal(formatShare(0.072), "7.2%", "one decimal up to ten percent");
  assert.equal(formatShare(0.02), "2%", "a trailing .0 is dropped");
  assert.equal(formatShare(0.0999), "10%", "9.99 rounds to one decimal as 10.0, printed whole");
  assert.equal(formatShare(0.1), "10%");
  assert.equal(formatShare(0.156), "16%");
  assert.equal(formatShare(0), "0%");
  assert.equal(formatShare(-0.01), "0%");
  assert.equal(formatShare(undefined), "");
  assert.equal(formatShare(Number.NaN), "");
});

test("a clearing path leaves ten minutes after the condition stopped (lattice-sdk PathDegradedLeaveAfter)", () => {
  // The server sends clearing_since, not the leave time; the console adds the SDK's constant, so the test pins it.
  assert.equal(DEGRADED_LEAVE_AFTER_MS, 10 * 60 * 1000);
});

test("loss tone: a down path's loss is red, a degraded path's amber, an up path's the plain ink, never a saturated colour of its own", () => {
  assert.equal(lossTone("down"), "destructive");
  assert.equal(lossTone("degraded"), "warning");
  assert.equal(lossTone("up"), "ink");
  assert.equal(lossTone(undefined), "ink", "no path read: a plain figure");
  assert.equal(lossTone("unknown"), "muted", "what an unknown path holds is not an outage");
  assert.equal(lossTone("paused"), "muted");
  // Every display state has a tone, and the only saturated ones are the two states that own them (D13).
  for (const state of PATH_STATES) {
    const tone = lossTone(state);
    const saturated = tone === "destructive" || tone === "warning";
    assert.equal(saturated, state === "down" || state === "degraded", `${state} reads ${tone}`);
  }
  // The bars fill with the state tokens; an up path's with the foreground, its figure in the row's own ink.
  assert.deepEqual(LOSS_FILL, { destructive: "--destructive", warning: "--warning", ink: "--foreground", muted: "--muted-foreground" });
  assert.deepEqual(LOSS_TEXT, { destructive: "text-destructive", warning: "text-warning-text", ink: "", muted: "text-muted-foreground" });
  // A lossy up path from a server (3 percent over the hour, below any trigger) is drawn in the ink, not red.
  const m = buildPathsMatrix({
    window: "1h",
    degraded_at: "2026-09-14T09:47:00Z",
    sources: [{ node_id: "sh", name: "sh" }],
    targets: [{ node_id: "jp", name: "jp" }],
    paths: [{ source: "sh", target_node: "jp", target: "203.0.113.3:443", monitor_id: "mon_lat_jp", managed: true, method: "tcp", state: "up", reason: "", p50_ms: 40, p95_ms: 41, jitter_ms: 0, loss: 0.03, samples: 60, expected: 60, prev: null, last_at: "2026-09-14T09:47:00Z" }],
  } as PathsResponse);
  assert.equal(lossTone(m.paths[0]!.state), "ink");
});

test("attention: a target whose beacon needs a change plan is one line with its waiting paths, after offline sources and before other unknowns", () => {
  const cell = (source: string, target: string, state: string, reason = "") => ({
    source, target_node: target, target: `${target}:50231`, monitor_id: `mon_latb_${target}`, managed: true, method: "beacon", state, reason,
    p50_ms: null, p95_ms: null, jitter_ms: null, loss: null, samples: 0, expected: 60, prev: null, last_at: null,
  });
  const response = {
    window: "1h",
    degraded_at: "2026-09-14T09:47:00Z",
    sources: [{ node_id: "hk", name: "hk-edge" }, { node_id: "sh", name: "cd-hs-sh" }, { node_id: "fra", name: "fra-2" }],
    targets: [{ node_id: "jp", name: "tyo-3" }, { node_id: "hel", name: "hetzner-hel" }, { node_id: "sg", name: "sg-1" }],
    paths: [
      cell("hk", "jp", "unknown", "firewall_pending"),
      cell("sh", "jp", "unknown", "firewall_pending"),
      // A waiting path whose target the server does not list (a server before replans): it stays with its reason.
      cell("hk", "sg", "unknown", "beacon_source_pending"),
      cell("fra", "jp", "unknown", "agent_offline"),
    ],
    beacon_replans: [
      { node_id: "jp", name: "tyo-3", reason: "firewall_pending", added: ["hk", "sh"], removed: [], request: { node_id: "jp", action: "change" } },
      // NetGuard still admits a source that left: no path waits, the plan only narrows the allow set.
      { node_id: "hel", name: "hetzner-hel", reason: "firewall_pending", added: [], removed: ["fra"], pending_approval_id: "apr_7", request: { node_id: "hel", action: "change" } },
    ],
  } as unknown as PathsResponse;
  const m = buildPathsMatrix(response);
  assert.deepEqual([...m.replans.keys()], ["jp", "hel"]);
  const items = pathAttention(m);
  assert.deepEqual(
    items.map((i) => [i.kind, i.paths.map((p) => p.key)]),
    [
      ["offline", ["fra~jp"]],
      // By target, then source name: cd-hs-sh before hk-edge.
      ["replan", ["sh~jp", "hk~jp"]],
      ["replan", []],
      ["unknown", ["hk~sg"]],
    ],
  );
  const [, jp, hel] = items;
  assert.ok(jp?.kind === "replan" && hel?.kind === "replan");
  assert.equal(jp.targetName, "tyo-3");
  assert.deepEqual(jp.replan.request, { node_id: "jp", action: "change" });
  assert.equal(hel.replan.pendingApprovalId, "apr_7");
  // Its query still finds exactly its paths, should a caller want them listed.
  const schema = pathsQuerySchema({ reasonText: (r) => r ?? "" });
  const compiled = compileQuery(attentionQuery(jp), schema);
  assert.ok(compiled.ok);
  assert.deepEqual(applyQuery(m.paths, compiled.query).map((p) => p.key).sort(), ["hk~jp", "sh~jp"]);
  // A server that sends no list, and one that sends an empty list, offer no plan.
  assert.equal(buildPathsMatrix({ ...response, beacon_replans: undefined }).replans.size, 0);
  assert.equal(pathAttention(buildPathsMatrix({ ...response, beacon_replans: [] })).filter((i) => i.kind === "replan").length, 0);
});
