import assert from "node:assert/strict";
import { test } from "node:test";

import { applyQuery, compileQuery } from "@/lib/query/engine";
import { GOLDEN_MONITORS, GOLDEN_PATHS_1H, GOLDEN_PATH_SET } from "@/testing/m3Golden";

import enFleet from "../../../i18n/locales/en/fleet.ts";
import zhFleet from "../../../i18n/locales/zh-CN/fleet.ts";

import { LIST_GROUP_ORDER, ROOMY_W, defaultPresentation, formatAvailability, formatPresentation, listGroup, listOrder, parsePresentation, presentation, regionGroups, roomy } from "../networkModel.ts";
import { availability, buildPathsMatrix, countPaths, displayState, measuresNow, pathsQuerySchema, reachBySource, type PathsMatrix } from "../pathsModel.ts";
import { ROW_MARK_W, ROW_SUMMARY_EXTRA_W, buildTopology, layoutTopology } from "../topologyModel.ts";

const names = new Map(GOLDEN_MONITORS.map((m) => [m.id, m.name]));
const golden = (): PathsMatrix => buildPathsMatrix(GOLDEN_PATHS_1H, { checkName: (id) => names.get(id), controlPlane: "control plane" });
const schema = pathsQuerySchema({ reasonText: (r) => r ?? "" });
const keep = (m: PathsMatrix, text: string) => {
  const compiled = compileQuery(text, schema);
  assert.ok(compiled.ok, `${text} compiles`);
  return applyQuery(listOrder(m.paths), compiled.query);
};

/* ---- Mode ---- */

test("the view opens in the graph with a mouse in a roomy view, and in the list when narrower, on a phone or a touch screen", () => {
  const desk = { roomy: true, finePointer: true };
  const phone = { roomy: false, finePointer: false };
  const tablet = { roomy: true, finePointer: false };
  const narrowDesk = { roomy: false, finePointer: true };
  assert.equal(defaultPresentation(desk), "graph");
  assert.equal(defaultPresentation(phone), "list");
  assert.equal(defaultPresentation(tablet), "list");
  assert.equal(defaultPresentation(narrowDesk), "list", "a 768 px window has no room for the graph's columns");
  assert.equal(roomy(ROOMY_W), true);
  assert.equal(roomy(ROOMY_W - 1), false);
  assert.equal(roomy(720), false);
  assert.equal(presentation("auto", phone), "list");
  // The graph is one tap away on a phone too.
  assert.equal(presentation("graph", phone), "graph");
  assert.equal(presentation("list", desk), "list");
  // The screen's default is written as nothing, so the bare address stays bare.
  assert.equal(formatPresentation("graph", desk), "auto");
  assert.equal(formatPresentation("list", desk), "list");
  assert.equal(formatPresentation("list", phone), "auto");
  assert.equal(formatPresentation("graph", phone), "graph");
  assert.equal(parsePresentation("list"), "list");
  assert.equal(parsePresentation(["graph"]), "graph");
  assert.equal(parsePresentation("table"), "auto");
  assert.equal(parsePresentation(undefined), "auto");
});

test("a roomy view fits the graph's columns: four sources, their summaries and marks, and the address terminals, with no sideways scroll", () => {
  const m = golden();
  const topo = buildTopology({ plan: GOLDEN_PATH_SET, matrix: m, window: "1h", layer: "all" });
  assert.ok(topo.addresses.length > 0 && topo.drawnSourceIds.length > 1, "the golden set draws addresses and several sources");
  // The frame's border and padding (TopologyGraph's PAD) come off the view's width.
  const width = ROOMY_W - 2 - 32;
  const layout = layoutTopology(topo, { width });
  assert.equal(layout.width, width, "the drawing fits its frame");
  // The summary and one mark per source take their width; the name keeps what a one-source row has (260 px).
  const extra = ROW_SUMMARY_EXTRA_W + ROW_MARK_W * topo.drawnSourceIds.length;
  assert.ok(layout.rowsW - extra >= 260, `rows ${layout.rowsW} px less ${extra} keep the names' room`);
  // At 768 px (a 720 px view) the same drawing scrolls sideways and the names lose that room.
  const narrow = layoutTopology(topo, { width: 720 - 2 - 32 });
  assert.ok(narrow.width > 720 - 2 - 32);
  assert.ok(narrow.rowsW - extra < 260);
});

/* ---- The list ---- */

test("the list runs worst first before any sort: down, degraded, unknown, paused, up", () => {
  const states = listOrder(golden().paths).map((p) => displayState(p));
  const rank = { down: 0, degraded: 1, unknown: 2, paused: 3, up: 4 } as const;
  for (let i = 1; i < states.length; i++) assert.ok(rank[states[i - 1]!] <= rank[states[i]!], `${states.join(",")}`);
  assert.equal(states[0], "down");
});

test("a sort term in the query orders the list; without one the worst-first order stands", () => {
  const m = golden();
  const bySlowest = keep(m, "sort:-p50").map((p) => p.p50Ms).filter((v) => v !== undefined) as number[];
  assert.deepEqual(bySlowest, [...bySlowest].sort((a, b) => b - a));
  assert.equal(keep(m, "")[0]!.state, "down");
});

test("the list groups paths by the target's region, checks to an address last, in the list's order", () => {
  const m = golden();
  const groups = regionGroups(listOrder(m.paths));
  assert.deepEqual(groups.map((g) => g.group), ["eastAsia", "europe", "checks"].filter((g) => groups.some((x) => x.group === g)));
  for (const g of groups) assert.ok(LIST_GROUP_ORDER.indexOf(g.group) >= 0);
  // Every path is in exactly one group, and a target's paths sit together.
  assert.equal(groups.reduce((n, g) => n + g.count, 0), m.paths.length);
  const jp = groups.flatMap((g) => g.targets).find((t) => t.key === "node-jp")!;
  assert.ok(jp.paths.length >= 5, "the path set's paths and the checks to tyo-3 are one target");
  assert.equal(jp.paths[0]!.state, "degraded", "the target's worst path leads");
  const cert = m.paths.find((p) => p.monitorId === "mon-cert")!;
  assert.equal(listGroup(cert), "checks");
});

test("availability prints one floored decimal, so 99.96% of runs never reads as 100%", () => {
  assert.equal(formatAvailability(1), "100%");
  assert.equal(formatAvailability(0.9996), "99.9%");
  assert.equal(formatAvailability(0.95), "95.0%");
  assert.equal(formatAvailability(0), "0.0%");
  assert.equal(formatAvailability(undefined), "");
});

test("a path that does not measure now has no availability and no figures to sort or filter by, never 0%", () => {
  const m = golden();
  const quiet = m.paths.filter((p) => !measuresNow(p));
  assert.ok(quiet.length > 0, "the golden set holds unknown or paused paths");
  for (const p of quiet) assert.equal(availability(p), undefined, `${p.key} reads ${p.state}`);
  // A path that measures but counted no run has none either.
  const measuring = m.paths.find((p) => measuresNow(p) && p.expected > 0)!;
  assert.equal(availability({ ...measuring, samples: 0 }), undefined);
  // The query reads the figures the list shows: a filter or a sort never finds a blank cell.
  for (const text of ["p50>0", "p95>0", "jitter>=0", "loss>=0%", "availability>=0%"]) {
    for (const p of keep(m, text)) assert.ok(measuresNow(p), `${text} keeps ${p.key} (${p.state})`);
  }
  const sorted = keep(m, "sort:-p95");
  const firstBlank = sorted.findIndex((p) => !measuresNow(p) || p.p95Ms === undefined);
  assert.ok(sorted.slice(firstBlank).every((p) => !measuresNow(p) || p.p95Ms === undefined), "rows with no shown p95 sort last");
});

test("availability is a query field in percent", () => {
  const m = golden();
  const low = keep(m, "availability<99%");
  assert.ok(low.length > 0 && low.length < m.paths.length, `${low.length} of ${m.paths.length}`);
  assert.deepEqual(keep(m, "avail<99%").map((p) => p.key), low.map((p) => p.key));
});

/* ---- One count (design 32 D1) ---- */

test("every count comes from the one matrix: the proof line, Overview's reach and the graph agree", () => {
  const m = golden();
  const counts = countPaths(m.paths);
  assert.deepEqual(counts, m.counts);
  assert.equal(reachBySource(m).reduce((n, r) => n + r.total, 0), counts.paths, "Overview's lines add up to the proof line");
  const topo = buildTopology({ plan: GOLDEN_PATH_SET, matrix: m, window: "1h", layer: "all" });
  assert.equal(topo.counts.drawn + topo.counts.undrawn, counts.paths, "the graph holds every path, drawn or left to the picker");
  const drawnByState = countPaths(topo.edges.flatMap((e) => e.paths ?? []));
  assert.deepEqual(drawnByState, counts, "the paths on the graph's edges are the matrix's paths");
});

test("for one query the graph and the list show the same count", () => {
  const m = golden();
  for (const text of ["", "state:down", "state:degraded", "target:tyo-3", "source:hk-edge", "method:icmp", "state:unknown", "p50>100", "-managed"]) {
    const rows = keep(m, text);
    const matching = text ? new Set(rows.map((p) => p.key)) : undefined;
    const topo = buildTopology({ plan: GOLDEN_PATH_SET, matrix: m, matching, window: "1h", layer: "all" });
    const onGraph = topo.edges.filter((e) => e.matched).flatMap((e) => (e.paths ?? []).filter((p) => !matching || matching.has(p.key)));
    assert.equal(onGraph.length, rows.length, `${text || "(no query)"}: list ${rows.length}, graph ${onGraph.length}`);
  }
});

/* ---- One vocabulary (design 32 D1) ---- */

type Messages = Record<string, unknown>;
const at = (messages: Messages, path: string): unknown => path.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Messages)[part] : undefined), messages);
const strings = (node: unknown): string[] => (typeof node === "string" ? [node] : node && typeof node === "object" ? Object.values(node as Messages).flatMap(strings) : []);

test("Overview, Network and Checks say up, degraded, down, paused or unknown, and nothing else for a path's state", () => {
  const en = enFleet as unknown as Messages;
  const zh = zhFleet as unknown as Messages;
  assert.deepEqual(at(en, "fleet.monitoring.paths.state"), { up: "up", degraded: "degraded", down: "down", unknown: "unknown", unknownWhy: "unknown: {reason}", paused: "paused" });
  assert.deepEqual(Object.keys(at(zh, "fleet.monitoring.paths.state") as Messages).sort(), ["degraded", "down", "paused", "unknown", "unknownWhy", "up"]);
  // The Checks list's states are the same words.
  assert.equal(at(en, "fleet.monitoring.status.up"), at(en, "fleet.monitoring.paths.state.up"));
  assert.equal(at(en, "fleet.monitoring.status.failing"), at(en, "fleet.monitoring.paths.state.down"));
  assert.equal(at(zh, "fleet.monitoring.status.up"), at(zh, "fleet.monitoring.paths.state.up"));
  assert.equal(at(zh, "fleet.monitoring.status.failing"), at(zh, "fleet.monitoring.paths.state.down"));
  // The words design 32 removed appear in no state, value, legend or count of these views.
  const places = ["fleet.monitoring.paths.state", "fleet.monitoring.paths.cell", "fleet.monitoring.paths.proof", "fleet.monitoring.topology.state", "fleet.monitoring.topology.value", "fleet.monitoring.topology.legend", "fleet.monitoring.overview.reach", "fleet.monitoring.status", "fleet.monitoring.network"];
  for (const place of places) {
    for (const s of strings(at(en, place))) assert.doesNotMatch(s, /\bno path\b|not probed|nothing heard|no data/i, `${place}: ${s}`);
    for (const s of strings(at(zh, place))) assert.doesNotMatch(s, /没有路径|不探测|什么都没收到|无数据/, `${place}: ${s}`);
  }
});

test("the Network view's copy exists in both locales, and the Paths and Topology tabs are gone", () => {
  for (const messages of [enFleet, zhFleet] as unknown as Messages[]) {
    assert.equal(typeof at(messages, "fleet.monitoring.layers.network"), "string");
    assert.equal(at(messages, "fleet.monitoring.layers.paths"), undefined);
    assert.equal(at(messages, "fleet.monitoring.layers.topology"), undefined);
    for (const key of ["editCheck", "pathSet", "pair.title", "list.last", "graph.undrawn", "graph.drawAll", "lens.reaches", "lens.reachedBy"]) {
      assert.equal(typeof at(messages, `fleet.monitoring.network.${key}`), "string", key);
    }
  }
});
