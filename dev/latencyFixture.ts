/**
 * Latency probes for the fleet harness (dev/fleet-monitoring.html?view=latency,
 * and the latency card on dev/fleet-node.html). Built on the fleet fixture's
 * nodes plus one node named cd-hs-sh in Shanghai, the source the operator
 * named; every latency, loss and gap below is invented.
 *
 * `?latency=` picks the shape:
 *   one (default)  cd-hs-sh probes 20 overseas targets: 15 measured across
 *                  every colour band, one lossy, one all failing, one heard
 *                  for a fifth of the hour, one offline node on its last known
 *                  address (no data this hour), one pair stopped with its
 *                  history, one UDP-only target and one NAT target with
 *                  nothing public to dial; the other overseas nodes excluded
 *   three          the same with two more Chinese sources
 *   defaults       nothing saved: the defaults from cd-hs-sh to every node
 *                  outside mainland China
 *   nosource       nothing saved and no node named cd-hs-sh
 *   off            saved, probes paused
 *
 * The plan is computed from a configuration by the server's rule, so saving
 * the probe settings in the harness changes the matrix the way a save would.
 */
import type {
  LatencyBucket,
  LatencyProbeConfig,
  LatencyProbeNode,
  LatencyProbePairState,
  LatencyProbePlan,
  LatencyRollups,
  LatencySeries,
  LatencyStats,
  LatencyWindow,
  MonitorView,
  Node,
} from "@/lib/api/index";

import { HOUR, MINUTE, NODES, NOW, PARAMS, iso, nodeByName } from "./fleetFixture";

export const LATENCY_SHAPE = (PARAMS.get("latency") ?? "one") as "one" | "three" | "defaults" | "nosource" | "off";
export const SOURCE_ID = "node_sh";
export const SOURCE_NAME = "cd-hs-sh";

/** cd-hs-sh, added to the node list only on latency renders so other harness counts stay at 34. */
export const SOURCE_NODE: Node | undefined =
  LATENCY_SHAPE === "nosource" || !PARAMS.has("latency")
    ? undefined
    : ({
        ...NODES.find((n) => n.name === "[cd]-volcengine-shanghai")!,
        id: SOURCE_ID,
        name: SOURCE_NAME,
        tags: ["cd", "HOME"],
        public_ip: "203.0.113.200",
        geo: { country: "CN", region: "Shanghai", city: "Shanghai", lat: 31.2, lon: 121.5, source: "operator" },
      } as Node);

const id = (name: string) => nodeByName(name)?.id ?? name;

/** Nodes with nothing a TCP probe may dial, and why. */
const NOT_PROBEABLE: Record<string, string> = {
  "[cd]-Oracle-KIX-arm": "udp_only",
  "[Metix]-Aaitr-Frontier-NAT": "no_public_address",
};
/** Offline nodes keep the address their monitor had. */
const LAST_KNOWN = new Set(["[Metix]-DMIT-4"]);

/**
 * `?topo=many`: 280 more invented nodes across nine cities, so the Topology
 * layer can be drawn at a few hundred targets (each country folds into one
 * row). Every fifteenth is offline; a few have no country.
 */
const MANY_PLACES: [country: string, city: string, lat: number, lon: number][] = [
  ["US", "Los Angeles", 34.05, -118.24],
  ["US", "San Jose", 37.34, -121.89],
  ["JP", "Tokyo", 35.68, 139.69],
  ["HK", "Hong Kong", 22.32, 114.17],
  ["SG", "Singapore", 1.35, 103.82],
  ["DE", "Falkenstein", 50.48, 12.37],
  ["GB", "London", 51.5, -0.12],
  ["AU", "Sydney", -33.87, 151.2],
  ["KR", "Seoul", 37.57, 126.98],
];
export const EXTRA_NODES: Node[] =
  PARAMS.get("topo") === "many" && NODES.length
    ? Array.from({ length: 280 }, (_, i) => {
        const place = MANY_PLACES[i % MANY_PLACES.length]!;
        const offline = i % 15 === 7;
        return {
          ...NODES[0]!,
          id: `node_x${String(i).padStart(3, "0")}`,
          name: `[bulk]-${place[1].toLowerCase().replace(/ /g, "-")}-${String(i).padStart(3, "0")}`,
          public_ip: `198.51.${100 + Math.floor(i / 250)}.${i % 250}`,
          status: offline ? "offline" : "online",
          online: !offline,
          reachability: offline ? "offline" : "online",
          last_seen: iso(offline ? -(2 + (i % 5)) * HOUR : -3000),
          geo: i % 47 === 3 ? undefined : { country: place[0], city: place[1], lat: place[2], lon: place[3], source: "auto" },
        } as Node;
      })
    : [];

function allNodes(): Node[] {
  return [...NODES, ...(SOURCE_NODE ? [SOURCE_NODE] : []), ...EXTRA_NODES];
}

function region(node: Node): string {
  const country = node.geo?.country?.toUpperCase() ?? "";
  if (!country) return "unknown";
  return country === "CN" ? "mainland" : "outside_mainland";
}

/** The 20 targets of the saved shapes; every other overseas node is excluded. */
const TARGETS = new Set([
  "[cd]-DMIT-pro-malibu", "[cd]-hetzner-fsn", "[cd]-hetzner-hel", "[cd]-racknerd-la", "[cd]-bandwagon-dc6",
  "[cd]-vultr-syd", "[cd]-linode-sgp", "[cd]-Akkocloud-UK-London-KVM", "[cd]-Oracle-KIX-arm", "[cd]-gomami-hk-turin-mini",
  "[cd]-qqpw-vds-cd1", "[cd]-xuezhang-jp-nat", "[cd]-cloudcone-la", "[Metix]-DMIT-1", "[Metix]-DMIT-4",
  "[Metix]-DMIT-eb-wee", "[Metix]-Aaitr-ATT-VDS", "[Metix]-Aaitr-Frontier-NAT", "[Metix]-VIRCS-ATT-VDS", "[OpenJobs-Data]-TiDB-1",
]);
function overseasBeyondTwenty(): string[] {
  return NODES.filter((n) => region(n) === "outside_mainland" && !TARGETS.has(n.name)).map((n) => n.id);
}

export function initialConfig(): { config: LatencyProbeConfig; stored: boolean } {
  const base: LatencyProbeConfig = { enabled: true, interval_sec: 60, timeout_sec: 5, sources: [SOURCE_ID], auto_targets: true, version: 4, updated_by: "cdcd", updated_at: iso(-3 * HOUR) };
  switch (LATENCY_SHAPE) {
    case "defaults":
      return { config: { ...base, version: 0, updated_by: undefined, updated_at: undefined }, stored: false };
    case "nosource":
      return { config: { ...base, sources: [], version: 0, updated_by: undefined, updated_at: undefined }, stored: false };
    case "three":
      return {
        config: { ...base, sources: [SOURCE_ID, id("[cd]-volcengine-shanghai"), id("[Metix]-mkcloud-hr-iplc")].sort(), exclude_targets: overseasBeyondTwenty(), disabled_pairs: [{ source: SOURCE_ID, target: id("[cd]-vultr-syd") }] },
        stored: true,
      };
    case "off":
      return { config: { ...base, enabled: false, exclude_targets: overseasBeyondTwenty() }, stored: true };
    default:
      return { config: { ...base, exclude_targets: overseasBeyondTwenty(), disabled_pairs: [{ source: SOURCE_ID, target: id("[cd]-vultr-syd") }] }, stored: true };
  }
}

/** The server's planning rule (latency_probes.go) over the fixture fleet. */
export function planFor(config: LatencyProbeConfig, stored: boolean): LatencyProbePlan {
  const nodes = allNodes().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sourceNotes: Record<string, string> = {};
  const sources: string[] = [];
  for (const sid of config.sources) {
    const node = byId.get(sid);
    if (!node) sourceNotes[sid] = "unknown_node";
    else if (node.disabled) sourceNotes[sid] = "node_disabled";
    else sources.push(sid);
  }
  const include = new Set(config.include_targets ?? []);
  const exclude = new Set(config.exclude_targets ?? []);
  const off = new Set((config.disabled_pairs ?? []).map((p) => `${p.source}~${p.target}`));
  const planNodes: LatencyProbeNode[] = [];
  const pairs: LatencyProbePairState[] = [];
  for (const node of nodes) {
    const r = region(node);
    const pn: LatencyProbeNode = { node_id: node.id, name: node.name, country: node.geo?.country, region: r, source: config.sources.includes(node.id), target: "none" };
    let target = false;
    if (exclude.has(node.id)) pn.target_reason = "excluded";
    else if (node.disabled) pn.target_reason = "node_disabled";
    else if (include.has(node.id)) [target, pn.target_reason] = [true, "included"];
    else if (!config.auto_targets) pn.target_reason = "auto_off";
    else if (r === "outside_mainland") [target, pn.target_reason] = [true, "auto"];
    else pn.target_reason = r === "mainland" ? "mainland" : "region_unknown";
    if (!target) {
      planNodes.push(pn);
      continue;
    }
    const note = NOT_PROBEABLE[node.name];
    const monitorId = `mon_lat_${node.id}`;
    const active: string[] = [];
    for (const sid of sources) {
      if (sid === node.id) continue;
      const enabled = !off.has(`${sid}~${node.id}`);
      const pair: LatencyProbePairState = { source: sid, target: node.id, enabled, active: !note && enabled && config.enabled };
      if (!note) pair.monitor_id = monitorId;
      if (pair.active) active.push(sid);
      pairs.push(pair);
    }
    if (note) {
      planNodes.push({ ...pn, target: "not_probeable", endpoint_note: note });
      continue;
    }
    pn.endpoint = `${node.public_ip ?? "203.0.113.1"}:${node.name.includes("NAT") ? 50100 : 443}`;
    pn.protocol = node.name.includes("Aaitr") ? "anytls" : "vless";
    pn.line_name = `${pn.protocol}-reality-443`;
    pn.monitor_id = monitorId;
    if (LAST_KNOWN.has(node.name)) pn.endpoint_note = "last_known";
    if (active.length > 0) pn.target = "probed";
    else {
      pn.target = "paused";
      pn.target_reason = !config.enabled ? "config_off" : sources.some((s) => s !== node.id) ? "pairs_off" : "no_source";
    }
    planNodes.push(pn);
  }
  return {
    config,
    stored,
    default_source_name: SOURCE_NAME,
    nodes: planNodes,
    pairs,
    source_notes: Object.keys(sourceNotes).length ? sourceNotes : undefined,
  };
}

/* ---- Rollups and series ---- */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/** Base handshake time from China to a city, invented but in the right order of magnitude. */
function baseMs(node: Node | undefined): number {
  switch (node?.geo?.city) {
    case "Hong Kong":
      return 34;
    case "Tokyo":
    case "Osaka":
      return 68;
    case "Singapore":
      return 82;
    case "Los Angeles":
      return 156;
    case "San Jose":
      return 164;
    case "Honolulu":
      return 198;
    case "Sydney":
      return 142;
    case "London":
      return 226;
    case "Falkenstein":
      return 241;
    case "Helsinki":
      return 268;
    default:
      return 120;
  }
}

/** What happened on a pair, by target name. */
function behaviour(targetName: string): "normal" | "lossy" | "failing" | "partial" | "dark" {
  if (targetName === "[Metix]-Aaitr-ATT-VDS") return "lossy";
  if (targetName === "[Metix]-VIRCS-ATT-VDS") return "failing";
  if (targetName === "[cd]-cloudcone-la") return "partial";
  if (LAST_KNOWN.has(targetName)) return "dark";
  return "normal";
}

const WINDOW_MS: Record<LatencyWindow, number> = { "1h": HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR };

function statsFor(source: string, target: Node | undefined, window: LatencyWindow, intervalSec: number): LatencyStats {
  const expected = Math.floor(WINDOW_MS[window] / (intervalSec * 1000));
  const kind = behaviour(target?.name ?? "");
  const offset = source === SOURCE_ID ? 0 : source.endsWith("1") ? 9 : -6;
  const jitter = hash(`${source}:${target?.id}:${window}`);
  let samples = expected;
  if (kind === "partial") samples = window === "1h" ? Math.round(expected * 0.2) : Math.round(expected * (window === "24h" ? 0.02 : 0.003));
  if (kind === "dark") samples = window === "1h" ? 0 : Math.round(expected * (window === "24h" ? 0.6 : 0.86));
  if (samples === 0) return { samples: 0, failures: 0, expected };
  let lossShare = jitter < 0.7 ? 0 : jitter * 0.02;
  if (kind === "lossy") lossShare = window === "1h" ? 0.35 : window === "24h" ? 0.12 : 0.04;
  if (kind === "failing") lossShare = window === "1h" ? 1 : window === "24h" ? 0.3 : 0.06;
  const failures = Math.round(samples * lossShare);
  const stats: LatencyStats = { samples, failures, expected, loss: Math.round((failures / samples) * 10000) / 10000 };
  if (failures < samples) {
    const p50 = baseMs(target) + offset + jitter * 18 + (window === "7d" ? 4 : 0);
    stats.p50_ms = Math.round(p50 * 10) / 10;
    stats.p95_ms = Math.round((p50 * (1.18 + jitter * 0.4)) * 10) / 10;
  }
  return stats;
}

export function rollupsFor(plan: LatencyProbePlan): LatencyRollups {
  const byId = new Map(allNodes().map((n) => [n.id, n]));
  const pairs = plan.pairs
    .filter((p) => p.monitor_id)
    .map((p) => {
      const target = byId.get(p.target);
      const windows = Object.fromEntries((["1h", "24h", "7d"] as LatencyWindow[]).map((w) => [w, statsFor(p.source, target, w, plan.config.interval_sec)]));
      const hour = windows["1h"]!;
      // A pair that went dark keeps its last result, from the day its target stopped answering.
      const darkLatest = behaviour(target?.name ?? "") === "dark" ? { monitor_id: p.monitor_id!, node_id: p.source, at: iso(-(6 * 24 + 3) * HOUR), success: true, latency_ms: baseMs(target) } : undefined;
      const latest =
        hour.samples === 0
          ? darkLatest
          : { monitor_id: p.monitor_id!, node_id: p.source, at: iso(-25_000), success: hour.p50_ms !== undefined && behaviour(target?.name ?? "") !== "failing", latency_ms: hour.p50_ms, error: behaviour(target?.name ?? "") === "failing" ? `dial tcp ${plan.nodes.find((n) => n.node_id === p.target)?.endpoint}: i/o timeout` : undefined };
      return { source: p.source, target: p.target, monitor_id: p.monitor_id!, windows, latest };
    });
  return { generated_at: new Date(NOW).toISOString(), interval_sec: plan.config.interval_sec, pairs };
}

const BUCKET: Record<LatencyWindow, number> = { "1h": MINUTE, "24h": 5 * MINUTE, "7d": HOUR };

export function seriesFor(plan: LatencyProbePlan, source: string, target: string, window: LatencyWindow): LatencySeries {
  const node = allNodes().find((n) => n.id === target);
  const kind = behaviour(node?.name ?? "");
  const step = BUCKET[window];
  const to = NOW;
  const from = Math.floor((to - WINDOW_MS[window]) / step) * step;
  const perBucket = Math.max(1, Math.round(step / (plan.config.interval_sec * 1000)));
  const buckets: LatencyBucket[] = [];
  let index = 0;
  for (let at = from; at <= to; at += step, index++) {
    const age = to - at;
    const j = hash(`${source}:${target}:${window}:${index}`);
    // A short outage of the control plane two thirds of the way back, heard by nobody.
    const gap = window !== "1h" && age > WINDOW_MS[window] * 0.62 && age < WINDOW_MS[window] * 0.66;
    let heard = !gap;
    if (kind === "dark") heard = heard && age > HOUR;
    if (kind === "partial") heard = age < 12 * MINUTE;
    if (!heard) {
      buckets.push({ at: new Date(at).toISOString(), samples: 0, failures: 0, expected: perBucket });
      continue;
    }
    let failures = j > 0.93 ? 1 : 0;
    if (kind === "lossy") failures = Math.round(perBucket * (age < HOUR ? 0.35 : 0.08) + (j > 0.5 ? 1 : 0));
    if (kind === "failing") failures = age < 40 * MINUTE ? perBucket : j > 0.8 ? 1 : 0;
    failures = Math.min(perBucket, failures);
    const b: LatencyBucket = { at: new Date(at).toISOString(), samples: perBucket, failures, expected: perBucket, loss: failures / perBucket };
    if (failures < perBucket) {
      const evening = Math.sin((at / (24 * HOUR)) * Math.PI * 2) > 0.6 ? 1.35 : 1;
      const p50 = (baseMs(node) + j * 14) * evening;
      b.p50_ms = Math.round(p50 * 10) / 10;
      b.p95_ms = Math.round(p50 * (1.15 + j * 0.3) * 10) / 10;
    }
    buckets.push(b);
  }
  return { source, target, monitor_id: `mon_lat_${target}`, window, bucket_sec: step / 1000, from: new Date(from).toISOString(), to: new Date(to).toISOString(), buckets };
}

/** The tcp monitors the server generates from a plan, as GET /api/monitors lists them. */
export function generatedLatencyMonitors(plan: LatencyProbePlan): MonitorView[] {
  return plan.nodes
    .filter((n) => n.monitor_id && n.endpoint)
    .map((n) => {
      const sources = plan.pairs.filter((p) => p.target === n.node_id && p.active).map((p) => p.source);
      return {
        id: n.monitor_id!,
        name: `Latency to ${n.name}`,
        type: "tcp",
        target: n.endpoint!,
        interval_sec: plan.config.interval_sec,
        timeout_sec: plan.config.timeout_sec,
        node_ids: sources,
        enabled: sources.length > 0,
        managed_by: "latency",
        latest: [],
      } as MonitorView;
    });
}
