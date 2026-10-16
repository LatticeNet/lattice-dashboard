/**
 * Monitoring paths for the fleet harness (design 29 M1), shaped like
 * production on 2026-10-16: one source (`cd-hs-sh`), 33 targets over six
 * regions, four NAT targets whose public port differs from the one dialled
 * (down: i/o timeout), the offline DMIT-4 (down: refused), three nodes a TCP
 * probe cannot dial (unknown), one path paused, one node included but never
 * probed yet. Every latency, loss and gap below is invented.
 *
 *   ?paths=one (default)  the above
 *   ?paths=three          two more sources; mkcloud's agent went offline 20 hours ago
 *   ?paths=empty          the path set has no source: nothing is measured
 *   ?paths=old            a server from before design 29: the paths, series,
 *                         settings and update routes answer 404, and the
 *                         console falls back to the latency routes
 *   ?retention=14         fourteen days of fine history (the 14d window shows)
 *   ?switch=1             gomami-hk switched from tcp to icmp two days ago
 *
 * Series: a week of buckets on the server's step rule with a control plane
 * outage two thirds of the way back (no data on every path), a loss burst on
 * Aaitr-ATT-VDS a day ago, a ten hour gap on cloudcone-la four days ago, the
 * evening peak from China, and all-failed buckets on the down targets.
 */
import type {
  LatencyProbePlan,
  MonitorResult,
  MonitorSettings,
  MonitorView,
  MonitorWindow,
  Node,
  PathBucket,
  PathSeriesResponse,
  PathView,
  PathsResponse,
} from "@/lib/api/index";
import { expectedStepSeconds } from "@/views/fleet/pathSeriesModel";
import { WINDOW_SECONDS } from "@/views/fleet/pathsModel";
import { seriesStats, seriesFromResponse } from "@/views/fleet/pathSeriesModel";

import { HOUR, NODES, NOW, PARAMS, iso, nodeByName } from "./fleetFixture";
import { SOURCE_ID, SOURCE_NODE } from "./latencyFixture";

export const PATHS_SHAPE = (PARAMS.get("paths") ?? "") as "" | "one" | "three" | "empty" | "old";
export const FINE_DAYS = PARAMS.get("retention") === "14" ? 14 : 7;
const SWITCH = PARAMS.get("switch") === "1";

const id = (name: string) => nodeByName(name)?.id ?? name;
const allNodes = (): Node[] => [...NODES, ...(SOURCE_NODE ? [SOURCE_NODE] : [])];

/** Countries the fleet fixture leaves unset, given here so the matrix groups into six regions. */
const COUNTRY: Record<string, string> = {
  "[cd]-homeserver": "CN",
  "[OpenJobs-Data]-gpu-box": "CN",
  "[OpenJobs-Data]-tmp": "SG",
};

type Behaviour = "normal" | "nat" | "offline" | "lossy" | "burst" | "gap" | "never";

function behaviour(name: string): Behaviour {
  if (["[cd]-xuezhang-jp-nat", "[Metix]-Aaitr-jp-softbank-NAT", "[cd]-qqpw-vds-cd1", "[Metix]-qqpw-cd3-VDS"].includes(name)) return "nat";
  if (name === "[Metix]-DMIT-4") return "offline";
  if (name === "[Metix]-VIRCS-ATT-VDS") return "lossy";
  if (name === "[Metix]-Aaitr-ATT-VDS") return "burst";
  if (name === "[cd]-cloudcone-la") return "gap";
  if (name === "[OpenJobs-Data]-tmp") return "never";
  return "normal";
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  // FNV alone leaves neighbouring bucket numbers correlated; a final mix spreads them.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Round trip from China to a city, invented but in the right order. */
function baseMs(node: Node | undefined, source: string): number {
  const fromNorth = source === id("[Metix]-mkcloud-hr-iplc") ? 12 : source === id("[cd]-volcengine-shanghai") ? -4 : 0;
  const city = node?.geo?.city;
  const base: Record<string, number> = {
    "Hong Kong": 34,
    Tokyo: 68,
    Osaka: 64,
    Singapore: 82,
    "Los Angeles": 156,
    "San Jose": 164,
    Honolulu: 198,
    Sydney: 142,
    London: 226,
    Falkenstein: 241,
    Helsinki: 268,
    Shanghai: 6,
    Harbin: 38,
  };
  if (!node?.geo?.country) return 28 + fromNorth;
  return (base[city ?? ""] ?? 120) + fromNorth;
}

function sourceOffline(source: string): boolean {
  return PATHS_SHAPE === "three" && source === id("[Metix]-mkcloud-hr-iplc");
}

function natEndpoint(node: Node): string {
  return `${node.public_ip ?? "203.0.113.1"}:${node.name.toLowerCase().includes("nat") || node.name.includes("qqpw") ? 50100 : 443}`;
}

/* ---- Series ---- */

interface Shape {
  target?: Node;
  source: string;
  behaviour: Behaviour;
  pausedSince?: number;
  operator?: "http" | "tls";
}

function bucketsFor(shape: Shape, window: MonitorWindow, offsetSec = 0): { step: number; from: number; to: number; buckets: PathBucket[] } {
  const step = expectedStepSeconds(window, 60, FINE_DAYS);
  const to = Math.floor((NOW / 1000 - offsetSec) / step) * step;
  const span = WINDOW_SECONDS[window];
  const from = to - span;
  const perBucket = Math.max(1, Math.round(step / 60));
  const buckets: PathBucket[] = [];
  const now = NOW / 1000;
  for (let t = from; t < to; t += step) {
    const age = now - t;
    const j = hash(`${shape.source}:${shape.target?.id ?? shape.operator}:${Math.floor(t / step)}`);
    const expected = shape.pausedSince !== undefined && age < shape.pausedSince ? 0 : perBucket;
    // The control plane was down for a while, two thirds of the week back: nobody heard anything.
    const outage = age > 7 * 86400 * 0.62 && age < 7 * 86400 * 0.62 + 5 * 3600;
    let heard = !outage;
    if (shape.behaviour === "gap" && age > 4 * 86400 && age < 4 * 86400 + 10 * 3600) heard = false;
    if (shape.behaviour === "never") heard = false;
    if (sourceOffline(shape.source) && age < 20 * 3600) heard = false;
    if (!expected) {
      buckets.push({ t, n: 0, expected: 0, fail: 0 });
      continue;
    }
    if (!heard) {
      buckets.push({ t, n: 0, expected, fail: 0 });
      continue;
    }
    // A stray failed run now and then, never in the newest minutes (a check's state reads its newest run).
    let failShare = j > 0.997 && age > 600 ? 1 / perBucket : 0;
    if (shape.behaviour === "nat") failShare = 1;
    if (shape.behaviour === "offline") failShare = age < 30 * 3600 ? 1 : j > 0.9 ? 1 / perBucket : 0;
    if (shape.behaviour === "lossy") failShare = 0.04 + j * 0.08;
    if (shape.behaviour === "burst" && age > 22 * 3600 && age < 24 * 3600) failShare = 0.3 + j * 0.3;
    const fail = Math.min(perBucket, Math.round(perBucket * failShare));
    const bucket: PathBucket = { t, n: perBucket, expected, fail, loss: fail / perBucket };
    if (fail < perBucket) {
      const local = new Date((t + 8 * 3600) * 1000).getUTCHours();
      const evening = local >= 19 && local <= 23 ? 1.28 + j * 0.12 : 1;
      const base = shape.operator === "tls" ? 82 : shape.operator === "http" ? 118 : baseMs(shape.target, shape.source);
      const burst = shape.behaviour === "burst" && age > 22 * 3600 && age < 24 * 3600 ? 1.6 : 1;
      const p50 = (base + j * 9) * evening * burst;
      bucket.p50_ms = Math.round(p50 * 10) / 10;
      bucket.p95_ms = Math.round(p50 * (1.12 + j * 0.35) * 10) / 10;
      bucket.min_ms = Math.round(p50 * (0.9 - j * 0.04) * 10) / 10;
      bucket.max_ms = Math.round(bucket.p95_ms * (1.08 + j * 0.3) * 10) / 10;
      bucket.jitter_ms = Math.round(p50 * (0.02 + j * 0.05) * 10) / 10;
    }
    if (SWITCH && shape.target?.name === "[cd]-gomami-hk-turin-mini") bucket.method = age < 2 * 86400 ? "icmp" : "tcp";
    buckets.push(bucket);
  }
  return { step, from, to, buckets };
}

function shapeFor(plan: LatencyProbePlan, source: string, targetNode: string): Shape {
  const target = allNodes().find((n) => n.id === targetNode);
  const pair = plan.pairs.find((p) => p.source === source && p.target === targetNode);
  return {
    target,
    source,
    behaviour: behaviour(target?.name ?? ""),
    pausedSince: pair && !pair.enabled ? 2 * 86400 : undefined,
  };
}

/* ---- Operator checks ---- */

const STATUS_SOURCES = () => [SOURCE_ID, id("[cd]-hetzner-fsn"), id("[cd]-racknerd-la")];

export function operatorChecks(): MonitorView[] {
  if (!PATHS_SHAPE || PATHS_SHAPE === "empty") return [];
  const old = PATHS_SHAPE === "old";
  const status: MonitorView = {
    id: "mon_status_page",
    name: "Status page",
    type: "http",
    target: "https://status.example.com/health",
    interval_sec: 30,
    timeout_sec: 5,
    assign_all: false,
    node_ids: STATUS_SOURCES(),
    enabled: true,
    created_at: iso(-40 * 24 * HOUR),
    ...(old ? {} : { version: 3, paused_node_ids: [id("[cd]-racknerd-la")], alert: "down", alert_after: 2 }),
  };
  const cert: MonitorView = {
    id: "mon_api_cert",
    name: "API certificate",
    type: "tls",
    target: "api.example.com:443",
    interval_sec: 3600,
    timeout_sec: 10,
    threshold_days: 14,
    assign_all: false,
    enabled: true,
    created_at: iso(-90 * 24 * HOUR),
    ...(old ? {} : { version: 1, alert: "down", alert_after: 2 }),
  };
  return [status, cert];
}

function operatorPaths(checks: MonitorView[], window: MonitorWindow): PathView[] {
  const out: PathView[] = [];
  for (const check of checks) {
    if (!check.enabled) continue;
    const sources = check.type === "tls" ? [""] : (check.node_ids ?? []);
    for (const source of sources) {
      const paused = (check.paused_node_ids ?? []).includes(source);
      const shape: Shape = { source, behaviour: "normal", operator: check.type === "tls" ? "tls" : "http", pausedSince: paused ? 3 * 86400 : undefined };
      out.push(pathFrom(shape, window, { source, target: check.target, monitor_id: check.id, managed: false, method: check.type }, paused ? "source_paused" : undefined));
    }
  }
  return out;
}

/* ---- The matrix ---- */

function pathFrom(shape: Shape, window: MonitorWindow, base: Omit<PathView, "state" | "samples" | "expected">, unknownReason?: string, downReason?: string): PathView {
  const now = bucketsFor(shape, window);
  const prev = bucketsFor(shape, window, WINDOW_SECONDS[window]);
  const stats = seriesStats(seriesFromResponse({ window, step_seconds: now.step, from: now.from, to: now.to, buckets: now.buckets }).points);
  const prevStats = seriesStats(seriesFromResponse({ window, step_seconds: prev.step, from: prev.from, to: prev.to, buckets: prev.buckets }).points);
  const last = [...now.buckets].reverse().find((b) => b.n > 0);
  const path: PathView = {
    ...base,
    state: "up",
    samples: stats.samples,
    expected: stats.expected,
    p50_ms: stats.p50Ms,
    p95_ms: stats.p95Ms,
    jitter_ms: stats.jitterMs !== undefined ? Math.round(stats.jitterMs * 10) / 10 : undefined,
    loss: stats.loss !== undefined ? Math.round(stats.loss * 10000) / 10000 : undefined,
    prev: prevStats.samples > 0 ? { p50_ms: prevStats.p50Ms, loss: prevStats.loss !== undefined ? Math.round(prevStats.loss * 10000) / 10000 : undefined } : null,
    last_at: last ? new Date((Number(last.t) + now.step) * 1000 - 20_000).toISOString() : undefined,
  };
  if (unknownReason) return { ...path, state: "unknown", reason: unknownReason };
  if (downReason) return { ...path, state: "down", reason: downReason };
  if (!last) return { ...path, state: "unknown", reason: "no_results" };
  return path;
}

export function pathsFor(plan: LatencyProbePlan, window: MonitorWindow, checks: MonitorView[]): PathsResponse {
  const byId = new Map(allNodes().map((n) => [n.id, n]));
  const sources = plan.config.sources.filter((s) => byId.has(s));
  const targets = plan.nodes.filter((n) => n.target === "probed" || n.target === "paused" || n.target === "not_probeable");
  const paths: PathView[] = [];
  for (const target of targets) {
    const node = byId.get(target.node_id);
    for (const source of sources) {
      if (source === target.node_id) continue;
      const pair = plan.pairs.find((p) => p.source === source && p.target === target.node_id);
      const shape = shapeFor(plan, source, target.node_id);
      const base = {
        source,
        target_node: target.node_id,
        target: node ? natEndpoint(node) : (target.endpoint ?? ""),
        monitor_id: target.monitor_id ?? `mon_lat_${target.node_id}`,
        managed: true,
        method: SWITCH && node?.name === "[cd]-gomami-hk-turin-mini" ? "icmp" : "tcp",
      };
      if (target.target === "not_probeable") {
        paths.push({ ...base, target: "", state: "unknown", reason: target.endpoint_note ?? "no_tcp_line", samples: 0, expected: 0, prev: null });
        continue;
      }
      if (!plan.config.enabled) {
        paths.push(pathFrom({ ...shape, pausedSince: Infinity }, window, base, "path_set_paused"));
        continue;
      }
      if (pair && !pair.enabled) {
        paths.push(pathFrom(shape, window, base, "path_paused"));
        continue;
      }
      if (sourceOffline(source)) {
        paths.push(pathFrom(shape, window, base, "agent_offline"));
        continue;
      }
      const b = shape.behaviour;
      if (b === "nat") {
        paths.push(pathFrom(shape, window, base, undefined, `dial tcp ${base.target}: i/o timeout`));
        continue;
      }
      if (b === "offline") {
        paths.push(pathFrom(shape, window, base, undefined, `dial tcp ${base.target}: connect: connection refused`));
        continue;
      }
      if (b === "never") {
        paths.push(pathFrom(shape, window, base, "no_results"));
        continue;
      }
      paths.push(pathFrom(shape, window, base));
    }
  }
  paths.push(...operatorPaths(checks, window));
  return {
    window,
    observed_at: new Date(NOW - 12_000).toISOString(),
    // Every source a path names, the path set's first, then the checks' (the control plane has no node).
    sources: [...new Set([...sources, ...paths.map((p) => p.source).filter(Boolean)])].map((s) => ({ node_id: s, name: byId.get(s)?.name ?? s })),
    targets: targets.map((t) => {
      const node = byId.get(t.node_id);
      return { node_id: t.node_id, name: t.name, country: node?.geo?.country ?? COUNTRY[t.name], region: t.region };
    }),
    paths,
  };
}

export function seriesFor(plan: LatencyProbePlan, checks: MonitorView[], query: { source: string; target_node?: string; monitor?: string; window: MonitorWindow }): PathSeriesResponse {
  let shape: Shape;
  if (query.monitor && !query.target_node) {
    const check = checks.find((c) => c.id === query.monitor);
    const paused = (check?.paused_node_ids ?? []).includes(query.source);
    shape = { source: query.source, behaviour: "normal", operator: check?.type === "tls" ? "tls" : "http", pausedSince: paused ? 3 * 86400 : undefined };
  } else {
    shape = shapeFor(plan, query.source, query.target_node ?? "");
    const target = plan.nodes.find((n) => n.node_id === query.target_node);
    if (target?.target === "not_probeable") shape = { ...shape, pausedSince: Infinity };
    if (!plan.config.enabled) shape = { ...shape, pausedSince: Infinity };
  }
  const { step, from, to, buckets } = bucketsFor(shape, query.window);
  const method_changes = SWITCH && shape.target?.name === "[cd]-gomami-hk-turin-mini" ? [{ t: Math.floor((NOW / 1000 - 2 * 86400) / step) * step, method: "icmp" }] : [];
  return { window: query.window, step_seconds: step, from, to, method_changes, buckets };
}

/** The raw runs the results route serves for a path: the last twenty per source. */
export function resultsFor(plan: LatencyProbePlan, checks: MonitorView[], monitorId: string): MonitorResult[] {
  const check = checks.find((c) => c.id === monitorId);
  const out: MonitorResult[] = [];
  const push = (source: string, shape: Shape, endpoint: string) => {
    const { buckets } = bucketsFor(shape, "1h");
    for (const b of buckets.slice(-20)) {
      if (!b.n) continue;
      const failed = b.fail >= b.n;
      out.push({
        monitor_id: monitorId,
        node_id: source,
        at: new Date((Number(b.t) + 30) * 1000).toISOString(),
        success: !failed,
        latency_ms: failed ? undefined : b.p50_ms,
        error: failed ? (shape.behaviour === "offline" ? `dial tcp ${endpoint}: connect: connection refused` : `dial tcp ${endpoint}: i/o timeout`) : undefined,
      });
    }
  };
  if (check) {
    for (const source of check.type === "tls" ? [""] : (check.node_ids ?? [])) {
      if ((check.paused_node_ids ?? []).includes(source)) continue;
      push(source, { source, behaviour: "normal", operator: check.type === "tls" ? "tls" : "http" }, check.target);
    }
    return out;
  }
  const target = plan.nodes.find((n) => n.monitor_id === monitorId);
  if (!target) return out;
  const node = allNodes().find((n) => n.id === target.node_id);
  for (const pair of plan.pairs.filter((p) => p.target === target.node_id && p.active)) {
    if (sourceOffline(pair.source)) continue;
    push(pair.source, shapeFor(plan, pair.source, target.node_id), node ? natEndpoint(node) : "");
  }
  return out;
}

let settings: MonitorSettings | undefined;

export function settingsFor(pathCount: number): MonitorSettings {
  settings ??= {
    version: 2,
    fine_retention_days: FINE_DAYS,
    fine_min_days: 3,
    fine_max_days: 14,
    coarse_retention_days: 35,
    raw_rows_per_path: 1440,
    paths: pathCount,
    // Four days since the switch: the fine tier is filling toward a week.
    measured_bytes: Math.round(pathCount * (60_000 * 4 + 52_000 + 260_000)),
    projected_bytes: Math.round(pathCount * (60_000 * FINE_DAYS + 70_000 + 260_000)),
  };
  return { ...settings, paths: pathCount };
}

export function saveSettings(version: number, days: number): MonitorSettings | "conflict" {
  if (!settings || version !== settings.version) return "conflict";
  settings = {
    ...settings,
    version: settings.version + 1,
    projected_bytes: Math.max(0, settings.projected_bytes + (days - settings.fine_retention_days) * settings.paths * 60_000),
    fine_retention_days: days,
  };
  return { ...settings };
}
