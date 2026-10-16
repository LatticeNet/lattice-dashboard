/**
 * The Checks layer of Monitoring (design 29 D1, D7, D9): every check in one
 * list, the editor in task order, and the edit route's body.
 *
 * A check is a monitor. Those an operator made are edited in place through
 * POST /api/monitors/update with the version they were read at; changing the
 * method or the target is not an edit, because one series must never mix two
 * methods: the console creates a new check and pauses the old one, after the
 * operator confirms. Checks the path set generated are read-only here; their
 * paths are paused through the path set.
 *
 * Design 29 M2a adds ICMP, a node as the target (icmp, tcp), packets per
 * run, an http check's expected statuses and request headers, and gating of
 * sources by the methods their agents run. Every one of them is offered only
 * when the server speaks M2a (checkRulesModel.serverSpeaksM2a), so against an
 * older server the editor and its bodies are exactly M1's.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { LatencyProbeNode, MonitorAlertPolicy, MonitorCreateInput, MonitorType, MonitorUpdateInput, MonitorView, Node } from "@/lib/api/types";

import { buildHeaderEdits, headerProblems, headersForCreate, rowsFromHeaders, type HeaderProblems, type HeaderRow } from "@/views/fleet/checkHeadersModel";
import { canonicalStatusSet, destinationProblem, isHttpsUrl, needsCurrentAgent, parseStatusSet, publicIPv4, sourceSupport } from "@/views/fleet/checkRulesModel";
import type { MonitorHealth } from "@/views/fleet/monitorHealthModel";
import { beaconTargetBlock } from "@/views/fleet/beaconModel";
import { isChosenUnknown } from "@/views/fleet/pathsModel";

import {
  AGENT_DEFAULT_INTERVAL_SEC,
  AGENT_DEFAULT_TIMEOUT_SEC,
  TLS_DEFAULT_INTERVAL_SEC,
  TLS_DEFAULT_THRESHOLD_DAYS,
  TLS_DEFAULT_TIMEOUT_SEC,
  TLS_MAX_THRESHOLD_DAYS,
  isServerEvaluated,
  targetError,
} from "@/views/fleet/monitorTypeModel";

/**
 * The kinds a check can be created as: M1's, icmp on an M2a server, and
 * beacon on an M2b server, first because it is the method design 29 D2
 * prefers for a node.
 */
export const CHECK_KINDS: readonly MonitorType[] = ["beacon", "tcp", "icmp", "http", "tls"];

export function offeredKinds(m2a: boolean, m2b = false, canReadNodes = true): MonitorType[] {
  // A beacon check names its target node and nothing else, so a session that cannot read the node list cannot write one.
  return CHECK_KINDS.filter((k) => (k === "icmp" ? m2a : k === "beacon" ? m2a && m2b && canReadNodes : true));
}

/** Kinds that send several packets a run, 200 ms apart, and report loss (icmp, beacon). */
export function multiPacket(kind: string): boolean {
  return kind === "icmp" || kind === "beacon";
}

/** A beacon check always names its node and never an address (design 29 D12). */
export function nodeOnly(kind: string): boolean {
  return kind === "beacon";
}

/** lattice-sdk MonitorPacketsDefault, MonitorPacketsMax, MonitorPacketSpacingMs, MonitorPacketsPerSecondMax. */
export const PACKETS_DEFAULT = 5;
export const PACKETS_MAX = 10;
export const PACKET_SPACING_MS = 200;
export const PACKETS_PER_SECOND_MAX = 2;

/** Kinds whose target may be a node, resolved by the server (design 29 D11, D12). */
export function takesNodeTarget(kind: string): boolean {
  return kind === "icmp" || kind === "tcp" || kind === "beacon";
}

/** Bounds the server enforces on a check. */
export const CHECK_MIN_INTERVAL_SEC = 10;
export const CHECK_MAX_INTERVAL_SEC = 86400;
export const CHECK_MAX_TIMEOUT_SEC = 300;
/** lattice-sdk MonitorAlertAfterDefault and MonitorAlertAfterMax. */
export const ALERT_DEFAULT_AFTER = 2;
export const ALERT_MAX_AFTER = 20;

/**
 * The certificate expiry a result read, in epoch milliseconds, or undefined
 * when the run read none. The server writes Go's zero time
 * ("0001-01-01T00:00:00Z") for every result that did not complete a TLS
 * handshake: every tcp and http result, and a tls result whose handshake
 * failed. That value is not an expiry and must never read as "expired".
 */
export function certExpiry(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  if (Number.isNaN(at) || new Date(at).getUTCFullYear() <= 1) return undefined;
  return at;
}

/** The newest certificate expiry among results ordered newest first. */
export function latestCertExpiry(results: readonly { cert_not_after?: string }[] | undefined): number | undefined {
  for (const r of results ?? []) {
    const at = certExpiry(r.cert_not_after);
    if (at !== undefined) return at;
  }
  return undefined;
}

export type CheckGroup = "operator" | "pathset";
export const CHECK_GROUP_ORDER: readonly CheckGroup[] = ["operator", "pathset"];

export function checkGroup(monitor: Pick<MonitorView, "managed_by">): CheckGroup {
  return monitor.managed_by ? "pathset" : "operator";
}

/**
 * Whether the console may edit this check: the server has the edit route
 * (it answered the paths read, design 29) and the check is an operator's.
 * The signal is the server, not the field: an edit names `version ?? 0`, so
 * a check listed without one (never edited) is editable all the same.
 */
/**
 * A check's health with its paths' verdict folded in (design 29 M2a). The
 * control plane judges some failing runs as unknown: an ICMP target that has
 * never answered reads icmp_filtered and does not page. So when the newest
 * results fail but no path of the check is down and one is unknown for a
 * reason that is not a pause, the check reads unmeasured with that reason,
 * as its paths do, rather than down.
 */
export function withPathVerdict(
  health: MonitorHealth,
  paths: readonly { source?: string; state: string; reason?: string }[],
  latest: readonly { node_id?: string; success: boolean; reason?: string }[] = [],
): MonitorHealth {
  if (health.kind !== "failing" || paths.length === 0 || paths.some((p) => p.state === "down")) return health;
  const unknown = paths.filter((p) => p.state === "unknown" && p.reason && !isChosenUnknown(p.reason));
  if (!unknown.length) return health;
  // The reason that explains the failing results is the one on the paths of the sources that fail. When none of
  // those paths carries one (a failing source the matrix reads up), the check's other unknown paths speak for it.
  const failing = new Set(latest.filter((l) => !l.success && !l.reason).map((l) => l.node_id ?? ""));
  const own = unknown.filter((p) => p.source !== undefined && failing.has(p.source));
  const reasons = [...new Set((own.length ? own : unknown).map((p) => p.reason!))];
  return reasons.length === 1
    ? { kind: "unmeasured", total: health.total, reason: reasons[0]!, lastAt: health.lastAt }
    : { kind: "unmeasured", total: health.total, reason: "", reasons: reasons.length, lastAt: health.lastAt };
}

/**
 * The sources a check's row names, as its sheet lists them: the check's own
 * list and every source its paths name (a path set target can have paths
 * from sources its generated check does not run on), with how many of them
 * measure nothing: a path unknown for a reason that is not a choice, or,
 * without paths, a newest result with a reason.
 */
export function checkSourceSummary(
  monitor: Pick<MonitorView, "node_ids" | "latest">,
  paths: readonly { source: string; state: string; reason?: string }[],
): { ids: string[]; unmeasured: number } {
  const ids = new Set(monitor.node_ids ?? []);
  for (const p of paths) ids.add(p.source);
  const unmeasured = new Set<string>();
  for (const p of paths) if (p.state === "unknown" && p.reason && !isChosenUnknown(p.reason)) unmeasured.add(p.source);
  if (!paths.length) for (const l of monitor.latest ?? []) if (l.reason && l.node_id) unmeasured.add(l.node_id);
  return { ids: [...ids].sort(), unmeasured: unmeasured.size };
}

export function canEditCheck(monitor: Pick<MonitorView, "managed_by">, serverEdits: boolean): boolean {
  return serverEdits && !monitor.managed_by;
}

export type TargetMode = "address" | "node";

export interface CheckDraft {
  type: MonitorType;
  name: string;
  /** The address or URL, when the target is not a node. */
  target: string;
  /** "node" makes the server resolve the target from `targetNode` (icmp, tcp); other kinds read it as "address". */
  targetMode: TargetMode;
  targetNode: string;
  /** icmp: echoes per run. */
  packets: number;
  /** http: the passing statuses as typed; empty reads as 200-399. */
  expectStatus: string;
  /** http: request headers. */
  headers: HeaderRow[];
  intervalSec: number;
  timeoutSec: number;
  thresholdDays: number;
  assignAll: boolean;
  nodeIds: string[];
  pausedNodeIds: string[];
  /** down pages when a source fails `alertAfter` times in a row; off never pages. */
  alert: "off" | "down";
  alertAfter: number;
}

export function emptyDraft(type: MonitorType = "http"): CheckDraft {
  const tls = isServerEvaluated(type);
  return {
    type,
    name: "",
    target: "",
    targetMode: nodeOnly(type) ? "node" : "address",
    targetNode: "",
    packets: PACKETS_DEFAULT,
    expectStatus: "",
    headers: [],
    intervalSec: tls ? TLS_DEFAULT_INTERVAL_SEC : AGENT_DEFAULT_INTERVAL_SEC,
    timeoutSec: tls ? TLS_DEFAULT_TIMEOUT_SEC : AGENT_DEFAULT_TIMEOUT_SEC,
    thresholdDays: TLS_DEFAULT_THRESHOLD_DAYS,
    assignAll: !tls,
    nodeIds: [],
    pausedNodeIds: [],
    alert: "down",
    alertAfter: ALERT_DEFAULT_AFTER,
  };
}

function uniqueSorted(list: readonly string[] | undefined): string[] {
  return [...new Set(list ?? [])].filter(Boolean).sort();
}

export function draftFromMonitor(monitor: MonitorView): CheckDraft {
  const type = (CHECK_KINDS.includes(monitor.type as MonitorType) ? monitor.type : "tcp") as MonitorType;
  return {
    type,
    name: monitor.name ?? "",
    target: monitor.target ?? "",
    targetMode: (monitor.target_node && takesNodeTarget(type)) || nodeOnly(type) ? "node" : "address",
    targetNode: monitor.target_node ?? "",
    packets: monitor.packets && monitor.packets > 0 ? monitor.packets : PACKETS_DEFAULT,
    expectStatus: monitor.expect_status ?? "",
    headers: rowsFromHeaders(monitor.headers),
    intervalSec: monitor.interval_sec,
    timeoutSec: monitor.timeout_sec,
    thresholdDays: monitor.threshold_days ?? TLS_DEFAULT_THRESHOLD_DAYS,
    assignAll: !!monitor.assign_all,
    nodeIds: uniqueSorted(monitor.node_ids),
    pausedNodeIds: uniqueSorted(monitor.paused_node_ids),
    alert: monitor.alert === "off" ? "off" : "down",
    alertAfter: monitor.alert_after && monitor.alert_after > 0 ? monitor.alert_after : ALERT_DEFAULT_AFTER,
  };
}

/** Whether the draft names a node as its target. */
export function usesNodeTarget(draft: Pick<CheckDraft, "type" | "targetMode">): boolean {
  return nodeOnly(draft.type) || (draft.targetMode === "node" && takesNodeTarget(draft.type));
}

/** A name the form offers until the operator types one: "HTTP status.example.com", "ICMP xuezhang-jp-nat", or "Beacon to xuezhang-jp-nat" as the server names its own. */
export function suggestName(type: string, target: string, nodeName?: string): string {
  if (nodeName && type === "beacon") return `Beacon to ${nodeName}`.slice(0, 80);
  if (nodeName) return `${type.toUpperCase()} ${nodeName}`.slice(0, 80);
  const value = target.trim();
  if (!value) return "";
  let shown = value;
  if (type === "http") {
    try {
      const url = new URL(value);
      shown = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      shown = value;
    }
  }
  return `${type.toUpperCase()} ${shown}`.slice(0, 80);
}

export type DraftProblem =
  | "target"
  | "destination"
  | "targetNode"
  | "interval"
  | "timeout"
  | "timeoutVsInterval"
  | "runLength"
  | "packets"
  | "budget"
  | "expectStatus"
  | "headers"
  | "sources"
  | "threshold"
  | "alertAfter";

/**
 * What the rules need besides the draft. `m2a` turns on the M2a rules; the
 * node resolution, the packet budget and whether the save starts a new check
 * are worked out by the caller from the node list, the plan and the checks.
 */
export interface DraftRules {
  m2a: boolean;
  /** The node target resolved for the method; "refused" blocks the save. */
  nodeTarget?: NodeTargetResolution;
  /** The packets per second the busiest source would send to this check's address, this check included; set only when the server re-checks it (budgetRechecked). */
  budgetPps?: number;
  /**
   * The save creates a check (a create, or a replacement): the destination
   * rules apply, and saved secrets cannot be carried. An edit cannot change
   * the target, so a check saved before the rules stays editable.
   */
  newCheck?: boolean;
}

/** The longest a multi-packet run (icmp, beacon) takes, in seconds: every packet but the last spaced out, then the last one's timeout. */
export function icmpRunSeconds(packets: number, timeoutSec: number): number {
  return ((Math.max(1, packets) - 1) * PACKET_SPACING_MS) / 1000 + timeoutSec;
}

export function draftProblems(draft: CheckDraft, rules: DraftRules = { m2a: false }): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (usesNodeTarget(draft)) {
    if (!draft.targetNode) out.push("target");
    else if (rules.nodeTarget?.state === "refused") out.push("targetNode");
  } else if (targetError(draft.type, draft.target)) {
    out.push("target");
  } else if (rules.newCheck && (rules.m2a || draft.type === "icmp") && destinationProblem(draft.type, draft.target)) {
    out.push("destination");
  }
  const interval = Number(draft.intervalSec);
  const timeout = Number(draft.timeoutSec);
  if (!Number.isInteger(interval) || interval < CHECK_MIN_INTERVAL_SEC || interval > CHECK_MAX_INTERVAL_SEC) out.push("interval");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > CHECK_MAX_TIMEOUT_SEC) out.push("timeout");
  if (multiPacket(draft.type)) {
    const packets = Number(draft.packets);
    if (!Number.isInteger(packets) || packets < 1 || packets > PACKETS_MAX) out.push("packets");
    else if (!out.includes("interval") && !out.includes("timeout") && icmpRunSeconds(packets, timeout) >= interval) out.push("runLength");
    if (rules.budgetPps !== undefined && rules.budgetPps > PACKETS_PER_SECOND_MAX + 1e-9) out.push("budget");
  } else if (!out.includes("interval") && !out.includes("timeout") && timeout >= interval) {
    out.push("timeoutVsInterval");
  }
  if (draft.type === "http" && rules.m2a) {
    if (!parseStatusSet(draft.expectStatus).ok) out.push("expectStatus");
    if (draftHeaderProblems(draft, !!rules.newCheck).any) out.push("headers");
  }
  if (isServerEvaluated(draft.type)) {
    const days = Number(draft.thresholdDays);
    if (!Number.isInteger(days) || days < 1 || days > TLS_MAX_THRESHOLD_DAYS) out.push("threshold");
  } else if (!draft.assignAll && draft.nodeIds.length === 0) {
    out.push("sources");
  }
  if (draft.alert === "down") {
    const after = Number(draft.alertAfter);
    if (!Number.isInteger(after) || after < 1 || after > ALERT_MAX_AFTER) out.push("alertAfter");
  }
  return out;
}

/** The header problems of an http draft. */
export function draftHeaderProblems(draft: Pick<CheckDraft, "headers" | "target">, newCheck: boolean): HeaderProblems {
  return headerProblems(draft.headers, { https: isHttpsUrl(draft.target), newCheck });
}

/**
 * Whether the server checks the packet budget on this save: a new check
 * always; an edit only when it changes what the budget counts (the
 * interval, the packets, the sources or their pauses).
 */
export function budgetRechecked(monitor: MonitorView | undefined, draft: CheckDraft, newCheck: boolean): boolean {
  if (!monitor || newCheck) return true;
  const body = buildUpdate(monitor, draft, { m2a: true });
  return ["interval_sec", "packets", "assign_all", "node_ids", "paused_node_ids"].some((key) => key in body);
}

/**
 * The method, the target or the target node changed: saving makes a new check
 * and pauses this one. A node target compares by node, not by the address the
 * server resolved it to, which moves with the node.
 */
export function identityChanged(monitor: Pick<MonitorView, "type" | "target" | "target_node">, draft: Pick<CheckDraft, "type" | "target" | "targetMode" | "targetNode">): boolean {
  if (monitor.type !== draft.type) return true;
  const node = usesNodeTarget(draft);
  if (node !== !!monitor.target_node) return true;
  if (node) return monitor.target_node !== draft.targetNode;
  return (monitor.target ?? "").trim() !== draft.target.trim();
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = uniqueSorted(a);
  const y = uniqueSorted(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Whether the draft differs from what the check holds: a new identity, or an edit that would change a field. */
export function draftChanged(monitor: MonitorView, draft: CheckDraft): boolean {
  if (identityChanged(monitor, draft)) return true;
  return Object.keys(buildUpdate(monitor, draft, { m2a: true })).some((key) => key !== "id" && key !== "version");
}

export interface BodyOptions {
  /** The server speaks M2a: send its fields. */
  m2a?: boolean;
  /** The target node's name, for the suggested check name. */
  nodeName?: string;
}

function draftName(draft: CheckDraft, options: BodyOptions): string {
  return draft.name.trim() || suggestName(draft.type, draft.target, usesNodeTarget(draft) ? options.nodeName || draft.targetNode : undefined);
}

/**
 * The edit body: the version it was read at and the fields that changed.
 * Kind and target are never sent (identityChanged covers that path). A pause
 * names only sources the check runs on; a source taken off the check drops
 * its pause with it.
 */
export function buildUpdate(monitor: MonitorView, draft: CheckDraft, options: BodyOptions = {}): MonitorUpdateInput {
  const before = draftFromMonitor(monitor);
  const body: MonitorUpdateInput = { id: monitor.id, version: monitor.version ?? 0 };
  const name = draftName(draft, options);
  if (name !== before.name) body.name = name;
  if (Number(draft.intervalSec) !== before.intervalSec) body.interval_sec = Number(draft.intervalSec);
  if (Number(draft.timeoutSec) !== before.timeoutSec) body.timeout_sec = Number(draft.timeoutSec);
  if (multiPacket(draft.type) && Number(draft.packets) !== before.packets) body.packets = Number(draft.packets);
  if (draft.type === "http" && options.m2a) {
    // Compared by meaning: an empty field and "200-399" are the same set.
    const next = canonicalStatusSet(draft.expectStatus);
    if (next !== undefined && next !== canonicalStatusSet(before.expectStatus)) body.expect_status = draft.expectStatus.trim() ? next : "";
    const ops = buildHeaderEdits(monitor.headers, draft.headers);
    if (ops) body.headers = ops;
  }
  if (isServerEvaluated(draft.type)) {
    if (Number(draft.thresholdDays) !== before.thresholdDays) body.threshold_days = Number(draft.thresholdDays);
  } else {
    if (draft.assignAll !== before.assignAll) body.assign_all = draft.assignAll;
    const nodeIds = draft.assignAll ? [] : uniqueSorted(draft.nodeIds);
    if (!draft.assignAll && !sameList(nodeIds, before.nodeIds)) body.node_ids = nodeIds;
    const paused = uniqueSorted(draft.pausedNodeIds).filter((id) => draft.assignAll || nodeIds.includes(id));
    if (!sameList(paused, before.pausedNodeIds)) body.paused_node_ids = paused;
  }
  const alert: MonitorAlertPolicy = draft.alert;
  if (alert !== before.alert) body.alert = alert;
  if (alert === "down" && Number(draft.alertAfter) !== before.alertAfter) body.alert_after = Number(draft.alertAfter);
  return body;
}

/** The create body for a new check (or the replacement of one whose method or target changed). */
export function buildCreate(draft: CheckDraft, withAlert: boolean, options: BodyOptions = {}): MonitorCreateInput {
  const base: MonitorCreateInput = {
    name: draftName(draft, options),
    type: draft.type,
    interval_sec: Number(draft.intervalSec),
    timeout_sec: Number(draft.timeoutSec),
  };
  // A node target is resolved by the server; the address it resolves to is not the operator's to write.
  if (usesNodeTarget(draft)) base.target_node = draft.targetNode;
  else base.target = draft.target.trim();
  if (multiPacket(draft.type)) base.packets = Number(draft.packets);
  if (draft.type === "http" && options.m2a) {
    if (draft.expectStatus.trim()) base.expect_status = canonicalStatusSet(draft.expectStatus) ?? draft.expectStatus.trim();
    const headers = headersForCreate(draft.headers);
    if (headers) base.headers = headers;
  }
  if (isServerEvaluated(draft.type)) {
    base.threshold_days = Number(draft.thresholdDays);
    base.assign_all = false;
  } else {
    base.assign_all = draft.assignAll;
    if (!draft.assignAll) base.node_ids = uniqueSorted(draft.nodeIds);
  }
  if (withAlert) {
    base.alert = draft.alert;
    if (draft.alert === "down") base.alert_after = Number(draft.alertAfter);
  }
  return base;
}

/**
 * The pauses a replacement keeps, as an edit of the check just created: the
 * create route starts every check unpaused, so the sources the operator had
 * paused are paused again on the new check. Undefined when there are none.
 */
export function buildCarryPauses(created: Pick<MonitorView, "id" | "version">, draft: CheckDraft): MonitorUpdateInput | undefined {
  if (isServerEvaluated(draft.type)) return undefined;
  const chosen = new Set(draft.nodeIds);
  const paused = uniqueSorted(draft.pausedNodeIds).filter((id) => draft.assignAll || chosen.has(id));
  if (!paused.length) return undefined;
  return { id: created.id, version: created.version ?? 1, paused_node_ids: paused };
}

/** The body that pauses a check whose replacement was just created; its history stays. */
export function buildPauseOld(monitor: MonitorView): MonitorUpdateInput {
  return { id: monitor.id, version: monitor.version ?? 0, enabled: false };
}

/** Pause or resume one source of an operator check (the path sheet's action). */
export function buildSourcePause(monitor: MonitorView, source: string, paused: boolean): MonitorUpdateInput {
  const current = uniqueSorted(monitor.paused_node_ids);
  const next = paused ? uniqueSorted([...current, source]) : current.filter((id) => id !== source);
  return { id: monitor.id, version: monitor.version ?? 0, paused_node_ids: next };
}

export function sourcePaused(monitor: Pick<MonitorView, "paused_node_ids">, source: string): boolean {
  return (monitor.paused_node_ids ?? []).includes(source);
}

/* ------------------------------------------------------------------ */
/* Node targets and sources (design 29 D9, D11)                         */
/* ------------------------------------------------------------------ */

export type NodeTargetResolution =
  /** `note` says why the target answers nobody now although the server takes it (a beacon refused, too old or not listening). */
  | { state: "resolved"; endpoint: string; note?: string }
  | { state: "refused"; reason: string }
  /** The server resolves it when the check is saved; the console cannot tell the line port beforehand. */
  | { state: "onSave" };

/**
 * What a node target resolves to for a method, by the server's rule: icmp
 * to the node's public IPv4 (the latency plan's own resolution when the node
 * is in it), tcp to its public TCP line port, which only the plan knows, and
 * only for the nodes the path set targets; for any other node the server
 * resolves it on save and refuses the save with the reason if it cannot.
 */
export function resolveNodeTarget(
  kind: string,
  node: Pick<Node, "public_ip" | "beacon"> | undefined,
  planNode?: Pick<LatencyProbeNode, "icmp_target" | "endpoint" | "endpoint_note" | "target" | "beacon_target">,
  setMethod?: string,
): NodeTargetResolution {
  if (kind === "icmp") {
    // The server pings only a public IPv4 the destination rule accepts (latencyPublicIPv4).
    const ip = publicIPv4(planNode?.icmp_target || node?.public_ip);
    return ip ? { state: "resolved", endpoint: ip } : { state: "refused", reason: "no_public_ipv4" };
  }
  if (kind === "beacon") {
    // The server resolves a beacon check to the node's advertised endpoint, which the plan carries while an applied plan enables it.
    if (!planNode?.beacon_target) return { state: "refused", reason: "no_beacon" };
    // The server saves a check to any enabled beacon; one whose agent refuses it, has no responder or has no socket
    // answers no source until that changes, which the note says (and the picker does not offer the first two).
    const block = beaconTargetBlock(node);
    const note = block === "refused_by_node" ? "beacon_refused" : block === "agent_too_old" ? "beacon_agent_too_old" : block;
    return note ? { state: "resolved", endpoint: planNode.beacon_target, note } : { state: "resolved", endpoint: planNode.beacon_target };
  }
  if (kind === "tcp") {
    if (planNode?.endpoint && planNode.target !== "not_probeable") return { state: "resolved", endpoint: planNode.endpoint };
    // A path set on ICMP writes its own no_public_address over the TCP note, so the TCP reason is the server's to give on save.
    const icmpNote = setMethod === "icmp" && planNode?.endpoint_note === "no_public_address";
    // A note without an endpoint is the planner saying why the node has no line to dial (udp_only, no_tcp_line, ...).
    if (planNode && !planNode.endpoint && planNode.endpoint_note && !icmpNote) return { state: "refused", reason: planNode.endpoint_note };
    if (icmpNote) return { state: "onSave" };
    if (planNode?.target === "not_probeable") return { state: "refused", reason: "no_tcp_line" };
    return { state: "onSave" };
  }
  return { state: "onSave" };
}

/** The sources a draft names: every node with assign_all, else the chosen ones. */
export function draftSources(draft: Pick<CheckDraft, "assignAll" | "nodeIds">, nodes: readonly Pick<Node, "id">[]): string[] {
  return draft.assignAll ? nodes.map((n) => n.id) : [...draft.nodeIds];
}

/** Whether an http draft uses a field only agents of this release run (checkRulesModel.needsCurrentAgent). */
export function draftNeedsCurrentAgent(draft: Pick<CheckDraft, "type" | "expectStatus" | "headers">): boolean {
  return needsCurrentAgent(draft.type, draft.expectStatus, draft.headers.filter((h) => h.name.trim()).length);
}

/** Chosen sources whose agent cannot run the check, with the reason each path would read. */
export function unsupportedSources(draft: Pick<CheckDraft, "type" | "assignAll" | "nodeIds" | "expectStatus" | "headers">, nodes: readonly Node[], m2a: boolean): { id: string; reason: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const current = draftNeedsCurrentAgent(draft);
  const out: { id: string; reason: string }[] = [];
  for (const id of draftSources(draft, nodes)) {
    const support = sourceSupport(byId.get(id), draft.type, m2a, current);
    if (!support.ok) out.push({ id, reason: support.reason });
  }
  return out;
}

type BudgetMonitor = Pick<MonitorView, "id" | "type" | "target" | "target_node" | "enabled" | "assign_all" | "node_ids" | "paused_node_ids" | "packets" | "interval_sec">;

/**
 * The packets per second the busiest source would send to one address, this
 * draft included: every other enabled icmp check that runs on the source and
 * targets the same address, operator and generated alike (D11 caps it at 2).
 */
export function icmpBudget(
  address: string,
  sources: readonly string[],
  draft: Pick<CheckDraft, "packets" | "intervalSec">,
  monitors: readonly BudgetMonitor[],
  editingId?: string,
): { pps: number; source?: string } {
  return packetBudget("icmp", address, sources, draft, monitors, editingId);
}

/**
 * The same budget for a beacon check (D12): per source and target node, the
 * packets per second of every enabled beacon check to that node together,
 * the generated mon_latb_ ones included, may not exceed 2.
 */
export function beaconBudget(
  targetNode: string,
  sources: readonly string[],
  draft: Pick<CheckDraft, "packets" | "intervalSec">,
  monitors: readonly BudgetMonitor[],
  editingId?: string,
): { pps: number; source?: string } {
  return packetBudget("beacon", targetNode, sources, draft, monitors, editingId);
}

function packetBudget(
  kind: "icmp" | "beacon",
  key: string,
  sources: readonly string[],
  draft: Pick<CheckDraft, "packets" | "intervalSec">,
  monitors: readonly BudgetMonitor[],
  editingId?: string,
): { pps: number; source?: string } {
  const own = Number(draft.packets) / Math.max(1, Number(draft.intervalSec) || 1);
  let worst = { pps: own, source: sources[0] as string | undefined };
  if (!key) return worst;
  for (const source of sources) {
    let pps = own;
    for (const m of monitors) {
      if (m.id === editingId || m.type !== kind || !m.enabled || (kind === "icmp" ? m.target : m.target_node) !== key) continue;
      if (!m.assign_all && !(m.node_ids ?? []).includes(source)) continue;
      if ((m.paused_node_ids ?? []).includes(source)) continue;
      pps += (m.packets && m.packets > 0 ? m.packets : PACKETS_DEFAULT) / Math.max(1, m.interval_sec || 1);
    }
    if (pps > worst.pps) worst = { pps, source };
  }
  return worst;
}

/** When switching method, carry the assignment over: tls takes none and wants an hourly cadence; a beacon always targets a node. */
export function switchDraftKind(draft: CheckDraft, next: MonitorType, stash?: Pick<CheckDraft, "assignAll" | "nodeIds" | "intervalSec" | "timeoutSec">): { draft: CheckDraft; stash?: Pick<CheckDraft, "assignAll" | "nodeIds" | "intervalSec" | "timeoutSec"> } {
  if (next === draft.type) return { draft, stash };
  const toTls = isServerEvaluated(next);
  const fromTls = isServerEvaluated(draft.type);
  if (toTls && !fromTls) {
    return {
      stash: { assignAll: draft.assignAll, nodeIds: [...draft.nodeIds], intervalSec: draft.intervalSec, timeoutSec: draft.timeoutSec },
      draft: { ...draft, type: next, assignAll: false, nodeIds: [], intervalSec: TLS_DEFAULT_INTERVAL_SEC, timeoutSec: TLS_DEFAULT_TIMEOUT_SEC },
    };
  }
  if (fromTls && !toTls) {
    const back = stash ?? { assignAll: true, nodeIds: [], intervalSec: AGENT_DEFAULT_INTERVAL_SEC, timeoutSec: AGENT_DEFAULT_TIMEOUT_SEC };
    return { stash: undefined, draft: { ...draft, type: next, ...back, nodeIds: [...back.nodeIds], targetMode: nodeOnly(next) ? "node" : draft.targetMode } };
  }
  return { draft: { ...draft, type: next, targetMode: nodeOnly(next) ? "node" : draft.targetMode }, stash };
}

/** A note that keeps a node out of the target picker: its beacon cannot answer until the node itself changes. */
export function unpickableNote(resolution: NodeTargetResolution | undefined): boolean {
  return resolution?.state === "resolved" && (resolution.note === "beacon_refused" || resolution.note === "beacon_agent_too_old");
}
