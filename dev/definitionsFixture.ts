/**
 * Check definitions for the Monitoring harness (design 32 D1): what the
 * server's planner would make of a definition, close enough to draw the
 * Checks list, the editor's dry run and a definition's sheet. The rules the
 * harness keeps are the ones the console shows: one monitor per method and
 * target with an opaque hashed id, a target that leaves the set keeps its
 * monitor paused, a source over the packet budget is paused on that pair,
 * a beacon definition's other sources wait on the target's plan, and a node
 * that serves nothing the method can dial holds a monitor with nothing to
 * dial and says why on the target.
 *
 * One source, the Shanghai probe, already sends every node 1.9 packets a
 * second through Fleet mesh, so a definition that adds more from it shows
 * the budget at work.
 */
import type {
  CheckDefinition,
  CheckDefinitionMonitor,
  CheckDefinitionPreview,
  CheckDefinitionView,
  CheckFleetMesh,
  CheckPreviewPair,
  CheckPreviewTarget,
  LatencyProbePlan,
  MonitorView,
  TargetSelector,
} from "@/lib/api/types";
import { resolveTargetSelector, type SelectorGroup } from "@/lib/targetSelector";
import { takesSources, takesTargetNodes } from "@/views/fleet/definitionsModel";

export interface DefinitionNode {
  id: string;
  name: string;
  public_ip?: string;
  online?: boolean;
}

/** model.MonitorPacketsPerSecondMax: packets a second one source may send one address across its checks. */
const BUDGET = 2;
const BUSY_SOURCE = "[cd]-volcengine-shanghai";
const BUSY_LOAD = 1.9;

function hash(text: string): string {
  // FNV-1a, 40 bits: opaque and stable, as the server's sha256 prefix is.
  let h = 0xcbf29ce484222325n;
  for (const c of new TextEncoder().encode(text)) h = BigInt.asUintN(64, (h ^ BigInt(c)) * 0x100000001b3n);
  return (h & 0xffffffffffn).toString(16).padStart(10, "0");
}

export function definitionMonitorId(definitionId: string, method: string, target: string): string {
  return `mon_${definitionId}_${hash(`${method}\n${target}`)}`;
}

/** Stored runs, invented but stable per monitor, for the delete and forget confirmations. */
export function runsOf(monitorId: string): number {
  return 800 + (parseInt(hash(monitorId).slice(0, 6), 16) % 9000);
}

interface Entry {
  key: string;
  targetNode?: string;
  target: string;
  reason?: string;
  note?: string;
}

function packetsPerSecond(def: Pick<CheckDefinition, "type" | "packets" | "interval_sec">): number {
  if (def.type === "http" || def.type === "tls") return 0;
  const packets = def.type === "icmp" ? Math.max(1, def.packets ?? 1) : 1;
  return def.interval_sec > 0 ? packets / def.interval_sec : 0;
}

function entriesOf(def: CheckDefinition, nodes: readonly DefinitionNode[], groups: readonly SelectorGroup[]): Entry[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Entry[] = [];
  if (takesTargetNodes(def.type)) {
    for (const id of resolveTargetSelector(def.targets, nodes, groups)) {
      const node = byId.get(id)!;
      if (!node.public_ip) {
        out.push({ key: id, targetNode: id, target: "", reason: def.type === "beacon" ? "beacon_not_enabled" : "not_probeable", note: "no_public_address" });
        continue;
      }
      if (def.type === "beacon" && !node.name.includes("jp-nat")) {
        out.push({ key: id, targetNode: id, target: "", reason: "beacon_not_enabled", note: "the target runs no beacon" });
        continue;
      }
      const target = def.type === "icmp" ? node.public_ip : def.type === "beacon" ? `${node.public_ip}:50231` : `${node.public_ip}:443`;
      out.push({ key: id, targetNode: id, target });
    }
  }
  for (const address of def.addresses ?? []) out.push({ key: address, target: address });
  return out;
}

export interface DefinitionPlan {
  /** The monitors the definition holds after a save: in the set, then paused targets. */
  monitors: MonitorView[];
  preview: CheckDefinitionPreview;
}

/**
 * What a save of `def` writes, given the monitors it holds now. `now` is the
 * save's time, for the monitors it creates.
 */
export function planDefinition(def: CheckDefinition, held: readonly MonitorView[], nodes: readonly DefinitionNode[], groups: readonly SelectorGroup[], now: string): DefinitionPlan {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sources = takesSources(def.type) ? resolveTargetSelector(def.sources, nodes, groups) : [""];
  const heldById = new Map(held.map((m) => [m.id, m]));
  const rate = packetsPerSecond(def);
  const targets: CheckPreviewTarget[] = [];
  const pairs: CheckPreviewPair[] = [];
  const monitors: MonitorView[] = [];
  const inSet = new Set<string>();
  for (const e of entriesOf(def, nodes, groups)) {
    const monitorId = definitionMonitorId(def.id, def.type, e.targetNode ?? e.key);
    targets.push({ monitor_id: monitorId, target: e.target || e.key, ...(e.targetNode ? { target_node: e.targetNode } : {}), ...(e.reason ? { reason: e.reason, note: e.note } : {}) });
    const runOn = sources.filter((s) => s !== e.targetNode);
    const overBudget: string[] = [];
    runOn.forEach((source, index) => {
      let reason = e.reason;
      if (!reason && source) {
        const node = byId.get(source);
        if (def.type === "beacon" && index > 0) reason = "beacon_source_pending";
        else if (def.enabled && rate > 0 && e.targetNode && node?.name === BUSY_SOURCE && BUSY_LOAD + rate > BUDGET + 1e-9) {
          reason = "packet_budget";
          overBudget.push(source);
        } else if (!def.enabled) reason = "source_paused";
        else if (node && node.online === false) reason = "agent_offline";
      }
      pairs.push({ source, monitor_id: monitorId, ...(reason ? { reason } : {}) });
    });
    // A target with a reason still holds its monitor, with nothing to dial, as the server's does.
    inSet.add(monitorId);
    const prior = heldById.get(monitorId);
    monitors.push({
      ...(prior ?? {}),
      id: monitorId,
      name: `${def.name} to ${e.targetNode ? (byId.get(e.targetNode)?.name ?? e.targetNode) : e.key}`,
      type: def.type,
      target: e.target,
      ...(e.targetNode ? { target_node: e.targetNode } : {}),
      interval_sec: def.interval_sec,
      timeout_sec: def.timeout_sec,
      ...(def.packets ? { packets: def.packets } : {}),
      ...(def.threshold_days ? { threshold_days: def.threshold_days } : {}),
      ...(def.expect_status ? { expect_status: def.expect_status } : {}),
      ...(def.headers?.length ? { headers: def.headers } : {}),
      alert: def.alert,
      alert_after: def.alert_after,
      degraded: def.degraded ?? undefined,
      assign_all: false,
      node_ids: runOn.filter(Boolean),
      paused_node_ids: overBudget,
      enabled: def.enabled && runOn.length > 0,
      managed_by: `check:${def.id}`,
      check_definition_id: def.id,
      version: (prior?.version ?? 0) + 1,
      created_at: prior?.created_at ?? now,
    } as MonitorView);
  }
  // A target that left the set keeps its monitor and history, paused.
  const paused = held.filter((m) => !inSet.has(m.id));
  for (const m of paused) monitors.push({ ...m, enabled: false });
  const created = [...inSet].filter((id) => !heldById.has(id));
  return {
    monitors,
    preview: {
      sources: sources.filter(Boolean),
      targets,
      pairs,
      paths: pairs.length,
      measured: pairs.filter((p) => !p.reason).length,
      writes: {
        created,
        updated: [...inSet].filter((id) => heldById.has(id)),
        paused: paused.filter((m) => m.enabled).map((m) => m.id),
        deleted: [],
      },
      also_changes: [],
    },
  };
}

/** The read of a definition as the server answers it; `withMonitors` for one definition's sheet. */
export function definitionView(def: CheckDefinition, held: readonly MonitorView[], plan: CheckDefinitionPreview, withMonitors: boolean): CheckDefinitionView {
  const pausedTargets = held.filter((m) => !m.enabled && !plan.targets.some((t) => t.monitor_id === m.id));
  const view: CheckDefinitionView = {
    ...def,
    summary: {
      monitors: held.length,
      paths: plan.paths,
      paused_targets: pausedTargets.length,
      paused_runs: pausedTargets.reduce((n, m) => n + runsOf(m.id), 0),
    },
  };
  if (withMonitors) {
    view.monitors = held.map(
      (m): CheckDefinitionMonitor => ({
        monitor_id: m.id,
        method: m.type,
        target: m.target,
        ...(m.target_node ? { target_node: m.target_node } : {}),
        in_set: plan.targets.some((t) => t.monitor_id === m.id),
        enabled: m.enabled,
        sources: m.node_ids ?? [],
        runs: runsOf(m.id),
      }),
    );
  }
  return view;
}

/** Fleet mesh as the definitions list carries it, from the latency plan. */
export function fleetMeshOf(plan: LatencyProbePlan, stored: boolean): CheckFleetMesh {
  return {
    name: "Fleet mesh",
    enabled: plan.config.enabled,
    stored,
    version: plan.config.version,
    method: plan.config.method || "tcp",
    sources: plan.config.sources.length,
    targets: plan.nodes.filter((n) => n.target === "probed").length,
    paths: plan.pairs.length,
    paused_targets: plan.nodes.filter((n) => n.target === "paused").length,
  };
}

/**
 * Two definitions over the harness fleet, each built from node names so the
 * fixture follows whatever ids the fleet has: a ping from three domestic
 * sources to three nodes abroad (one more node, Helsinki, left the set and
 * holds a paused monitor), and a status page fetched from a group.
 */
export function seedDefinitions(nodes: readonly DefinitionNode[], groupIds: readonly string[], at: (offsetMs: number) => string): CheckDefinition[] {
  const id = (name: string) => nodes.find((n) => n.name === name)?.id;
  const some = (...names: string[]) => names.map(id).filter((x): x is string => Boolean(x));
  const sources: TargetSelector = { nodes: some(BUSY_SOURCE, "[cd]-qqpw-vds-cd1", "[cd]-homeserver") };
  const ping: CheckDefinition = {
    id: "chk_apac_ping",
    name: "Ping APAC from domestic",
    type: "icmp",
    sources,
    targets: { nodes: some("[cd]-xuezhang-jp-nat", "[cd]-linode-sgp", "[cd]-gomami-hk-turin-mini") },
    interval_sec: 10,
    timeout_sec: 5,
    packets: 3,
    alert: "down",
    alert_after: 3,
    enabled: true,
    version: 4,
    created_at: at(-21 * 86_400_000),
    updated_at: at(-2 * 86_400_000),
    updated_by: "cdcd",
  };
  const status: CheckDefinition = {
    id: "chk_status_https",
    name: "Status page from the relays",
    type: "http",
    sources: groupIds.includes("grp_cn_optimized") ? { groups: ["grp_cn_optimized"] } : sources,
    targets: {},
    addresses: ["https://status.example.com/health"],
    interval_sec: 60,
    timeout_sec: 10,
    expect_status: "200",
    alert: "down",
    alert_after: 2,
    enabled: true,
    version: 1,
    created_at: at(-6 * 86_400_000),
    updated_at: at(-6 * 86_400_000),
    updated_by: "cdcd",
  };
  return [ping, status];
}

/** The node that left the ping's set before the harness opened, kept paused with its history. */
export const SEED_LEFT_TARGET = "[cd]-hetzner-hel";
