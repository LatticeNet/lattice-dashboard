import assert from "node:assert/strict";
import { test } from "node:test";

import type { LatencyProbePlan, LatencyRollups, PathsResponse } from "@/lib/api/types";
import { applyQuery, compileQuery } from "@/lib/query/engine";

import {
  attentionQuery,
  availability,
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

test("states: anything but up or down is unknown, never up", () => {
  assert.equal(normalizeState("up"), "up");
  assert.equal(normalizeState("down"), "down");
  assert.equal(normalizeState("degraded"), "unknown");
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
  assert.deepEqual(m.counts, { paths: 7, up: 3, down: 1, unknown: 2, paused: 1 }, "a pause is counted apart from unknown");
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
  assert.equal(attentionQuery(items[0]!), 'state:down target:xuezhang-jp-nat');
  assert.equal(attentionQuery(items[2]!), "state:unknown reason:udp_only");
  assert.equal(attentionQuery(items[4]!), "state:paused");
  assert.equal(attentionQuery({ kind: "down", rowKey: "x", targetName: "[cd] hk mini", paths: [], worstLoss: 1, measuredBy: 1 }), 'state:down target:"[cd] hk mini"');
});

test("attention: an offline agent is one line for its source, not one per path", () => {
  const r = response();
  r.sources.push({ node_id: "hr", name: "mkcloud hr" });
  for (const target of ["hk", "fsn", "la"]) r.paths.push({ source: "hr", target_node: target, target: "", monitor_id: `mon_lat_${target}`, managed: true, method: "tcp", state: "unknown", reason: "agent_offline", samples: 0, expected: 60 });
  const items = pathAttention(buildPathsMatrix(r));
  const offline = items.find((i) => i.kind === "offline")!;
  assert.equal(offline.kind === "offline" && offline.sourceName, "mkcloud hr");
  assert.equal(offline.paths.length, 3);
  assert.equal(attentionQuery(offline), 'state:unknown source:"mkcloud hr"');
  assert.ok(items.findIndex((i) => i.kind === "offline") < items.findIndex((i) => i.kind === "unknown"), "offline sources come before other unknowns");
});

test("reach: each source's paths by state", () => {
  const reach = reachBySource(buildPathsMatrix(response()));
  assert.deepEqual(reach, [{ source: "sh", name: "cd-hs-sh", up: 2, down: 1, unknown: 2, paused: 1, total: 6 }], "the operator check to a URL is not reach; a pause is not unknown");
  assert.equal(reachQuery(reach[0]!, "down"), "source:cd-hs-sh state:down");
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
