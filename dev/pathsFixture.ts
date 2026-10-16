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
 *   ?m2a=1                a design 29 M2a server (dev/latencyFixture.ts): an
 *                         ICMP check to xuezhang-jp-nat from cd-hs-sh (up,
 *                         five echoes a run), mkcloud (agent too old) and
 *                         Oracle-KIX-arm (ICMP not permitted); an HTTP check
 *                         to a private address made before M2a (destination
 *                         refused); the status page with expected statuses
 *                         and headers, two of them secret, one with a 64
 *                         character name
 *   ?m2a=auto             the path set on Auto: NAT targets answer ICMP and
 *                         read up; hetzner-hel never answers (ICMP filtered)
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
import { M2A, SOURCE_ID, SOURCE_NODE, icmpRefusal } from "./latencyFixture";

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

type Behaviour = "normal" | "nat" | "offline" | "lossy" | "burst" | "gap" | "never" | "filtered";

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
  operator?: "http" | "tls" | "icmp";
  /** Echoes per run of an icmp path (design 29 M2a); absent for one probe per run. */
  packets?: number;
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
    if (shape.behaviour === "filtered") failShare = 1;
    const fail = Math.min(perBucket, Math.round(perBucket * failShare));
    const bucket: PathBucket = { t, n: perBucket, expected, fail, loss: fail / perBucket };
    if (shape.packets) {
      // Every echo of a failed run is lost; a run that came back may still lose one now and then.
      const sent = perBucket * shape.packets;
      const stray = shape.behaviour === "filtered" ? 0 : j > 0.93 ? 1 + Math.floor((j - 0.93) * 30) : 0;
      const lost = Math.min(sent, fail * shape.packets + stray);
      bucket.sent = sent;
      bucket.lost = lost;
      bucket.loss = lost / sent;
    }
    if (fail < perBucket) {
      const local = new Date((t + 8 * 3600) * 1000).getUTCHours();
      const evening = local >= 19 && local <= 23 ? 1.28 + j * 0.12 : 1;
      // ICMP is answered by the kernel: a little faster than a TCP handshake to the same node.
      const base = shape.operator === "tls" ? 82 : shape.operator === "http" ? 118 : baseMs(shape.target, shape.source) * (shape.packets ? 0.94 : 1);
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
  const icmp = pair?.method === "icmp";
  let b = behaviour(target?.name ?? "");
  if (icmp) {
    // A NAT node answers ping on its public address, which is the point of ICMP here; hetzner-hel's provider drops it.
    if (b === "nat") b = "normal";
    if (target?.name === "[cd]-hetzner-hel") b = "filtered";
  }
  if (pair?.reason) b = "never";
  return {
    target,
    source,
    behaviour: b,
    pausedSince: pair && !pair.enabled ? 2 * 86400 : undefined,
    packets: icmp ? 5 : undefined,
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
    // Never edited: version zero.
    ...(old ? {} : { version: 0, alert: "off", alert_after: 2 }),
  };
  if (!M2A) return [status, cert];
  // Design 29 M2a: the status page expects statuses and sends headers, two of them secret.
  status.expect_status = "200-299,301";
  status.headers = [
    { name: "X-Api-Key", secret: true, set: true },
    { name: "X-Lattice-Monitoring-Probe-Authorization-Token-For-Status-Page-V", secret: true, set: true },
    { name: "Accept", value: "application/json" },
  ];
  status.secrets_origin = "https://status.example.com:443";
  const jp = nodeByName("[cd]-xuezhang-jp-nat");
  const ping: MonitorView = {
    id: "mon_ping_jp",
    name: "Ping xuezhang-jp-nat",
    type: "icmp",
    target: jp?.public_ip ?? "203.0.113.12",
    target_node: jp?.id,
    packets: 5,
    interval_sec: 30,
    timeout_sec: 2,
    assign_all: false,
    node_ids: [SOURCE_ID, id("[Metix]-mkcloud-hr-iplc"), id("[cd]-Oracle-KIX-arm")].sort(),
    enabled: true,
    created_at: iso(-6 * 24 * HOUR),
    version: 1,
    alert: "down",
    alert_after: 3,
  };
  const admin: MonitorView = {
    id: "mon_admin_internal",
    name: "Admin panel (internal)",
    type: "http",
    target: "http://10.0.0.8/health",
    interval_sec: 60,
    timeout_sec: 5,
    assign_all: false,
    node_ids: [SOURCE_ID],
    enabled: true,
    created_at: iso(-120 * 24 * HOUR),
    version: 2,
    alert: "off",
    alert_after: 2,
  };
  return [status, cert, ping, admin];
}

/** Why an operator check's source measures nothing (design 29 M2a), or undefined. */
function operatorReason(check: MonitorView, source: string): string | undefined {
  if (!M2A) return undefined;
  if (check.type === "icmp") return icmpRefusal(allNodes().find((n) => n.id === source));
  if (check.id === "mon_admin_internal") return "destination_refused";
  return undefined;
}

function operatorShape(check: MonitorView, source: string, paused: boolean): Shape {
  const reason = operatorReason(check, source);
  const icmp = check.type === "icmp";
  return {
    source,
    target: icmp ? allNodes().find((n) => n.id === check.target_node) : undefined,
    behaviour: reason ? "never" : "normal",
    operator: check.type === "tls" ? "tls" : icmp ? "icmp" : "http",
    packets: icmp ? check.packets || 5 : undefined,
    pausedSince: paused ? 3 * 86400 : undefined,
  };
}

function operatorPaths(checks: MonitorView[], window: MonitorWindow): PathView[] {
  const out: PathView[] = [];
  for (const check of checks) {
    if (!check.enabled) continue;
    const sources = check.type === "tls" ? [""] : (check.node_ids ?? []);
    for (const source of sources) {
      const paused = (check.paused_node_ids ?? []).includes(source);
      const shape = operatorShape(check, source, paused);
      const reason = paused ? "source_paused" : operatorReason(check, source);
      out.push(pathFrom(shape, window, { source, target: check.target, ...(check.target_node ? { target_node: check.target_node } : {}), monitor_id: check.id, managed: false, method: check.type }, reason));
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
  // The server sends a down path without a reason; the error is in the path's runs.
  if (downReason) return { ...path, state: "down", reason: "" };
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
      const icmp = (SWITCH && node?.name === "[cd]-gomami-hk-turin-mini") || pair?.method === "icmp";
      const base = {
        source,
        target_node: target.node_id,
        // ICMP dials an address, not a port.
        target: node ? (icmp ? (node.public_ip ?? "") : natEndpoint(node)) : (target.endpoint ?? ""),
        monitor_id: pair?.monitor_id ?? target.monitor_id ?? `mon_lat_${target.node_id}`,
        managed: true,
        method: icmp ? "icmp" : "tcp",
      };
      // The source cannot run the pair's method (design 29 M2a): unknown with the reason, never down.
      if (pair?.reason && pair.reason !== "not_probeable" && pair.enabled && plan.config.enabled) {
        paths.push(pathFrom(shape, window, base, pair.reason));
        continue;
      }
      if (target.target === "not_probeable" || (pair?.reason === "not_probeable" && !icmp)) {
        // The server says not_probeable whatever the plan's note (udp_only, no_public_address, no_tcp_line).
        paths.push({ ...base, target: "", monitor_id: "", state: "unknown", reason: "not_probeable", samples: 0, expected: 0, prev: null });
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
      if (b === "filtered") {
        paths.push(pathFrom(shape, window, base, "icmp_filtered"));
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
    shape = check ? operatorShape(check, query.source, paused) : { source: query.source, behaviour: "normal", operator: "http" };
  } else {
    shape = shapeFor(plan, query.source, query.target_node ?? "");
    const target = plan.nodes.find((n) => n.node_id === query.target_node);
    const pair = plan.pairs.find((p) => p.source === query.source && p.target === query.target_node);
    if (target?.target === "not_probeable" && pair?.method !== "icmp") shape = { ...shape, pausedSince: Infinity };
    if (!plan.config.enabled) shape = { ...shape, pausedSince: Infinity };
  }
  const { step, from, to, buckets } = bucketsFor(shape, query.window);
  // As the server: the method in force from the first bucket with data, then each switch.
  const firstHeard = buckets.find((b) => b.n > 0)?.t ?? from;
  const switched = SWITCH && shape.target?.name === "[cd]-gomami-hk-turin-mini";
  const method_changes = [{ t: firstHeard, method: switched ? "tcp" : query.monitor && !query.target_node ? (checks.find((c) => c.id === query.monitor)?.type ?? "tcp") : shape.packets ? "icmp" : "tcp" }];
  if (switched) method_changes.push({ t: Math.floor((NOW / 1000 - 2 * 86400) / step) * step, method: "icmp" });
  return { window: query.window, step_seconds: step, from, to, method_changes, buckets };
}

/** The raw runs the results route serves for a path: the last twenty per source. */
export function resultsFor(plan: LatencyProbePlan, checks: MonitorView[], monitorId: string): MonitorResult[] {
  const check = checks.find((c) => c.id === monitorId);
  const out: MonitorResult[] = [];
  const push = (source: string, shape: Shape, endpoint: string, reason?: string) => {
    // An agent too old for the method is never handed the check, so it reports nothing.
    if (reason === "agent_too_old") return;
    if (reason) {
      // A run that measured nothing: no latency, and the reason instead of a failure.
      for (let i = 0; i < 12; i++) {
        out.push({ monitor_id: monitorId, node_id: source, at: new Date(NOW - (i * 60 + 25) * 1000).toISOString(), success: false, reason, ...(reason === "destination_refused" ? { error: `refused to dial 10.0.0.8: private address` } : { sent: 0 }) });
      }
      return;
    }
    const { buckets } = bucketsFor(shape, "1h");
    for (const b of buckets.slice(-20)) {
      if (!b.n) continue;
      const failed = b.fail >= b.n;
      if (shape.packets) {
        // Five echoes: the RTT of each one that came back, in send order, and the median as the run's latency.
        const sent = shape.packets;
        const lost = failed ? sent : Math.min(sent, Math.round(((b.lost ?? 0) / Math.max(1, b.sent ?? 1)) * sent));
        const p50 = b.p50_ms ?? 60;
        const rtts = Array.from({ length: sent - lost }, (_, k) => Math.round(p50 * (0.96 + hash(`${source}:${b.t}:${k}`) * 0.1) * 10) / 10);
        const sorted = [...rtts].sort((x, y) => x - y);
        const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : undefined;
        out.push({ monitor_id: monitorId, node_id: source, at: new Date((Number(b.t) + 30) * 1000).toISOString(), success: rtts.length > 0, latency_ms: median, sent, lost, rtts_ms: rtts.length ? rtts : undefined, error: rtts.length ? undefined : `no echo reply from ${endpoint}` });
        continue;
      }
      out.push({
        monitor_id: monitorId,
        node_id: source,
        at: new Date((Number(b.t) + 30) * 1000).toISOString(),
        // A certificate check reads the leaf's expiry: 41 days out.
        ...(shape.operator === "tls" ? { cert_not_after: new Date(NOW + 41 * 86_400_000).toISOString() } : {}),
        success: !failed,
        latency_ms: failed ? undefined : (b.p50_ms ?? undefined),
        error: failed ? (shape.behaviour === "offline" ? `dial tcp ${endpoint}: connect: connection refused` : `dial tcp ${endpoint}: i/o timeout`) : undefined,
      });
    }
  };
  if (check) {
    for (const source of check.type === "tls" ? [""] : (check.node_ids ?? [])) {
      if ((check.paused_node_ids ?? []).includes(source)) continue;
      push(source, operatorShape(check, source, false), check.target, operatorReason(check, source));
    }
    return out;
  }
  const target = plan.nodes.find((n) => n.monitor_id === monitorId || n.icmp_monitor_id === monitorId);
  if (!target) return out;
  const node = allNodes().find((n) => n.id === target.node_id);
  for (const pair of plan.pairs.filter((p) => p.target === target.node_id && p.active && (p.monitor_id ?? target.monitor_id) === monitorId)) {
    if (sourceOffline(pair.source)) continue;
    push(pair.source, shapeFor(plan, pair.source, target.node_id), node ? (pair.method === "icmp" ? (node.public_ip ?? "") : natEndpoint(node)) : "");
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
