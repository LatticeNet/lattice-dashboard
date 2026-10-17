/**
 * The console's models over what a design 29 M3 server really sends: the
 * golden responses lattice-server captured from its handlers (see
 * src/testing/m3Golden.ts for the commit and how they are made). Hand-written
 * fixtures once hid a Go zero time the server sent; these tests read the
 * server's own bytes through the API types and assert concrete values, so a
 * shape or a meaning the console reads differently from the server fails here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PathSeriesResponse } from "@/lib/api/types";
import { applyQuery, compileQuery } from "@/lib/query/engine";
import {
  GOLDEN_CATALOGUE_PATH_ENTRIES,
  GOLDEN_MONITORS,
  GOLDEN_NOW,
  GOLDEN_PATHS_1H,
  GOLDEN_PATHS_7D,
  GOLDEN_PATH_SET,
  GOLDEN_SERIES,
  GOLDEN_SERIES_QUERY,
} from "@/testing/m3Golden";

import { buildUpdate, checkGroup, checkSourceSummary, draftFromMonitor, draftProblems, withPathVerdict } from "../checksModel.ts";
import { degradedEdit, degradedSummary, effectiveAlert } from "../degradedRuleModel.ts";
import { draftFromConfig, draftToConfig } from "../latencyModel.ts";
import { monitorHealth } from "../monitorHealthModel.ts";
import {
  baselineGuides,
  baselinePending,
  chartCeilingMs,
  chartColumns,
  laneLayout,
  methodMarkers,
  methodStarts,
  seriesFromResponse,
  seriesStats,
  stepInProgress,
} from "../pathSeriesModel.ts";
import {
  attentionQuery,
  availability,
  buildPathsMatrix,
  cellKey,
  displayState,
  lossTone,
  pathAttention,
  pathsQuerySchema,
  reachBySource,
  reachQuery,
  reasonCode,
  type PathsMatrix,
} from "../pathsModel.ts";
import { buildTopology, edgeStyle, rowMarks, rowSummary } from "../topologyModel.ts";
import { soleReporter, triangulate, verdictFor } from "../triangulationModel.ts";
import { FALLBACK_CATALOGUE, NOTIFY_ICON_NAMES, notifyIconName, notifyTone, presentDelivery } from "../../platform/notifyCatalogueModel.ts";

const at = (iso: string) => Date.parse(iso);
const NOW = at(GOLDEN_NOW);
const checkNames = new Map(GOLDEN_MONITORS.map((m) => [m.id, m.name]));
/** The matrix as Monitoring builds it: checks named from the monitors list, the control plane by the console's label. */
const matrixOf = (response = GOLDEN_PATHS_1H): PathsMatrix => buildPathsMatrix(response, { checkName: (id) => checkNames.get(id), controlPlane: "control plane" });
const pathOf = (m: PathsMatrix, key: string) => {
  const path = m.paths.find((p) => p.key === key);
  assert.ok(path, `path ${key}`);
  return path;
};

/* ---- The matrix ---- */

test("golden matrix: the 1h answer reads into the sources, rows, cells and states the server judged", () => {
  const m = matrixOf();
  assert.equal(m.window, "1h");
  assert.equal(m.judgesDegraded, true, "an M3 server sends degraded_at");
  assert.equal(m.degradedAt, at("2026-09-14T09:47:00Z"));
  assert.equal(m.observedAt, NOW);
  // The server lists the control plane as a source named "Control plane"; the console names it in its own words.
  assert.deepEqual(m.sources, [
    { nodeId: "", name: "control plane" },
    { nodeId: "node-sh", name: "cd-hs-sh" },
    { nodeId: "node-fra", name: "fra-2" },
    { nodeId: "node-hk", name: "hk-edge" },
  ]);
  assert.deepEqual(
    m.rows.map((r) => [r.key, r.kind, r.name, r.group]),
    [
      ["node-fra", "node", "fra-2", "europe"],
      ["node-hk", "node", "hk-edge", "eastAsia"],
      ["node-jp", "node", "tyo-3", "eastAsia"],
      ["@mon-cert", "check", "lattice.example.net certificate", "checks"],
      ["@mon-ping-jp", "check", "Ping tyo-3", "checks"],
      ["@mon-web", "check", "tyo-3 web", "checks"],
    ],
  );
  assert.deepEqual(m.counts, { paths: 12, up: 6, degraded: 4, down: 1, unknown: 1, paused: 0 });
  // Every cell, as the server judged it: [row, source, state, reason].
  const cells = [
    ["node-fra", "node-hk", "up", undefined],
    ["node-fra", "node-sh", "up", undefined],
    ["node-hk", "node-fra", "up", undefined],
    ["node-hk", "node-sh", "down", undefined],
    ["node-jp", "node-fra", "degraded", "degraded_latency"],
    ["node-jp", "node-hk", "degraded", "degraded_latency"],
    ["node-jp", "node-sh", "degraded", "degraded_loss"],
    ["@mon-cert", "", "up", undefined],
    ["@mon-ping-jp", "node-fra", "unknown", "icmp_not_permitted"],
    ["@mon-ping-jp", "node-hk", "up", undefined],
    ["@mon-web", "node-hk", "up", undefined],
    ["@mon-web", "node-sh", "degraded", "degraded_loss_latency"],
  ] as const;
  assert.equal(m.cells.size, cells.length);
  for (const [row, source, state, reason] of cells) {
    const cell = m.cells.get(cellKey(row, source));
    assert.ok(cell, `cell ${row}|${source}`);
    assert.equal(cell.state, state, `${row}|${source} state`);
    assert.equal(displayState(cell), state, `${row}|${source} display`);
    // An empty reason (up and down) reads as none; degraded's reasons are codes the console has sentences for.
    assert.equal(cell.reason, reason, `${row}|${source} reason`);
    if (reason) assert.equal(reasonCode(reason), reason);
    assert.equal(cell.degraded !== undefined, state === "degraded", `${row}|${source} carries evidence only while degraded`);
  }
});

test("golden matrix: degraded evidence, the clearing time and unmeasured figures read as the server stored them", () => {
  const m = matrixOf();
  // fra-2 to tyo-3 is clearing: the condition went away at 09:44, the evidence is from 09:43.
  assert.deepEqual(pathOf(m, "node-fra~node-jp").degraded, {
    since: at("2026-09-14T09:35:00Z"),
    evaluatedAt: at("2026-09-14T09:43:00Z"),
    clearingSince: at("2026-09-14T09:44:00Z"),
    latency: { p50Ms: 140, runs: 16, baselineMs: 40, triggerMs: 100 },
  });
  assert.deepEqual(pathOf(m, "node-hk~node-jp").degraded, {
    since: at("2026-09-14T09:35:00Z"),
    evaluatedAt: at("2026-09-14T09:47:00Z"),
    clearingSince: undefined,
    latency: { p50Ms: 140, runs: 16, baselineMs: 52, triggerMs: 130 },
  });
  // The path set's own loss threshold (3 percent) is the trigger; the 7-day loss is 0.03 percent.
  assert.deepEqual(pathOf(m, "node-sh~node-jp").degraded, {
    since: at("2026-09-14T09:35:00Z"),
    evaluatedAt: at("2026-09-14T09:47:00Z"),
    clearingSince: undefined,
    loss: { value: 0.082, baseline: 0.0003, trigger: 0.03, sent: 61, lost: 5 },
  });
  // The operator check's own thresholds: 5 percent, and 50 ms over the 7-day median (40 + 50 beats 2 x 40).
  const web = pathOf(m, "node-sh~@mon-web");
  assert.equal(web.checkName, "tyo-3 web");
  assert.deepEqual(web.degraded?.loss, { value: 0.082, baseline: 0.0003, trigger: 0.05, sent: 61, lost: 5 });
  assert.deepEqual(web.degraded?.latency, { p50Ms: 140, runs: 16, baselineMs: 40, triggerMs: 90 });

  // A path that measured nothing: the server's nulls read as absent, never as zero.
  const icmp = pathOf(m, "node-fra~@mon-ping-jp");
  assert.equal(icmp.method, "icmp");
  assert.equal(icmp.targetNode, "node-jp");
  assert.equal(icmp.targetNodeName, "tyo-3");
  assert.equal(icmp.p50Ms, undefined);
  assert.equal(icmp.p95Ms, undefined);
  assert.equal(icmp.jitterMs, undefined);
  assert.equal(icmp.loss, undefined);
  assert.equal(icmp.prev, undefined);
  assert.equal(icmp.lastAt, undefined);
  assert.equal(icmp.samples, 0);
  assert.equal(icmp.expected, 60);

  // The certificate check runs on the control plane: no source id, keyed `_`, named by the console.
  const cert = pathOf(m, "_~@mon-cert");
  assert.equal(cert.source, "");
  assert.equal(cert.sourceName, "control plane");
  assert.equal(cert.method, "tls");
  assert.equal(cert.lastAt, at("2026-09-14T09:15:00Z"));

  // The hour is its 60 whole minutes before the one in progress: a path that ran every minute heard 60 of 60.
  const full = pathOf(m, "node-hk~node-fra");
  assert.deepEqual([full.samples, full.expected], [60, 60]);
  assert.equal(availability(full), 1);
  for (const p of m.paths.filter((x) => x.samples > 0 && x.source !== "")) assert.equal(p.samples, p.expected, `${p.key} heard every run it expected`);
  const down = pathOf(m, "node-sh~node-hk");
  assert.equal(down.state, "down");
  assert.equal(down.loss, 0.0333);
  assert.equal(down.p50Ms, 38);
  assert.deepEqual(down.prev, { p50Ms: 38, loss: 0 });
  assert.equal(down.samples, 60);
  assert.equal(down.expected, 60);
  assert.equal(availability(down), 1 - 0.0333);
  assert.equal(pathOf(m, "node-hk~node-fra").prev?.p50Ms, 158.8);

  // Loss takes the path's state tone: red on the down path, amber on the lossy degraded ones, never red on an up path.
  assert.equal(lossTone(displayState(down)), "destructive");
  assert.equal(lossTone(displayState(pathOf(m, "node-sh~node-jp"))), "warning");
  assert.equal(lossTone(displayState(pathOf(m, "node-sh~@mon-web"))), "warning");
  for (const p of m.paths.filter((x) => x.state === "up")) assert.equal(lossTone(displayState(p)), "ink", `${p.key} is up`);
});

test("golden matrix: the 7d window judges the same states with the same evidence; only its figures differ", () => {
  const hour = matrixOf();
  const week = matrixOf(GOLDEN_PATHS_7D);
  assert.equal(week.window, "7d");
  assert.equal(week.degradedAt, at("2026-09-14T09:47:00Z"));
  assert.deepEqual(week.counts, hour.counts);
  assert.deepEqual(
    week.paths.map((p) => p.key),
    hour.paths.map((p) => p.key),
  );
  for (const path of week.paths) {
    const same = pathOf(hour, path.key);
    assert.equal(path.state, same.state, `${path.key}: degraded is a state for now, not for the window`);
    assert.equal(path.reason, same.reason);
    assert.deepEqual(path.degraded, same.degraded);
  }
  // The week's median is the usual 40 ms although the path is degraded on its last 15 minutes.
  assert.equal(pathOf(week, "node-fra~node-jp").p50Ms, 40);
  assert.equal(pathOf(week, "node-fra~node-jp").p95Ms, 41.3);
  // The week is its 168 whole hours before the one in progress: 10080 one-minute runs of 10080.
  assert.equal(pathOf(week, "node-sh~node-hk").loss, 0);
  assert.equal(pathOf(week, "node-sh~node-hk").samples, 10080);
  assert.equal(pathOf(week, "node-sh~node-hk").expected, 10080);
  assert.equal(pathOf(week, "node-fra~@mon-ping-jp").expected, 10080, "a path that measured nothing still expected the week's runs");
  // The hourly certificate check's history starts inside the oldest hour, and its newest run sits in the hour in progress.
  assert.deepEqual([pathOf(week, "_~@mon-cert").samples, pathOf(week, "_~@mon-cert").expected], [167, 168]);
  assert.equal(pathOf(week, "_~@mon-cert").prev, undefined, "the week before held no certificate run");
});

/* ---- Triangulation and the Overview ---- */

test("golden triangulation: tyo-3 is placed on the target, cd-hs-sh's network on its check, hk-edge's outage on the path", () => {
  const m = matrixOf();
  const tri = triangulate(m);
  assert.deepEqual([...tri.reach.keys()], ["node-sh~node-hk"], "reach judges the one down path");
  assert.deepEqual(tri.reach.get("node-sh~node-hk"), { kind: "path", family: "reach", evidence: { kind: "path", target: "hk-edge", others: 1 } });
  const target = { kind: "target", family: "quality", evidence: { kind: "target", target: "tyo-3", sources: ["cd-hs-sh", "fra-2", "hk-edge"] } };
  const network = { kind: "source", family: "quality", evidence: { kind: "source", source: "cd-hs-sh", bad: 3, fresh: 4, elsewhere: 2 } };
  assert.deepEqual(Object.fromEntries(tri.quality), {
    "node-sh~node-hk": network,
    "node-fra~node-jp": target,
    "node-hk~node-jp": target,
    "node-sh~node-jp": target,
    "node-sh~@mon-web": network,
  });
  // The family follows the state: a down path's verdict is reach's, a degraded path's quality's.
  assert.equal(verdictFor(tri, pathOf(m, "node-sh~node-hk"))?.kind, "path");
  assert.equal(verdictFor(tri, pathOf(m, "node-sh~@mon-web"))?.kind, "source");
  assert.equal(verdictFor(tri, pathOf(m, "node-fra~@mon-ping-jp")), undefined, "an unknown path is never judged");
  assert.equal(verdictFor(tri, pathOf(m, "_~@mon-cert")), undefined);
  // Three sources report: no verdict rests on a single one.
  assert.equal(soleReporter(m.paths.map((p) => verdictFor(tri, p))), undefined);
});

test("golden attention: down, degraded by target, degraded by source, then the unknown reason; each Show finds exactly its paths", () => {
  const m = matrixOf();
  const items = pathAttention(m);
  assert.deepEqual(
    items.map((i) => [i.kind, i.paths.map((p) => p.key)]),
    [
      ["down", ["node-sh~node-hk"]],
      // The path furthest over its trigger leads: loss 8.2% of 3% before 140 ms of 100 ms and of 130 ms.
      ["degraded", ["node-sh~node-jp", "node-fra~node-jp", "node-hk~node-jp"]],
      ["degradedSource", ["node-sh~@mon-web"]],
      ["unknown", ["node-fra~@mon-ping-jp"]],
    ],
  );
  const [down, degraded, bySource, unknown] = items;
  assert.ok(down?.kind === "down" && degraded?.kind === "degraded" && bySource?.kind === "degradedSource" && unknown?.kind === "unknown");
  assert.equal(down.measuredBy, 2);
  assert.equal(down.worstLoss, 0.0333);
  assert.equal(down.verdict?.kind, "path");
  assert.equal(degraded.measuredBy, 3);
  assert.equal(degraded.verdict?.kind, "target");
  assert.equal(bySource.sourceName, "cd-hs-sh");
  assert.equal(bySource.verdict.kind, "source");
  assert.equal(unknown.reason, "icmp_not_permitted");
  const schema = pathsQuerySchema({ reasonText: (r) => r ?? "" });
  const expected = [
    "state:down target:=hk-edge",
    // A substring would also find the check "tyo-3 web", whose path from cd-hs-sh is degraded too.
    "state:degraded target:=tyo-3",
    'state:degraded source:=cd-hs-sh target:="tyo-3 web"',
    "state:unknown reason:=icmp_not_permitted",
  ];
  items.forEach((item, i) => {
    const query = attentionQuery(item);
    assert.equal(query, expected[i]);
    const compiled = compileQuery(query, schema);
    assert.ok(compiled.ok, `${query} compiles`);
    assert.deepEqual(applyQuery(m.paths, compiled.query).map((p) => p.key).sort(), item.paths.map((p) => p.key).sort(), `${query} lists exactly the item's paths`);
  });
  // Reach into the fleet: the certificate check is not reach, so the control plane has no line.
  const reach = reachBySource(m).filter((r) => r.total > 0);
  assert.deepEqual(
    reach.map((r) => [r.name, r.up, r.degraded, r.down, r.unknown, r.total]),
    [
      ["cd-hs-sh", 1, 1, 1, 0, 3],
      ["fra-2", 1, 1, 0, 0, 2],
      ["hk-edge", 1, 1, 0, 0, 2],
    ],
  );
  assert.equal(reachQuery(reach[0]!, "degraded"), "source:=cd-hs-sh state:degraded");
});

/* ---- The series ---- */

test("golden series: buckets, the 7-day baseline and the previous hour read as the chart draws them", () => {
  const s = seriesFromResponse(GOLDEN_SERIES);
  assert.equal(s.stepSec, 60);
  assert.equal(s.from, at("2026-09-14T08:48:00Z") / 1000);
  assert.equal(s.to, NOW / 1000);
  // An hour at a one-minute step holds 60 steps, the last of them the one in progress at now.
  assert.equal(s.points.length, 60);
  assert.equal(s.points[0]!.t, s.from);
  assert.equal(s.points.at(-1)!.t, s.to);
  assert.equal(s.points.filter((p) => p.missing).length, 0, "no step is a gap");
  // The step in progress expects the run it has heard, never fewer: 1 of 1, drawn, not hatched.
  assert.deepEqual([s.points.at(-1)!.n, s.points.at(-1)!.expected, s.points.at(-1)!.missing], [1, 1, false]);
  assert.deepEqual(
    s.points.flatMap((p, i) => (stepInProgress(s, p) ? [i] : [])),
    [59],
    "the readout and the table mark the newest step as in progress",
  );
  assert.ok(s.points.every((p) => p.n === p.expected), "every step heard what it expected");
  assert.ok(s.points.every((p) => p.p50Ms === 140 && p.loss === 0 && p.sent === 1 && p.lost === 0));
  assert.deepEqual(methodStarts(s), [{ t: s.from, method: "tcp" }]);
  assert.deepEqual(methodMarkers(s), []);

  assert.deepEqual(s.baseline, {
    from: at("2026-09-07T09:00:00Z") / 1000,
    to: at("2026-09-14T09:00:00Z") / 1000,
    hours: 168,
    ready: true,
    p50Ms: 52,
    loss: 0,
    triggerP50Ms: 130,
    triggerLoss: 0.03,
    // The path set's thresholds with the defaults filled in, as the server sends them.
    rule: { lossPercent: 3, lossFactor: 2, latencyFactor: 2.5, latencyMarginMs: 30 },
  });
  assert.deepEqual(baselineGuides(s.baseline), [
    { kind: "median", ms: 52 },
    { kind: "trigger", ms: 130 },
  ]);
  assert.equal(baselinePending(s.baseline), undefined);
  // One baseline, two reads: the matrix's evidence for this path says the same 52 ms and 130 ms.
  const evidence = pathOf(matrixOf(), "node-hk~node-jp").degraded?.latency;
  assert.equal(GOLDEN_SERIES_QUERY.source, "node-hk");
  assert.equal(evidence?.baselineMs, s.baseline?.p50Ms);
  assert.equal(evidence?.triggerMs, s.baseline?.triggerP50Ms);

  assert.equal(s.previousOffsetSec, 3600);
  assert.equal(s.previous?.length, s.points.length, "one previous entry per bucket");
  assert.deepEqual(s.previous?.slice(0, 48), Array(48).fill(52));
  assert.deepEqual(s.previous?.slice(48), Array(12).fill(140));

  // The scale holds the series (140 ms) and so the trigger (130 ms); the comparison adds nothing higher.
  assert.equal(chartCeilingMs(s), 140);
  assert.equal(chartCeilingMs(s, true), 140);
  assert.ok(laneLayout(chartCeilingMs(s)).msMax >= 140);
  const [xs, floor, p50, p95, loss] = chartColumns(s.points);
  assert.equal(xs.length, 60);
  assert.ok(floor.every((v) => v === 140) && p50.every((v) => v === 140) && p95.every((v) => v === 140));
  assert.ok(loss.every((v) => v === null), "nothing was lost, so no loss bar");
  const stats = seriesStats(s.points);
  // The sheet's runs figure for the whole chart reads what the matrix says for the hour: 60 of 60.
  assert.deepEqual([stats.samples, stats.expected, stats.loss, stats.availability, stats.p50Ms, stats.p95Ms], [60, 60, 0, 1, 140, 140]);
  const cell = pathOf(matrixOf(), "node-hk~node-jp");
  assert.deepEqual([stats.samples, stats.expected], [cell.samples, cell.expected]);

  // The same read without compare=previous carries no previous period, and the chart draws none.
  const { previous: _previous, ...plain }: PathSeriesResponse = GOLDEN_SERIES;
  const bare = seriesFromResponse(plain);
  assert.equal(bare.previous, undefined);
  assert.deepEqual(bare.baseline, s.baseline);
});

/* ---- Checks and the path set ---- */

test("golden monitors: each check's state in the list, with its paths' verdict folded in", () => {
  const m = matrixOf();
  const health = (id: string) => {
    const mon = GOLDEN_MONITORS.find((x) => x.id === id)!;
    const paths = m.paths.filter((p) => p.monitorId === id);
    return withPathVerdict(monitorHealth(mon, mon.latest, NOW), paths, mon.latest);
  };
  assert.deepEqual(
    GOLDEN_MONITORS.map((mon) => [mon.id, checkGroup(mon)]),
    [
      ["mon-web", "operator"],
      ["mon-ping-jp", "operator"],
      ["mon-cert", "operator"],
      ["mon_lat_node-fra", "pathset"],
      ["mon_lat_node-hk", "pathset"],
      ["mon_lat_node-jp", "pathset"],
    ],
  );
  // The newest runs pass, but the control plane judges a path degraded: never a green up.
  assert.deepEqual(health("mon-web"), { kind: "degraded", degraded: 1, total: 2, latencyMs: 95.5, lastAt: NOW });
  assert.deepEqual(health("mon_lat_node-jp"), { kind: "degraded", degraded: 3, total: 3, latencyMs: (40 + 140 + 40) / 3, lastAt: NOW });
  assert.deepEqual(health("mon_lat_node-hk"), { kind: "failing", failing: 1, total: 2, lastAt: NOW });
  assert.deepEqual(health("mon_lat_node-fra"), { kind: "up", total: 2, latencyMs: 185, lastAt: NOW });
  assert.deepEqual(health("mon-ping-jp"), { kind: "up", total: 1, latencyMs: 50, lastAt: NOW });
  // An hourly certificate check heard 32 minutes ago is current.
  assert.deepEqual(health("mon-cert"), { kind: "up", total: 1, latencyMs: 85, lastAt: at("2026-09-14T09:15:00Z") });
  // fra-2's kernel refuses ICMP: its source is listed and counted as measuring nothing.
  const ping = GOLDEN_MONITORS.find((x) => x.id === "mon-ping-jp")!;
  assert.deepEqual(checkSourceSummary(ping, m.paths.filter((p) => p.monitorId === ping.id)), { ids: ["node-fra", "node-hk"], unmeasured: 1 });
});

test("golden monitors: the editor reads a check's policy and thresholds, and an untouched save sends neither", () => {
  const web = GOLDEN_MONITORS.find((x) => x.id === "mon-web")!;
  const draft = draftFromMonitor(web);
  assert.equal(draft.type, "tcp");
  assert.equal(draft.alert, "down_and_degraded");
  assert.equal(draft.alertAfter, 2);
  assert.deepEqual(draft.degraded, { lossPercent: 5, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 50 });
  assert.deepEqual(degradedSummary(draft.degraded), { lossPercent: 5, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 50 });
  assert.deepEqual(draft.nodeIds, ["node-hk", "node-sh"]);
  assert.deepEqual(draftProblems(draft, { m2a: true, m3: true }), []);
  assert.deepEqual(buildUpdate(web, draft, { m2a: true, m3: true }), { id: "mon-web", version: 1 });
  // One threshold changed: the rule is sent whole in its canonical form; a reset sends {}.
  assert.deepEqual(buildUpdate(web, { ...draft, degraded: { ...draft.degraded, lossPercent: 6 } }, { m2a: true, m3: true }).degraded, { loss_percent: 6, latency_margin_ms: 50 });
  assert.deepEqual(degradedEdit(web.degraded, { lossPercent: 2, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 30 }), {});

  // The certificate check pages on down only, and the editor refuses down and degraded on it.
  const cert = draftFromMonitor(GOLDEN_MONITORS.find((x) => x.id === "mon-cert")!);
  assert.equal(cert.type, "tls");
  assert.equal(cert.alert, "down");
  assert.equal(cert.thresholdDays, 14);
  assert.deepEqual(draftProblems({ ...cert, alert: "down_and_degraded" }, { m2a: true, m3: true }), ["alertTls"]);

  // A generated check carries the path set's effective policy, so the list says what the path set pages.
  const generated = GOLDEN_MONITORS.find((x) => x.id === "mon_lat_node-jp")!;
  assert.equal(generated.managed_by, "latency");
  assert.equal(generated.target_node, "node-jp");
  assert.equal(effectiveAlert(generated.alert, true), "down_and_degraded");
  assert.equal(generated.alert_after, 3);
  assert.equal(generated.degraded, undefined, "a generated check reads its thresholds from the path set");
  assert.equal(draftFromMonitor(generated).targetMode, "node");
});

test("golden path set: the editor reads its alert and thresholds, and a save sends them back unchanged", () => {
  const config = GOLDEN_PATH_SET.config;
  const draft = draftFromConfig(config);
  assert.equal(draft.alert, "down_and_degraded");
  assert.equal(draft.alertAfter, 3);
  assert.deepEqual(draft.degraded, { lossPercent: 3, lossFactor: 2, latencyFactor: 2.5, latencyMarginMs: 30 });
  assert.deepEqual(draft.sources, ["node-fra", "node-hk", "node-sh"]);
  assert.equal(draft.version, 1);
  const saved = draftToConfig(draft);
  assert.equal(saved.alert, config.alert);
  assert.equal(saved.alert_after, config.alert_after);
  assert.deepEqual(saved.degraded, config.degraded);
  assert.deepEqual(saved.sources, config.sources);
  assert.equal(saved.version, config.version);
  assert.equal(GOLDEN_PATH_SET.default_source_name, "cd-hs-sh");
});

/* ---- Topology ---- */

test("golden topology: fans per source in the path set's order, edges in their path's state, a degraded check edge in warning", () => {
  const m = matrixOf();
  const topo = buildTopology({ plan: GOLDEN_PATH_SET, matrix: m, monitors: GOLDEN_MONITORS, window: "1h", layer: "all", now: NOW });
  assert.deepEqual(topo.drawnSourceIds, ["node-fra", "node-hk", "node-sh"]);
  assert.deepEqual(topo.sources.map((s) => s.name), ["fra-2", "hk-edge", "cd-hs-sh"]);
  assert.deepEqual(
    topo.sourceChoices.map((c) => [c.node.id, c.reach.up, c.reach.degraded, c.reach.down, c.reach.total]),
    [
      ["node-fra", 1, 1, 0, 2],
      ["node-hk", 1, 1, 0, 2],
      ["node-sh", 1, 1, 1, 3],
    ],
  );
  assert.equal(topo.counts.paths, 7);
  assert.equal(topo.counts.down, 1);
  assert.equal(topo.counts.degraded, 3);
  assert.equal(topo.counts.unknown, 0);
  const probes = topo.edges.filter((e) => e.kind === "probe").map((e) => [e.id, e.state, edgeStyle(e).color]);
  assert.deepEqual(probes, [
    ["probe:node-hk~node-fra", "up", "--success"],
    ["probe:node-sh~node-fra", "up", "--success"],
    ["probe:node-fra~node-hk", "up", "--success"],
    ["probe:node-sh~node-hk", "down", "--destructive"],
    ["probe:node-fra~node-jp", "degraded", "--warning"],
    ["probe:node-hk~node-jp", "degraded", "--warning"],
    ["probe:node-sh~node-jp", "degraded", "--warning"],
  ]);
  assert.deepEqual(rowMarks(topo, "node-jp"), [
    { source: "node-fra", state: "degraded" },
    { source: "node-hk", state: "degraded" },
    { source: "node-sh", state: "degraded" },
  ]);
  assert.deepEqual(rowSummary(topo, "node-hk"), { state: "down", n: 1, of: 2 });
  assert.deepEqual(rowSummary(topo, "node-jp"), { state: "degraded", n: 3, of: 3 });
  // Operator checks: cd-hs-sh's newest run to tyo-3 web passes, but its path is degraded, so its edge is too.
  const checks = topo.edges.filter((e) => e.kind === "check").map((e) => [e.id, e.state, edgeStyle(e).color]);
  assert.deepEqual(checks, [
    ["check:mon-web:node-hk", "up", "--success"],
    ["check:mon-web:node-sh", "degraded", "--warning"],
    ["check:mon-ping-jp:node-fra", "none", "--muted-foreground"],
    ["check:mon-ping-jp:node-hk", "up", "--success"],
    ["check:mon-cert:@cp", "up", "--success"],
  ]);
  assert.deepEqual(topo.checks.find((c) => c.monitorId === "mon-web")?.summary, { up: 1, degraded: 1, failing: 0, stale: 0, none: 0 });
});

/* ---- Notifications ---- */

test("golden catalogue: the console's mirror matches the server's path entries and draws their glyphs", () => {
  for (const entry of GOLDEN_CATALOGUE_PATH_ENTRIES) {
    assert.deepEqual(
      FALLBACK_CATALOGUE.types.find((t) => t.type === entry.type),
      entry,
      `${entry.type}: the fallback mirror is the server's entry`,
    );
    // The glyph is one the console draws (not the bell fallback), and no other type uses it.
    assert.ok((NOTIFY_ICON_NAMES as readonly string[]).includes(entry.icon));
    assert.equal(notifyIconName(entry.icon), entry.icon);
    assert.deepEqual(
      FALLBACK_CATALOGUE.types.filter((t) => t.icon === entry.icon).map((t) => t.type),
      [entry.type],
    );
  }
  assert.deepEqual(
    GOLDEN_CATALOGUE_PATH_ENTRIES.map((e) => [e.type, e.icon]),
    [
      ["path.degraded", "trending-down"],
      ["path.recovered", "trending-up"],
    ],
  );
  // A delivery row that carries only its type reads its presentation from the server's catalogue.
  const catalogue = { ...FALLBACK_CATALOGUE, types: [...FALLBACK_CATALOGUE.types.filter((t) => !t.type.startsWith("path.")), ...GOLDEN_CATALOGUE_PATH_ENTRIES] };
  const degraded = presentDelivery({ event_type: "path.degraded", source: "server" }, catalogue);
  const recovered = presentDelivery({ event_type: "path.recovered", source: "server" }, catalogue);
  assert.deepEqual([degraded.icon, degraded.category, notifyTone(degraded)], ["trending-down", "monitors", "warning"]);
  assert.deepEqual([recovered.icon, recovered.category, notifyTone(recovered)], ["trending-up", "monitors", "recovered"]);
});
