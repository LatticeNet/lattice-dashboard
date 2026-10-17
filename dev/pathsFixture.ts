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
 *   ?paths=six            three more sources (hetzner-fsn, racknerd-la, DMIT-pro-malibu), so
 *                         Topology's picker draws the first four of six
 *   ?m3=1                 a design 29 M3 server (contract D13): the matrix carries
 *                         degraded_at, series carry their baseline (and the previous
 *                         period with compare=previous), and the status page check is
 *                         on down_and_degraded with its own thresholds. From cd-hs-sh:
 *                         hetzner-fsn degraded on loss, gomami-hk degraded on latency
 *                         (after its switch from TCP to ICMP two days ago), racknerd-la
 *                         clearing, VIRCS-ATT degraded on both from every source that
 *                         reports, TiDB-1 new with 14 hours of baseline. With
 *                         ?paths=three mkcloud is online, volcengine-shanghai fails four
 *                         targets the other sources reach and reports on eight (its other
 *                         paths stopped 25 minutes ago), DMIT-4 is down from all three,
 *                         so every triangulation verdict appears; with one source every
 *                         verdict reads "this path"
 *   ?names=long           two nodes the matrix names with long names, to see
 *                         truncation in cells, lists, sheets and the attention list
 *   ?m3=golden            the M3 server's golden responses (src/testing/m3Golden.ts),
 *                         served verbatim: the 1h and 7d matrices, the one series they
 *                         hold (hk-edge to tyo-3, 1h, with compare=previous), the
 *                         monitors list and the path set. dev/goldenClock.ts moves the
 *                         page's clock to when the server answered. Other windows and
 *                         other paths' series answer 502, since the server was not asked
 *                         for them; runs answer empty; the node list is the path set's
 *                         four nodes on a template node, the one thing here not taken
 *                         from the server
 *   ?m2b=1                a design 29 M2b server (dev/beaconShapes.ts). With
 *                         ?m2a=auto the NAT targets whose beacon admits
 *                         cd-hs-sh move from TCP (failing) to Beacon (up) two
 *                         days ago, and hetzner-hel's beacon reads UDP
 *                         filtered; ?pin=beacon pins cd-hs-sh to Beacon so
 *                         every beacon reason shows. A Beacon check to
 *                         xuezhang-jp-nat runs from four sources: up, firewall
 *                         pending, agent too old, and clock skew
 *
 * Series: a week of buckets on the server's step rule with a control plane
 * outage two thirds of the way back (no data on every path), a loss burst on
 * Aaitr-ATT-VDS a day ago, a ten hour gap on cloudcone-la four days ago, the
 * evening peak from China, and all-failed buckets on the down targets.
 */
import type {
  LatencyProbePlan,
  MonitorDegradedRule,
  MonitorResult,
  MonitorSettings,
  MonitorView,
  MonitorWindow,
  Node,
  PathBaseline,
  PathBucket,
  PathDegradation,
  PathSeriesQuery,
  PathSeriesResponse,
  PathView,
  PathsResponse,
} from "@/lib/api/index";
import { GOLDEN_MONITORS, GOLDEN_PATHS_1H, GOLDEN_PATHS_7D, GOLDEN_PATH_SET, GOLDEN_SERIES, GOLDEN_SERIES_QUERY } from "@/testing/m3Golden";
import { expectedStepSeconds } from "@/views/fleet/pathSeriesModel";
import { WINDOW_SECONDS } from "@/views/fleet/pathsModel";
import { seriesStats, seriesFromResponse } from "@/views/fleet/pathSeriesModel";

import { HOUR, NODES, NOW, PARAMS, iso, nodeByName } from "./fleetFixture";
import { M2A, SOURCE_ID, SOURCE_NODE, agentPredatesM2a, icmpRefusal } from "./latencyFixture";
import { M2B, beaconShape, beaconSourceGate, beaconTargetGate, runsBeaconClient } from "./beaconShapes";

export const PATHS_SHAPE = (PARAMS.get("paths") ?? "") as "" | "one" | "three" | "six" | "empty" | "old";
export const FINE_DAYS = PARAMS.get("retention") === "14" ? 14 : 7;
/** Design 29 M3 (contract D13): a server that judges degraded. */
export const M3 = PARAMS.get("m3") === "1" && PATHS_SHAPE !== "old";
/** `?m3=golden`: the M3 server's own answers, verbatim (see the header). */
export const GOLDEN = PARAMS.get("m3") === "golden";
// The M3 fixture shows a method switch on gomami-hk as well.
const SWITCH = PARAMS.get("switch") === "1" || M3;
const SEVERAL = PATHS_SHAPE === "three" || PATHS_SHAPE === "six";
/** `?names=long`: the names the matrix carries for two nodes, long enough to wrap or truncate everywhere. */
const LONG_NAMES: Record<string, string> = PARAMS.get("names") === "long"
  ? {
      "[cd]-hetzner-fsn": "[cd]-hetzner-fsn-falkenstein-dedicated-ax41-nvme-relay-and-backup-target",
      "[cd]-volcengine-shanghai": "[cd]-volcengine-shanghai-east-china-2-ecs-g3i-probe-source",
    }
  : {};
const shownName = (name: string) => LONG_NAMES[name] ?? name;

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
  // On an M3 server mkcloud is back, so three sources report and triangulation has something to place.
  return PATHS_SHAPE === "three" && !M3 && source === id("[Metix]-mkcloud-hr-iplc");
}

/* ---- Design 29 M3: degraded paths and triangulation ---- */

/** The last hour's story on a path, for the degraded evaluator to find (D13). */
type Recent = "loss" | "latency" | "clearing" | "both" | "sourceDown";

/** Targets volcengine-shanghai fails while the other sources reach them: its own network. */
const VOLC_BAD = new Set(["[cd]-linode-sgp", "[cd]-Akkocloud-UK-London-KVM", "[Metix]-DMIT-1", "[Metix]-DMIT-2"]);
/** The other targets it still reports on; every path not named here stopped 25 minutes ago. */
const VOLC_FRESH = new Set(["[Metix]-DMIT-4", "[cd]-gomami-hk-turin-mini", "[cd]-Oracle-KIX-arm", "[cd]-racknerd-la"]);
/** mkcloud's two paths whose results stopped. */
const MK_STALE = new Set(["[OpenJobs-Data]-TiDB-2", "[OpenJobs-Data]-scripts"]);
/** How long ago a stale path last heard anything. */
const STALE_FOR = 25 * 60;

function m3Recent(source: string, targetName: string | undefined): Recent | undefined {
  if (!M3 || !targetName) return undefined;
  if (SEVERAL && source === id("[cd]-volcengine-shanghai") && VOLC_BAD.has(targetName)) return "sourceDown";
  if (targetName === "[Metix]-VIRCS-ATT-VDS") return "both";
  if (source !== SOURCE_ID) return undefined;
  if (targetName === "[cd]-hetzner-fsn") return "loss";
  if (targetName === "[cd]-gomami-hk-turin-mini") return "latency";
  if (targetName === "[cd]-racknerd-la") return "clearing";
  return undefined;
}

function m3Stale(source: string, targetName: string | undefined): boolean {
  if (!M3 || !SEVERAL || !targetName) return false;
  if (source === id("[cd]-volcengine-shanghai")) return !VOLC_BAD.has(targetName) && !VOLC_FRESH.has(targetName);
  return source === id("[Metix]-mkcloud-hr-iplc") && MK_STALE.has(targetName);
}

/** A target added a little over half a day ago: its baseline holds 14 hours, so it is not judged yet. */
function m3BornAgo(source: string, targetName: string | undefined): number | undefined {
  return M3 && source === SOURCE_ID && targetName === "[OpenJobs-Data]-TiDB-1" ? 14 * 3600 + 20 * 60 : undefined;
}

/** The status page's own thresholds on an M3 server. */
const STATUS_RULE: MonitorDegradedRule = { loss_percent: 5, latency_margin_ms: 50 };

function natEndpoint(node: Node): string {
  return `${node.public_ip ?? "203.0.113.1"}:${node.name.toLowerCase().includes("nat") || node.name.includes("qqpw") ? 50100 : 443}`;
}

/* ---- Series ---- */

interface Shape {
  target?: Node;
  source: string;
  behaviour: Behaviour;
  pausedSince?: number;
  operator?: "http" | "tls" | "icmp" | "beacon";
  /** Echoes or requests per run of an icmp or beacon path (design 29 M2a, M2b); absent for one probe per run. */
  packets?: number;
  /** The method of the path's newest buckets. */
  method?: "tcp" | "icmp" | "beacon";
  /** Seconds back to the switch from TCP: older buckets were TCP and behaved as `before`. */
  switchedAt?: number;
  before?: Behaviour;
  /** Design 29 M3: what the last hour holds (a loss burst, a slow spell, one that is clearing). */
  recent?: Recent;
  /** Seconds since a stale path last heard anything. */
  staleFor?: number;
  /** Seconds since the path was made; nothing was expected before. */
  bornAgo?: number;
}

/** Whether one minute of a path failed in the recent spell, as a coin that lands the same way every render. */
function failsMinute(shape: Shape, minute: number, share: number): boolean {
  return hash(`${shape.source}:${shape.target?.id ?? shape.operator}:m${minute}`) < share;
}

/** Beacon paths to NAT targets were TCP until two days ago, failing on the unmapped port. */
const BEACON_SWITCH_AGE = 2 * 86400;

/** The resolution of the tier a matrix window reads (the server's pathMatrixTier): raw minutes up to an hour, five minutes below 3d, hours from 3d. */
function matrixResolution(window: MonitorWindow): number {
  const span = WINDOW_SECONDS[window];
  return span <= 3600 ? 60 : span < 72 * 3600 ? 300 : 3600;
}

/**
 * One path's buckets over a window, as the server lays them out.
 *
 * A series (pathSeriesFrom): as many steps as fit in the span,
 * ceil(span/step), the last of them the step in progress at now (`to` is now,
 * not a step), so an hour at a minute is 60 buckets. The step in progress
 * expects the runs certainly due over the part that has passed, and never
 * fewer than it has heard (pathInProgressExpected; a run lands at the half
 * minute, as resultsFor stamps them), so the golden series' last bucket reads
 * 1 of 1.
 *
 * A matrix window (`whole`, pathWindowBounds): the span's whole buckets of the
 * window's tier, ending where the bucket in progress begins, so a path that
 * ran every interval reads as many runs as it expected.
 */
function bucketsFor(shape: Shape, window: MonitorWindow, offsetSec = 0, whole = false): { step: number; from: number; to: number; buckets: PathBucket[] } {
  const step = expectedStepSeconds(window, 60, FINE_DAYS);
  const span = WINDOW_SECONDS[window];
  const res = matrixResolution(window);
  const to = whole ? Math.floor((NOW / 1000 - offsetSec) / res) * res : NOW / 1000 - offsetSec;
  const from = whole ? to - span : Math.floor(to / step) * step - (Math.ceil(span / step) - 1) * step;
  const perBucket = Math.max(1, Math.round(step / 60));
  const buckets: PathBucket[] = [];
  const now = NOW / 1000;
  for (let t = from; whole ? t < to : t <= to; t += step) {
    const age = now - t;
    const covered = Math.min(step, to - t);
    const runs = covered >= step ? perBucket : Math.min(perBucket, Math.floor((covered + 30) / 60));
    const due = covered >= step ? perBucket : Math.floor(covered / 60);
    const j = hash(`${shape.source}:${shape.target?.id ?? shape.operator}:${Math.floor(t / step)}`);
    // Before a switch the path ran the old method with its old behaviour (a NAT target failing over TCP).
    const switched = shape.switchedAt !== undefined && age > shape.switchedAt;
    const behaviourNow: Behaviour = switched ? (shape.before ?? "normal") : shape.behaviour;
    const packets = switched ? undefined : shape.packets;
    const born = shape.bornAgo === undefined || age < shape.bornAgo;
    const off = (shape.pausedSince !== undefined && age < shape.pausedSince) || !born;
    const expected = off ? 0 : due;
    // The control plane was down for a while, two thirds of the week back: nobody heard anything.
    const outage = age > 7 * 86400 * 0.62 && age < 7 * 86400 * 0.62 + 5 * 3600;
    let heard = !outage;
    if (behaviourNow === "gap" && age > 4 * 86400 && age < 4 * 86400 + 10 * 3600) heard = false;
    if (behaviourNow === "never") heard = false;
    if (sourceOffline(shape.source) && age < 20 * 3600) heard = false;
    if (shape.staleFor !== undefined && age < shape.staleFor) heard = false;
    if (off) {
      buckets.push({ t, n: 0, expected: 0, fail: 0 });
      continue;
    }
    if (!heard || runs === 0) {
      buckets.push({ t, n: 0, expected, fail: 0 });
      continue;
    }
    // The step in progress never expects fewer runs than it has heard.
    const heardExpected = Math.max(expected, runs);
    // A stray failed run now and then, never in the newest minutes (a check's state reads its newest run).
    let failShare = j > 0.997 && age > 600 ? 1 / runs : 0;
    if (behaviourNow === "nat") failShare = 1;
    if (behaviourNow === "offline") failShare = age < 30 * 3600 ? 1 : j > 0.9 ? 1 / runs : 0;
    if (behaviourNow === "lossy") failShare = 0.04 + j * 0.08;
    if (behaviourNow === "burst" && age > 22 * 3600 && age < 24 * 3600) failShare = 0.3 + j * 0.3;
    if (behaviourNow === "filtered") failShare = 1;
    let fail = Math.min(runs, Math.round(runs * failShare));
    // Design 29 M3: the recent spell, minute by minute, so an hour of one-minute buckets holds the share it should.
    const spell = (share: number, within: number) => {
      let n = 0;
      for (let m = 0; m < runs; m++) {
        const minuteAge = age - m * 60;
        if (minuteAge < within && minuteAge > 0 && failsMinute(shape, Math.floor((t + m * 60) / 60), share)) n += 1;
      }
      return n;
    };
    if (shape.recent === "loss") fail = Math.min(runs, fail + spell(0.075, 52 * 60));
    if (shape.recent === "both") fail = Math.min(runs, fail + spell(0.26, 48 * 60));
    if (shape.recent === "sourceDown" && age < 3 * 3600) fail = runs;
    const bucket: PathBucket = { t, n: runs, expected: heardExpected, fail, loss: fail / runs };
    if (packets) {
      // Every echo of a failed run is lost; a run that came back may still lose one now and then.
      const sent = runs * packets;
      const stray = behaviourNow === "filtered" ? 0 : j > 0.93 ? 1 + Math.floor((j - 0.93) * 30) : 0;
      const lost = Math.min(sent, fail * packets + stray);
      bucket.sent = sent;
      bucket.lost = lost;
      bucket.loss = lost / sent;
    }
    if (fail < runs) {
      const local = new Date((t + 8 * 3600) * 1000).getUTCHours();
      const evening = local >= 19 && local <= 23 ? 1.28 + j * 0.12 : 1;
      // ICMP is answered by the kernel: a little faster than a TCP handshake to the same node.
      const base = shape.operator === "tls" ? 82 : shape.operator === "http" ? 118 : baseMs(shape.target, shape.source) * (packets ? 0.94 : 1);
      const burst = behaviourNow === "burst" && age > 22 * 3600 && age < 24 * 3600 ? 1.6 : 1;
      // Design 29 M3: a slow spell, ongoing (latency, both) or over five minutes ago and clearing.
      const slow = (shape.recent === "latency" && age < 38 * 60) || (shape.recent === "clearing" && age < 75 * 60 && age > 5 * 60) ? 2.4 : shape.recent === "both" && age < 26 * 60 ? 2.1 : 1;
      const p50 = (base + j * 9) * evening * burst * slow;
      bucket.p50_ms = Math.round(p50 * 10) / 10;
      bucket.p95_ms = Math.round(p50 * (1.12 + j * 0.35) * 10) / 10;
      bucket.min_ms = Math.round(p50 * (0.9 - j * 0.04) * 10) / 10;
      bucket.max_ms = Math.round(bucket.p95_ms * (1.08 + j * 0.3) * 10) / 10;
      bucket.jitter_ms = Math.round(p50 * (0.02 + j * 0.05) * 10) / 10;
    }
    if (SWITCH && shape.target?.name === "[cd]-gomami-hk-turin-mini") bucket.method = age < 2 * 86400 ? "icmp" : "tcp";
    if (shape.switchedAt !== undefined) bucket.method = switched ? "tcp" : shape.method;
    buckets.push(bucket);
  }
  return { step, from, to, buckets };
}

function shapeFor(plan: LatencyProbePlan, source: string, targetNode: string): Shape {
  const target = allNodes().find((n) => n.id === targetNode);
  const shape = baseShapeFor(plan, source, targetNode, target);
  // Design 29 M3: the spells and stale paths the evaluator and triangulation read.
  const recent = m3Recent(source, target?.name);
  if (recent) shape.recent = recent;
  if (m3Stale(source, target?.name)) shape.staleFor = STALE_FOR;
  const born = m3BornAgo(source, target?.name);
  if (born !== undefined) shape.bornAgo = born;
  return shape;
}

function baseShapeFor(plan: LatencyProbePlan, source: string, targetNode: string, target: Node | undefined): Shape {
  const pair = plan.pairs.find((p) => p.source === source && p.target === targetNode);
  const icmp = pair?.method === "icmp";
  const beacon = pair?.method === "beacon";
  let b = behaviour(target?.name ?? "");
  if (beacon) {
    // The beacon answers on the mapped endpoint, so a NAT target that failed over TCP reads up; hetzner-hel's provider drops UDP.
    const before = b;
    const shape = beaconShape(target?.name);
    if (b === "nat" || b === "offline") b = "normal";
    if (shape.reach === "filtered") b = "filtered";
    if (shape.agent !== "listening") b = "never";
    if (pair?.reason) b = "never";
    return {
      target,
      source,
      behaviour: b,
      pausedSince: pair && !pair.enabled ? 2 * 86400 : undefined,
      packets: 5,
      method: "beacon",
      // An Auto path set moved the pair from TCP when the beacon came up, two days ago.
      ...(M2A === "auto" && before === "nat" && !pair?.reason ? { switchedAt: BEACON_SWITCH_AGE, before: "nat" as const } : {}),
    };
  }
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
    method: icmp ? "icmp" : "tcp",
  };
}

/* ---- Design 29 M3: the evaluator's view of a path ---- */

const ruleOf = (rule: MonitorDegradedRule | undefined) => ({
  lossPercent: rule?.loss_percent || 2,
  lossFactor: rule?.loss_factor || 2,
  latencyFactor: rule?.latency_factor || 2,
  latencyMarginMs: rule?.latency_margin_ms || 30,
});

function median(values: number[]): number | undefined {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The 7-day baseline as the server reads it (D13): the whole hours before
 * the current one, the hours with runs in them, the merged p50 and loss, and
 * the triggers once 24 hours are in.
 */
function baselineFor(shape: Shape, rule: MonitorDegradedRule | undefined): PathBaseline {
  const hourStart = Math.floor(NOW / 3_600_000) * 3600;
  const week = bucketsFor(shape, "7d");
  const inWindow = week.buckets.filter((b) => Number(b.t) < hourStart && Number(b.t) >= hourStart - 7 * 86400);
  const hours = new Set(inWindow.filter((b) => b.n > 0).map((b) => Math.floor(Number(b.t) / 3600))).size;
  const stats = seriesStats(seriesFromResponse({ window: "7d", step_seconds: week.step, from: week.from, to: week.to, buckets: inWindow }).points);
  const r = ruleOf(rule);
  const ready = hours >= 24;
  const p50 = stats.p50Ms !== undefined ? round1(stats.p50Ms) : null;
  const loss = stats.loss !== undefined ? round4(stats.loss) : null;
  return {
    from: new Date((hourStart - 7 * 86400) * 1000).toISOString(),
    to: new Date(hourStart * 1000).toISOString(),
    hours,
    ready,
    p50_ms: p50,
    loss,
    trigger_p50_ms: ready && p50 !== null ? round1(Math.max(r.latencyFactor * p50, p50 + r.latencyMarginMs)) : null,
    trigger_loss: ready ? round4(Math.max(r.lossPercent / 100, r.lossFactor * (loss ?? 0))) : null,
    rule: { loss_percent: r.lossPercent, loss_factor: r.lossFactor, latency_factor: r.latencyFactor, latency_margin_ms: r.latencyMarginMs },
  };
}

/** The degradation record the evaluator would hold for a path with a recent spell, or undefined. */
function degradationFor(shape: Shape, rule: MonitorDegradedRule | undefined): { reason: string; degraded: PathDegradation } | undefined {
  const recent = shape.recent;
  if (!recent || recent === "sourceDown") return undefined;
  const base = baselineFor(shape, rule);
  if (!base.ready) return undefined;
  const raw = bucketsFor(shape, "1h").buckets;
  const now = NOW / 1000;
  let sent = 0;
  let lost = 0;
  for (const b of raw) {
    sent += b.sent || b.n;
    lost += b.sent ? (b.lost ?? 0) : b.fail;
  }
  const last15 = raw.filter((b) => Number(b.t) >= now - 900 && b.n > b.fail && b.p50_ms != null);
  const p50 = median(last15.map((b) => b.p50_ms!));
  const runs = last15.reduce((n, b) => n + b.n - b.fail, 0);
  const minute = (m: number) => new Date(NOW - m * 60_000).toISOString();
  const loss = sent > 0 ? { value: round4(lost / sent), baseline: base.loss ?? 0, trigger: base.trigger_loss ?? 0.02, sent, lost } : undefined;
  const latency = p50 !== undefined && base.p50_ms != null && base.trigger_p50_ms != null ? { p50_ms: round1(p50), runs, baseline_ms: base.p50_ms, trigger_ms: base.trigger_p50_ms } : undefined;
  switch (recent) {
    case "loss":
      return { reason: "degraded_loss", degraded: { since: minute(51), evaluated_at: minute(0.5), loss } };
    case "latency":
      return { reason: "degraded_latency", degraded: { since: minute(36), evaluated_at: minute(0.5), latency } };
    case "both":
      return { reason: "degraded_loss_latency", degraded: { since: minute(24), evaluated_at: minute(0.5), loss, latency } };
    case "clearing": {
      // The condition went away five minutes ago; the evidence is the last evaluation that found it.
      const slow = { p50_ms: round1((base.p50_ms ?? 150) * 2.4), runs: 15, baseline_ms: base.p50_ms ?? 150, trigger_ms: base.trigger_p50_ms ?? 300 };
      return { reason: "degraded_latency", degraded: { since: minute(73), evaluated_at: minute(5), clearing_since: minute(4), latency: slow } };
    }
  }
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
    // Design 29 M3: pages on degraded too, with thresholds of its own.
    ...(M3 ? { alert: "down_and_degraded", alert_after: 3, degraded: STATUS_RULE } : {}),
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
  // An agent older than M2a among its sources: its path reads agent_too_old, as the server gates headers.
  status.node_ids = [...(status.node_ids ?? []), id("[cd]-volcengine-shanghai")];
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
  if (!M2B || !jp) return [status, cert, ping, admin];
  // Design 29 M2b: a Beacon check to the NAT node, from a source its plan admits and three that cannot measure.
  const beacon: MonitorView = {
    id: "mon_beacon_jp",
    name: "Beacon to [cd]-xuezhang-jp-nat",
    type: "beacon",
    target: `${jp.public_ip ?? "203.0.113.12"}:${beaconShape(jp.name).mappedPort}`,
    target_node: jp.id,
    packets: 5,
    interval_sec: 30,
    timeout_sec: 2,
    assign_all: false,
    node_ids: [SOURCE_ID, id("[cd]-hetzner-fsn"), id("[Metix]-mkcloud-hr-iplc"), id("[cd]-DMIT-pro-malibu")].sort(),
    enabled: true,
    created_at: iso(-26 * HOUR),
    version: 1,
    alert: "down",
    alert_after: 3,
  };
  return [status, cert, ping, admin, beacon];
}

/** Why an operator check's source measures nothing (design 29 M2a), or undefined. */
function operatorReason(check: MonitorView, source: string): string | undefined {
  if (!M2A) return undefined;
  if (check.type === "icmp") return icmpRefusal(allNodes().find((n) => n.id === source));
  if (check.type === "beacon") {
    // As the server's gates: the beacon client, then the target's beacon, then whether its plan admits the source.
    const from = allNodes().find((n) => n.id === source);
    if (!runsBeaconClient(from?.name)) return "agent_too_old";
    const shape = beaconShape(allNodes().find((n) => n.id === check.target_node)?.name);
    const gate = beaconTargetGate(shape) || beaconSourceGate(shape, from?.name === "cd-hs-sh" ? "cd-hs-sh" : (from?.name ?? ""));
    if (gate) return gate;
    // DMIT-pro-malibu's clock runs two minutes fast: the target answers stale.
    return from?.name === "[cd]-DMIT-pro-malibu" ? "beacon_stale" : undefined;
  }
  if (check.id === "mon_admin_internal") return "destination_refused";
  // As the server's monitorProbeGate: headers or a status set other than the default need an agent that reports its methods.
  const current = check.type === "http" && (!!check.headers?.length || (!!check.expect_status && check.expect_status !== "200-399"));
  if (current && agentPredatesM2a(allNodes().find((n) => n.id === source))) return "agent_too_old";
  return undefined;
}

function operatorShape(check: MonitorView, source: string, paused: boolean): Shape {
  const reason = operatorReason(check, source);
  const multi = check.type === "icmp" || check.type === "beacon";
  return {
    source,
    target: multi ? allNodes().find((n) => n.id === check.target_node) : undefined,
    behaviour: reason ? "never" : "normal",
    operator: check.type === "tls" ? "tls" : check.type === "icmp" ? "icmp" : check.type === "beacon" ? "beacon" : "http",
    packets: multi ? check.packets || 5 : undefined,
    method: check.type === "beacon" ? "beacon" : check.type === "icmp" ? "icmp" : undefined,
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
      out.push(pathFrom(shape, window, { source, target: check.target, ...(check.target_node ? { target_node: check.target_node } : {}), monitor_id: check.id, managed: false, method: check.type }, reason, undefined, check.degraded ?? undefined));
    }
  }
  return out;
}

/* ---- The matrix ---- */

function pathFrom(shape: Shape, window: MonitorWindow, base: Omit<PathView, "state" | "samples" | "expected">, unknownReason?: string, downReason?: string, rule?: MonitorDegradedRule): PathView {
  // The window's figures are its whole buckets before the one in progress; the newest run may sit in that one.
  const now = bucketsFor(shape, window, 0, true);
  const prev = bucketsFor(shape, window, WINDOW_SECONDS[window], true);
  const series = bucketsFor(shape, window);
  const stats = seriesStats(seriesFromResponse({ window, step_seconds: now.step, from: now.from, to: now.to, buckets: now.buckets }).points);
  const prevStats = seriesStats(seriesFromResponse({ window, step_seconds: prev.step, from: prev.from, to: prev.to, buckets: prev.buckets }).points);
  const last = [...series.buckets].reverse().find((b) => b.n > 0);
  // As the server sends a cell: every figure present, null where nothing was measured, and an empty reason.
  const path: PathView = {
    ...base,
    state: "up",
    reason: "",
    samples: stats.samples,
    expected: stats.expected,
    p50_ms: stats.p50Ms ?? null,
    p95_ms: stats.p95Ms ?? null,
    jitter_ms: stats.jitterMs !== undefined ? Math.round(stats.jitterMs * 10) / 10 : null,
    loss: stats.loss !== undefined ? Math.round(stats.loss * 10000) / 10000 : null,
    prev: prevStats.samples > 0 ? { p50_ms: prevStats.p50Ms ?? null, loss: prevStats.loss !== undefined ? Math.round(prevStats.loss * 10000) / 10000 : null } : null,
    // The newest run lands at the half minute of its step; the step in progress may hold one already.
    last_at: last ? new Date(Math.min(NOW, (Number(last.t) + 30 + Math.max(0, last.n - 1) * 60) * 1000)).toISOString() : null,
  };
  if (unknownReason) return { ...path, state: "unknown", reason: unknownReason };
  // The server sends a down path without a reason; the error is in the path's runs.
  if (downReason) return { ...path, state: "down", reason: "" };
  if (!last) return { ...path, state: "unknown", reason: "no_results" };
  // Design 29 M3: degraded only where the path would read up (down and unknown win).
  const degraded = M3 ? degradationFor(shape, rule) : undefined;
  if (degraded) return { ...path, state: "degraded", reason: degraded.reason, degraded: degraded.degraded };
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
      const beacon = pair?.method === "beacon";
      const base = {
        source,
        target_node: target.node_id,
        // ICMP dials an address, not a port; a beacon its advertised endpoint.
        target: beacon ? (target.beacon_target ?? "") : node ? (icmp ? (node.public_ip ?? "") : natEndpoint(node)) : (target.endpoint ?? ""),
        monitor_id: pair?.monitor_id ?? target.monitor_id ?? `mon_lat_${target.node_id}`,
        managed: true,
        method: beacon ? "beacon" : icmp ? "icmp" : "tcp",
      };
      // The target reports no socket where its plan put one (the server's beaconTargetListenGate).
      const agent = beacon ? beaconShape(node?.name).agent : undefined;
      if (beacon && !pair?.reason && (agent === "bind_failed" || agent === "circuit_open") && pair?.enabled && plan.config.enabled) {
        paths.push(pathFrom({ ...shape, behaviour: "never" }, window, base, "beacon_not_listening"));
        continue;
      }
      // The source cannot run the pair's method (design 29 M2a): unknown with the reason, never down.
      if (pair?.reason && pair.reason !== "not_probeable" && pair.enabled && plan.config.enabled) {
        paths.push(pathFrom(shape, window, base, pair.reason));
        continue;
      }
      if (target.target === "not_probeable" || (pair?.reason === "not_probeable" && !icmp)) {
        // The server says not_probeable whatever the plan's note (udp_only, no_public_address, no_tcp_line).
        paths.push({ ...base, target: "", monitor_id: "", state: "unknown", reason: "not_probeable", p50_ms: null, p95_ms: null, jitter_ms: null, loss: null, samples: 0, expected: 0, prev: null, last_at: null });
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
      // Design 29 M3: results that stopped read unknown before anything else the path did (the server's order).
      if (shape.staleFor !== undefined) {
        paths.push(pathFrom(shape, window, base, "results_stopped"));
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
      // Design 29 M3: a source that fails targets the others reach, and paths whose results stopped.
      if (shape.recent === "sourceDown") {
        paths.push(pathFrom(shape, window, base, undefined, `read tcp ${base.target}: connection reset by peer`));
        continue;
      }

      if (b === "filtered") {
        paths.push(pathFrom(shape, window, base, beacon ? "beacon_filtered" : "icmp_filtered"));
        continue;
      }
      paths.push(pathFrom(shape, window, base, undefined, undefined, plan.config.degraded ?? undefined));
    }
  }
  paths.push(...operatorPaths(checks, window));
  // As the server's matrix (monitor_paths.go, held to the golden responses): the sources and targets its
  // paths name, each sorted by name then id, the control plane among the sources with no id and its own
  // English name; the paths the path set generated first, then by target node, target, source and check.
  const byName = (a: { node_id: string; name: string }, b: { node_id: string; name: string }) => compare(a.name, b.name) || compare(a.node_id, b.node_id);
  const planNode = new Map(plan.nodes.map((n) => [n.node_id, n]));
  const sourceViews = [...new Set(paths.map((p) => p.source))]
    .map((s) => (s ? { node_id: s, name: shownName(byId.get(s)?.name ?? s), region: planNode.get(s)?.region ?? "unknown" } : { node_id: "", name: "Control plane", region: "" }))
    .sort(byName);
  const targetViews = [...new Set(paths.map((p) => p.target_node ?? "").filter(Boolean))]
    .map((id) => {
      const node = byId.get(id);
      const name = planNode.get(id)?.name ?? node?.name ?? id;
      return { node_id: id, name: shownName(name), region: planNode.get(id)?.region ?? "unknown", country: node?.geo?.country ?? COUNTRY[name] ?? planNode.get(id)?.country };
    })
    .sort(byName);
  paths.sort((a, b) => Number(b.managed) - Number(a.managed) || compare(a.target_node ?? "", b.target_node ?? "") || compare(a.target, b.target) || compare(a.source, b.source) || compare(a.monitor_id, b.monitor_id));
  return {
    window,
    observed_at: iso(-12_000),
    // Design 29 M3: when the degraded evaluator last ran; the key's presence is what marks the server.
    ...(M3 ? { degraded_at: iso(-31_000) } : {}),
    sources: sourceViews,
    targets: targetViews,
    paths,
  };
}

/** Go's string order, bytewise, which the server sorts its matrix by (the names here are ASCII). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A time as the server writes it: RFC 3339 in UTC, without a fraction on a whole second. */
function rfc3339(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.000Z$/, "Z");
}

export function seriesFor(plan: LatencyProbePlan, checks: MonitorView[], query: PathSeriesQuery): PathSeriesResponse {
  let shape: Shape;
  let rule: MonitorDegradedRule | undefined = plan.config.degraded ?? undefined;
  let tls = false;
  if (query.monitor && !query.target_node) {
    const check = checks.find((c) => c.id === query.monitor);
    const paused = (check?.paused_node_ids ?? []).includes(query.source);
    shape = check ? operatorShape(check, query.source, paused) : { source: query.source, behaviour: "normal", operator: "http" };
    rule = check?.degraded ?? undefined;
    tls = check?.type === "tls";
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
  // The method in force at the first bucket heard, then the switch when it falls inside the window.
  const switchAt = Math.floor((NOW / 1000 - 2 * 86400) / step) * step;
  // A beacon that replaced TCP: the first bucket that ran it.
  const beaconAt = shape.switchedAt !== undefined ? Math.ceil((NOW / 1000 - shape.switchedAt) / step) * step : undefined;
  const first = switched
    ? Number(firstHeard) >= switchAt
      ? "icmp"
      : "tcp"
    : beaconAt !== undefined
      ? Number(firstHeard) >= beaconAt
        ? "beacon"
        : "tcp"
      : query.monitor && !query.target_node
        ? (checks.find((c) => c.id === query.monitor)?.type ?? "tcp")
        : (shape.method ?? (shape.packets ? "icmp" : "tcp"));
  const method_changes = [{ t: Number(firstHeard), method: first }];
  if (switched && Number(firstHeard) < switchAt) method_changes.push({ t: switchAt, method: "icmp" });
  if (beaconAt !== undefined && Number(firstHeard) < beaconAt) method_changes.push({ t: beaconAt, method: "beacon" });
  // Every time as the server writes it (RFC 3339), never unix seconds.
  const out: PathSeriesResponse = {
    window: query.window,
    step_seconds: step,
    from: rfc3339(from),
    to: rfc3339(to),
    method_changes: method_changes.map((c) => ({ t: rfc3339(c.t), method: c.method })),
    buckets: buckets.map((b) => ({ ...b, t: rfc3339(Number(b.t)) })),
  };
  if (M3) {
    // A certificate check is never judged; every other path carries the baseline it is judged on.
    out.baseline = tls ? null : baselineFor(shape, rule);
    if (query.compare === "previous") {
      const prev = bucketsFor(shape, query.window, WINDOW_SECONDS[query.window]);
      out.previous = {
        from: rfc3339(prev.from),
        to: rfc3339(prev.to),
        offset_seconds: WINDOW_SECONDS[query.window],
        step_seconds: prev.step,
        p50_ms: buckets.map((_, i) => {
          const b = prev.buckets[i];
          // Invented: the week before ran a little faster, so the overlay reads apart from the line.
          return b && b.n > b.fail && b.p50_ms != null ? Math.round(b.p50_ms * 0.82 * 10) / 10 : null;
        }),
      };
    }
  }
  return out;
}

/** The raw runs the results route serves for a path: the last twenty per source. */
export function resultsFor(plan: LatencyProbePlan, checks: MonitorView[], monitorId: string): MonitorResult[] {
  const check = checks.find((c) => c.id === monitorId);
  const out: MonitorResult[] = [];
  const push = (source: string, shape: Shape, endpoint: string, reason?: string) => {
    // An agent too old for the method, or a source the target's beacon does not admit, is never handed the check.
    if (reason === "agent_too_old" || reason === "firewall_pending" || reason === "beacon_source_pending") return;
    if (reason) {
      // A run that measured nothing: no latency, and the reason instead of a failure.
      for (let i = 0; i < 12; i++) {
        const signed = reason.startsWith("beacon_") && reason !== "beacon_no_key";
        out.push({
          monitor_id: monitorId,
          node_id: source,
          at: new Date(NOW - (i * 60 + 25) * 1000).toISOString(),
          success: false,
          reason,
          // A signed refusal (stale, old key, rate limited) came back for every request: all sent, none answered ok.
          ...(reason === "destination_refused" ? { error: `refused to dial 10.0.0.8: private address` } : signed ? { sent: shape.packets ?? 5, lost: shape.packets ?? 5 } : { sent: 0 }),
        });
      }
      return;
    }
    const { buckets } = bucketsFor(shape, "1h");
    for (const [i, b] of buckets.slice(-20).entries()) {
      if (!b.n) continue;
      const failed = b.fail >= b.n;
      if (shape.packets) {
        // Five echoes: the RTT of each one that came back, in send order, and the median as the run's latency.
        const sent = shape.packets;
        // The fourth newest run lost an echo, so the list shows what a partial loss looks like.
        const lost = failed ? sent : Math.min(sent, Math.round(((b.lost ?? 0) / Math.max(1, b.sent ?? 1)) * sent) + (i === 16 && shape.behaviour !== "filtered" ? 1 : 0));
        const p50 = b.p50_ms ?? 60;
        const rtts = Array.from({ length: sent - lost }, (_, k) => Math.round(p50 * (0.96 + hash(`${source}:${b.t}:${k}`) * 0.1) * 10) / 10);
        const sorted = [...rtts].sort((x, y) => x - y);
        const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : undefined;
        const silent = shape.method === "beacon" ? `no reply from ${endpoint} within ${2}s` : `no echo reply from ${endpoint}`;
        out.push({ monitor_id: monitorId, node_id: source, at: new Date((Number(b.t) + 30) * 1000).toISOString(), success: rtts.length > 0, latency_ms: median, sent, lost, rtts_ms: rtts.length ? rtts : undefined, error: rtts.length ? undefined : silent });
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
  const target = plan.nodes.find((n) => n.monitor_id === monitorId || n.icmp_monitor_id === monitorId || n.beacon_monitor_id === monitorId);
  if (!target) return out;
  const node = allNodes().find((n) => n.id === target.node_id);
  for (const pair of plan.pairs.filter((p) => p.target === target.node_id && p.active && (p.monitor_id ?? target.monitor_id) === monitorId)) {
    if (sourceOffline(pair.source)) continue;
    const endpoint = pair.method === "beacon" ? (target.beacon_target ?? "") : node ? (pair.method === "icmp" ? (node.public_ip ?? "") : natEndpoint(node)) : "";
    push(pair.source, shapeFor(plan, pair.source, target.node_id), endpoint);
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

/* ---- ?m3=golden: the server's own answers ---- */

/** A copy, so a view that changes what it was handed never changes the golden. */
const copy = <T>(value: T): T => structuredClone(value);

/** The matrix the server answered for the window, or undefined for a window it was not asked for. */
export function goldenPaths(window: MonitorWindow): PathsResponse | undefined {
  if (window === "1h") return copy(GOLDEN_PATHS_1H);
  if (window === "7d") return copy(GOLDEN_PATHS_7D);
  return undefined;
}

/** The one series the server answered, without `previous` when the read did not ask for it; undefined for any other path. */
export function goldenSeries(query: PathSeriesQuery): PathSeriesResponse | undefined {
  const want = GOLDEN_SERIES_QUERY;
  if (query.source !== want.source || query.target_node !== want.target_node || query.monitor || query.window !== want.window) return undefined;
  const series = copy(GOLDEN_SERIES);
  if (query.compare !== "previous") delete series.previous;
  return series;
}

export function goldenMonitors(): MonitorView[] {
  return copy(GOLDEN_MONITORS);
}

export function goldenPlan(): LatencyProbePlan {
  return copy(GOLDEN_PATH_SET);
}

/** The path set's four nodes as the node list would carry them, on a template node: invented, as the header says. */
export function goldenNodes(template: Node): Node[] {
  return GOLDEN_PATH_SET.nodes.map((n) => ({
    ...template,
    id: n.node_id,
    name: n.name,
    tags: [],
    public_ip: n.icmp_target ?? template.public_ip,
    geo: { country: n.country ?? "" },
    online: true,
    status: "online",
    last_seen: new Date(Date.now() - 4_000).toISOString(),
  }));
}
