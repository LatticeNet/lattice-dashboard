/**
 * Check definitions in the console (design 32 D1): one check with a source
 * set and a target set, which the server expands into one monitor per
 * (target, method). This model holds the editor's draft, what a save sends,
 * what blocks one, how the server's dry run is summed up in one line, how a
 * definition reads from the matrix, and the rows of the Checks list, where
 * definitions, Fleet mesh (the path set) and single checks share one list.
 *
 * Pure, like the sibling models: no Vue, no i18n.
 */
import type {
  CheckDefinitionPreview,
  CheckDefinitionSave,
  CheckDefinitionView,
  CheckFleetMesh,
  CheckMethod,
  LatencyPair,
  MonitorAlertPolicy,
  MonitorView,
  TargetSelector,
} from "@/lib/api/types";
import { isEmptySelector, normalizeSelector, selectorParts, type SelectorGroup, type SelectorNode } from "@/components/selector/selectorModel";
import { buildHeaderEdits, headerProblems, headersForCreate, rowsFromHeaders, type HeaderRow } from "@/views/fleet/checkHeadersModel";
import { canonicalStatusSet, isHttpsUrl, parseStatusSet } from "@/views/fleet/checkRulesModel";
import { CHECK_MAX_INTERVAL_SEC, CHECK_MAX_TIMEOUT_SEC, CHECK_MIN_INTERVAL_SEC, PACKETS_DEFAULT, PACKETS_MAX, dnsQuestion, icmpRunSeconds, multiPacket } from "@/views/fleet/checksModel";
import { DNS_RCODE_NXDOMAIN, checkDestination, expectBlocks, expectText, normalizeDnsName, parseExpect, parseResolver } from "@/views/fleet/dnsCheckModel";
import { ALERT_DEFAULT_AFTER, ALERT_MAX_AFTER, defaultDegradedDraft, degradedDraftFrom, degradedForSave, degradedProblems, effectiveAlert, pagesDown, type DegradedDraft } from "@/views/fleet/degradedRuleModel";
import type { MonitorHealth } from "@/views/fleet/monitorHealthModel";
import { AGENT_DEFAULT_INTERVAL_SEC, AGENT_DEFAULT_TIMEOUT_SEC, TLS_DEFAULT_INTERVAL_SEC, TLS_DEFAULT_THRESHOLD_DAYS, TLS_DEFAULT_TIMEOUT_SEC, TLS_MAX_THRESHOLD_DAYS, targetError } from "@/views/fleet/monitorTypeModel";
import { isChosenUnknown, reasonCode, type PathItem } from "@/views/fleet/pathsModel";

/** A selector that names a group or the whole fleet: it needs an unrestricted principal, and secrets refuse it. */
export function selectorIsBroad(sel: TargetSelector | undefined): boolean {
  return !!sel && (sel.all === true || (sel.groups?.length ?? 0) > 0);
}

/** The words a selector reads as: the whole fleet, groups, nodes, then what it leaves out. */
export interface SelectorWords {
  fleet: string;
  group: (name: string) => string;
  except: (base: string, names: string) => string;
}

/** A selector in words: "the whole fleet except hk-2", "group asia, jp-1". */
export function describeSelector(sel: TargetSelector | undefined, nodes: readonly SelectorNode[], groups: readonly SelectorGroup[], words: SelectorWords): string {
  if (!sel) return "";
  const parts = selectorParts(sel, nodes, groups);
  const base = parts
    .filter((p) => p.kind !== "exclude")
    .map((p) => (p.kind === "fleet" ? words.fleet : p.kind === "group" ? words.group(p.name) : p.name))
    .join(", ");
  const left = parts.filter((p) => p.kind === "exclude").map((p) => p.name);
  return left.length ? words.except(base, left.join(", ")) : base;
}

/**
 * The methods a definition offers, node-to-node first. Auto is the control
 * plane's choice per pair (design 32 R1): the beacon where the target's plan
 * approved the source, else icmp, else tcp to the port rule's endpoint.
 */
export const DEFINITION_KINDS: readonly CheckMethod[] = ["tcp", "icmp", "beacon", "auto", "http", "dns", "tls"];

/** The bounds lattice-sdk model.CheckDefinition* sets; the server refuses past them. */
export const DEFINITION_NAME_MAX = 120;

const encoder = new TextEncoder();
/** A string's length as the server counts it: bytes of UTF-8. */
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** A suggested name stays well under the limit, cut at a whole character. */
const SUGGESTED_NAME_BYTES = 80;
function truncateBytes(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (utf8Bytes(out + ch) > max) break;
    out += ch;
  }
  return out;
}
export const DEFINITION_ADDRESSES_MAX = 64;

/** tcp, icmp, beacon and auto reach target nodes. */
export function takesTargetNodes(kind: string): boolean {
  return kind === "tcp" || kind === "icmp" || kind === "beacon" || kind === "auto";
}

/** Every method but beacon and auto takes addresses: URLs for http, host:port for tcp and tls, IPv4 for icmp, resolver endpoints for dns. */
export function takesAddresses(kind: string): boolean {
  return kind !== "beacon" && kind !== "auto";
}

/** The kind a definition's run length is judged as: auto's longest run is an icmp one, as the server judges it. */
function runKind(kind: CheckMethod): string {
  return kind === "auto" ? "icmp" : kind;
}

/** A tls check runs on the control plane: it has no sources. */
export function takesSources(kind: string): boolean {
  return kind !== "tls";
}

export interface DefinitionDraft {
  type: CheckMethod;
  name: string;
  sources: TargetSelector;
  targets: TargetSelector;
  /** One address per line, as typed. */
  addressText: string;
  packets: number;
  expectStatus: string;
  headers: HeaderRow[];
  /** dns (design 32 S5a): the question and the answer that passes, as the check editor holds them. */
  dnsName: string;
  dnsType: string;
  /** One expected value per line. */
  dnsExpect: string;
  /** "" for NOERROR, or NXDOMAIN. */
  dnsExpectRcode: string;
  intervalSec: number;
  timeoutSec: number;
  thresholdDays: number;
  alert: MonitorAlertPolicy;
  alertAfter: number;
  degraded: DegradedDraft;
  enabled: boolean;
  /** The pairs the check never measures (design 32 R1), kept as stored: the editor does not change them, a save sends them back. */
  excludedPairs: LatencyPair[];
}

export function emptyDefinitionDraft(type: CheckMethod = "tcp"): DefinitionDraft {
  const tls = type === "tls";
  return {
    type,
    name: "",
    sources: {},
    targets: {},
    addressText: "",
    packets: PACKETS_DEFAULT,
    expectStatus: "",
    headers: [],
    dnsName: "",
    dnsType: "A",
    dnsExpect: "",
    dnsExpectRcode: "",
    intervalSec: tls ? TLS_DEFAULT_INTERVAL_SEC : AGENT_DEFAULT_INTERVAL_SEC,
    timeoutSec: tls ? TLS_DEFAULT_TIMEOUT_SEC : AGENT_DEFAULT_TIMEOUT_SEC,
    thresholdDays: TLS_DEFAULT_THRESHOLD_DAYS,
    alert: "down",
    alertAfter: ALERT_DEFAULT_AFTER,
    degraded: defaultDegradedDraft(),
    enabled: true,
    excludedPairs: [],
  };
}

export function draftFromDefinition(def: CheckDefinitionView): DefinitionDraft {
  const type = DEFINITION_KINDS.includes(def.type) ? def.type : "tcp";
  return {
    type,
    name: def.name ?? "",
    sources: normalizeSelector(def.sources),
    targets: normalizeSelector(def.targets),
    addressText: (def.addresses ?? []).join("\n"),
    packets: def.packets && def.packets > 0 ? def.packets : PACKETS_DEFAULT,
    expectStatus: def.expect_status ?? "",
    headers: rowsFromHeaders(def.headers),
    dnsName: def.dns_name ?? "",
    dnsType: def.dns_type || "A",
    dnsExpect: expectText(def.dns_expect),
    dnsExpectRcode: def.dns_expect_rcode === DNS_RCODE_NXDOMAIN ? DNS_RCODE_NXDOMAIN : "",
    intervalSec: def.interval_sec,
    timeoutSec: def.timeout_sec,
    thresholdDays: def.threshold_days && def.threshold_days > 0 ? def.threshold_days : TLS_DEFAULT_THRESHOLD_DAYS,
    alert: effectiveAlert(def.alert, false),
    alertAfter: def.alert_after && def.alert_after > 0 ? def.alert_after : ALERT_DEFAULT_AFTER,
    degraded: degradedDraftFrom(def.degraded),
    enabled: def.enabled,
    excludedPairs: (def.excluded_pairs ?? []).map((p) => ({ source: p.source, target: p.target })),
  };
}

/** The draft with another method: fields the method does not take are cleared, so a save never carries them. */
export function withKind(draft: DefinitionDraft, type: CheckMethod): DefinitionDraft {
  // The sets and addresses stay in the draft whatever the method: a save and
  // the rules leave out what a method does not take, so trying TLS and coming
  // back loses nothing the operator chose.
  const next = { ...draft, type };
  if ((type === "tls") !== (draft.type === "tls")) {
    next.intervalSec = type === "tls" ? TLS_DEFAULT_INTERVAL_SEC : AGENT_DEFAULT_INTERVAL_SEC;
    next.timeoutSec = type === "tls" ? TLS_DEFAULT_TIMEOUT_SEC : AGENT_DEFAULT_TIMEOUT_SEC;
  }
  if (type === "tls" && next.alert === "down_and_degraded") next.alert = "down";
  return next;
}

/** The addresses typed, one per line or separated by commas, trimmed and without repeats. */
export function addressesOf(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((v) => v.trim()).filter(Boolean))];
}

export type DefinitionProblem =
  | "sources"
  | "target"
  | "address"
  | "destination"
  | "tooManyAddresses"
  | "interval"
  | "timeout"
  | "timeoutVsInterval"
  | "runLength"
  | "packets"
  | "expectStatus"
  | "headers"
  | "secretSources"
  | "threshold"
  | "alertAfter"
  | "alertTls"
  | "degraded"
  | "dnsName"
  | "dnsExpect"
  | "name";

/** What blocks a save before the server is asked. `newDefinition` applies the rules a new check meets (a kept secret cannot be carried). */
export function definitionProblems(draft: DefinitionDraft, options: { newDefinition: boolean; m3?: boolean }): DefinitionProblem[] {
  const out: DefinitionProblem[] = [];
  const addresses = takesAddresses(draft.type) ? addressesOf(draft.addressText) : [];
  if (takesSources(draft.type) && isEmptySelector(draft.sources)) out.push("sources");
  const nodeTargets = takesTargetNodes(draft.type) && !isEmptySelector(draft.targets);
  if (!nodeTargets && addresses.length === 0) out.push("target");
  if (addresses.some((a) => targetError(draft.type, a))) out.push("address");
  else if (addresses.some((a) => checkDestination(draft.type, a))) out.push("destination");
  if (addresses.length > DEFINITION_ADDRESSES_MAX) out.push("tooManyAddresses");
  if (utf8Bytes(draft.name.trim()) > DEFINITION_NAME_MAX) out.push("name");
  const interval = Number(draft.intervalSec);
  const timeout = Number(draft.timeoutSec);
  if (!Number.isInteger(interval) || interval < CHECK_MIN_INTERVAL_SEC || interval > CHECK_MAX_INTERVAL_SEC) out.push("interval");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > CHECK_MAX_TIMEOUT_SEC) out.push("timeout");
  if (multiPacket(runKind(draft.type))) {
    const packets = Number(draft.packets);
    if (!Number.isInteger(packets) || packets < 1 || packets > PACKETS_MAX) out.push("packets");
    else if (!out.includes("interval") && !out.includes("timeout") && icmpRunSeconds(packets, timeout) >= interval) out.push("runLength");
  } else if (!out.includes("interval") && !out.includes("timeout") && timeout >= interval) {
    out.push("timeoutVsInterval");
  }
  if (draft.type === "http") {
    if (!parseStatusSet(draft.expectStatus).ok) out.push("expectStatus");
    const https = addresses.length > 0 && addresses.every(isHttpsUrl);
    if (headerProblems(draft.headers, { https, newCheck: options.newDefinition }).any) out.push("headers");
    if (draft.headers.some((h) => h.secret) && selectorIsBroad(draft.sources)) out.push("secretSources");
  }
  if (draft.type === "dns") {
    if (!normalizeDnsName(draft.dnsName).ok) out.push("dnsName");
    if (expectBlocks(parseExpect(draft.dnsType, draft.dnsExpect, draft.dnsExpectRcode))) out.push("dnsExpect");
  }
  if (draft.type === "tls") {
    const days = Number(draft.thresholdDays);
    if (!Number.isInteger(days) || days < 1 || days > TLS_MAX_THRESHOLD_DAYS) out.push("threshold");
  }
  if (pagesDown(draft.alert)) {
    const after = Number(draft.alertAfter);
    if (!Number.isInteger(after) || after < 1 || after > ALERT_MAX_AFTER) out.push("alertAfter");
  }
  if (draft.alert === "down_and_degraded" && draft.type === "tls") out.push("alertTls");
  if (options.m3 !== false && draft.type !== "tls" && degradedProblems(draft.degraded).length) out.push("degraded");
  return out;
}

/** The fields "Still needed:" names: what is missing, as opposed to what is wrong. */
export function missingParts(problems: readonly DefinitionProblem[]): ("sources" | "target")[] {
  return (["sources", "target"] as const).filter((p) => problems.includes(p));
}

/** The name a definition gets when the operator leaves it empty. */
export function suggestDefinitionName(draft: DefinitionDraft, nodeName: (id: string) => string, groupName: (id: string) => string, wholeFleet: string): string {
  const method = draft.type.toUpperCase();
  const addresses = takesAddresses(draft.type) ? addressesOf(draft.addressText) : [];
  const t = draft.targets;
  const parts: string[] = [];
  if (takesTargetNodes(draft.type)) {
    if (t.all) parts.push(wholeFleet);
    for (const id of t.groups ?? []) parts.push(groupName(id));
    for (const id of t.nodes ?? []) parts.push(nodeName(id));
  }
  for (const a of addresses) {
    let shown = a;
    if (draft.type === "http") {
      try {
        const url = new URL(a);
        shown = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
      } catch {
        shown = a;
      }
    }
    if (draft.type === "dns") {
      const parsed = parseResolver(a);
      if (parsed.ok) shown = parsed.resolver.host;
    }
    parts.push(shown);
  }
  if (!parts.length) return "";
  const shown = parts.length > 2 ? `${parts.slice(0, 2).join(", ")} +${parts.length - 2}` : parts.join(", ");
  return truncateBytes(`${method} ${shown}`, SUGGESTED_NAME_BYTES);
}

/**
 * The body of a create (no `existing`), an edit, or a dry run of either.
 * The spec goes whole; headers are operations: every row set on a create,
 * only the changes on an edit, so a kept secret is never sent back.
 */
export function buildDefinitionSave(draft: DefinitionDraft, existing: CheckDefinitionView | undefined, suggestedName: string): CheckDefinitionSave {
  const tls = draft.type === "tls";
  const body: CheckDefinitionSave = {
    name: draft.name.trim() || suggestedName,
    type: draft.type,
    sources: takesSources(draft.type) ? normalizeSelector(draft.sources) : {},
    targets: takesTargetNodes(draft.type) ? normalizeSelector(draft.targets) : {},
    interval_sec: Number(draft.intervalSec),
    timeout_sec: Number(draft.timeoutSec),
    alert: draft.alert,
    enabled: draft.enabled,
  };
  const addresses = takesAddresses(draft.type) ? addressesOf(draft.addressText) : [];
  if (addresses.length) body.addresses = addresses;
  if (multiPacket(runKind(draft.type))) body.packets = Number(draft.packets);
  if (takesTargetNodes(draft.type) && draft.excludedPairs.length) body.excluded_pairs = draft.excludedPairs.map((p) => ({ ...p }));
  if (tls) body.threshold_days = Number(draft.thresholdDays);
  if (pagesDown(draft.alert)) body.alert_after = Number(draft.alertAfter);
  if (!tls) {
    const degraded = degradedForSave(draft.degraded);
    if (degraded) body.degraded = degraded;
  }
  if (draft.type === "dns") Object.assign(body, dnsQuestion(draft));
  if (draft.type === "http") {
    if (draft.expectStatus.trim()) body.expect_status = canonicalStatusSet(draft.expectStatus) ?? draft.expectStatus.trim();
    if (existing) {
      const ops = buildHeaderEdits(existing.type === "http" ? existing.headers : undefined, draft.headers);
      if (ops) body.headers = ops;
    } else {
      const headers = headersForCreate(draft.headers);
      if (headers) body.headers = headers.map((h) => ({ name: h.name, op: "set" as const, value: h.value, ...(h.secret ? { secret: true } : {}) }));
    }
  }
  if (existing) {
    body.id = existing.id;
    body.version = existing.version;
  }
  return body;
}

/** Whether an edit would change the definition: a header operation, or any field of the spec. */
export function definitionDirty(existing: CheckDefinitionView, draft: DefinitionDraft, suggestedName: string): boolean {
  const next = buildDefinitionSave(draft, existing, suggestedName);
  if (next.headers?.length) return true;
  const before = buildDefinitionSave(draftFromDefinition(existing), existing, existing.name);
  return JSON.stringify({ ...next, headers: undefined }) !== JSON.stringify({ ...before, headers: undefined });
}

/* ---- The dry run in one line ---- */

export interface PreviewCount {
  reason: string;
  /** The detail behind a target's reason (a latency endpoint note), when every one shares it. */
  note?: string;
  count: number;
}

export interface PreviewSummary {
  paths: number;
  measured: number;
  /** Targets nothing can be dialled on, by reason. */
  targets: PreviewCount[];
  /** Pairs that would read unknown, by reason, less those whose target is already counted above. */
  pairs: PreviewCount[];
  created: number;
  paused: number;
  deleted: number;
}

function counted(list: readonly { reason: string; note?: string }[]): PreviewCount[] {
  const by = new Map<string, PreviewCount & { notes: Set<string> }>();
  for (const item of list) {
    const held = by.get(item.reason) ?? { reason: item.reason, count: 0, notes: new Set<string>() };
    held.count++;
    if (item.note) held.notes.add(item.note);
    by.set(item.reason, held);
  }
  return [...by.values()]
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .map(({ notes, ...rest }) => (notes.size === 1 ? { ...rest, note: [...notes][0] } : rest));
}

export function summarizePreview(preview: CheckDefinitionPreview): PreviewSummary {
  const deadTargets = new Set(preview.targets.filter((t) => t.reason).map((t) => t.monitor_id).filter(Boolean));
  return {
    paths: preview.paths,
    measured: preview.measured,
    targets: counted(preview.targets.filter((t) => t.reason).map((t) => ({ reason: t.reason!, note: t.note }))),
    pairs: counted(preview.pairs.filter((p) => p.reason && !deadTargets.has(p.monitor_id)).map((p) => ({ reason: p.reason! }))),
    created: preview.writes.created.length,
    paused: preview.writes.paused.length,
    deleted: preview.writes.deleted.length,
  };
}

/* ---- A definition read from the matrix ---- */


/**
 * A set of paths as one check's health, in the vocabulary the Checks list
 * already reads: down on N of M, degraded on N of M, not measured with the
 * reason, up, or no paths yet. `enabled` false reads paused.
 */
export function pathsHealth(paths: readonly { state: string; reason?: string; lastAt?: number; p50Ms?: number }[], enabled: boolean, now: number): MonitorHealth {
  if (!enabled) return { kind: "disabled" };
  if (paths.length === 0) return { kind: "none" };
  const lastAt = Math.max(0, ...paths.map((p) => p.lastAt ?? 0)) || now;
  const down = paths.filter((p) => p.state === "down").length;
  if (down) return { kind: "failing", failing: down, total: paths.length, lastAt };
  const degraded = paths.filter((p) => p.state === "degraded").length;
  const up = paths.filter((p) => p.state === "up");
  if (degraded) return { kind: "degraded", degraded, total: degraded + up.length, lastAt };
  // Up on how many of all its paths, never an average latency: the p50s of
  // different pairs do not add up to one figure.
  if (up.length) return { kind: "up", total: up.length, of: paths.length, lastAt };
  const reasons = [...new Set(paths.map((p) => p.reason).filter((r): r is string => !!r && !isChosenUnknown(r)))];
  if (!reasons.length) return { kind: "none" };
  return reasons.length === 1
    ? { kind: "unmeasured", total: paths.length, reason: reasons[0]!, lastAt }
    : { kind: "unmeasured", total: paths.length, reason: "", reasons: reasons.length, lastAt };
}

/* ---- The Checks list: definitions, Fleet mesh and single checks in one list ---- */

export type CheckRow =
  | { kind: "definition"; key: string; definition: CheckDefinitionView }
  | { kind: "fleet"; key: string; mesh: CheckFleetMesh }
  | { kind: "check"; key: string; monitor: MonitorView };

/** Your checks (definitions and single checks together), then the built-in one. */
export type CheckRowGroup = "checks" | "builtin";
export const CHECK_ROW_GROUP_ORDER: readonly CheckRowGroup[] = ["checks", "builtin"];
const FLEET_MESH_KEY = "fleet-mesh";

export function checkRowGroup(row: CheckRow): CheckRowGroup {
  return row.kind === "fleet" ? "builtin" : "checks";
}

/**
 * The list's rows. A monitor a definition or the path set generated is not
 * a row of its own: its definition and Fleet mesh stand for it. Fleet mesh
 * is a built-in row only while the path set is not migrated; once it is
 * (design 32 R1) its definitions are rows like any other and there is no
 * built-in group.
 */
export function checkRows(monitors: readonly MonitorView[], definitions: readonly CheckDefinitionView[], mesh: CheckFleetMesh | undefined): CheckRow[] {
  const rows: CheckRow[] = definitions.map((d) => ({ kind: "definition", key: `def:${d.id}`, definition: d }));
  for (const m of monitors) {
    if (m.managed_by || m.check_definition_id) continue;
    rows.push({ kind: "check", key: m.id, monitor: m });
  }
  if (mesh && !mesh.migrated) rows.push({ kind: "fleet", key: FLEET_MESH_KEY, mesh });
  return rows;
}

/** A row's name. */
export function checkRowName(row: CheckRow): string {
  switch (row.kind) {
    case "definition":
      return row.definition.name || row.definition.id;
    case "fleet":
      return row.mesh.name;
    case "check":
      return row.monitor.name || row.monitor.id;
  }
}

/** A row's method: a definition's own, Fleet mesh's setting (auto, tcp, icmp or beacon), a check's kind. */
export function checkRowMethod(row: CheckRow): string {
  switch (row.kind) {
    case "definition":
      return row.definition.type;
    case "fleet":
      return row.mesh.method || "tcp";
    case "check":
      return String(row.monitor.type);
  }
}

/* ---- Skipped pairs and their fixes (design 32 R2) ---- */

/**
 * What fixes a skipped pair: switch the check to auto, leave the targets out
 * of it, stop measuring exactly those pairs, or approve the beacon plan.
 */
export type SkipFix = "auto" | "exclude" | "pairs" | "approve";

/**
 * Why a pair is skipped, in the order the sheet lists them: nothing to dial,
 * a source that cannot run it, an approval, the budget, a refused address.
 * Leaving a target out stops it for every source, so it is offered only when
 * the target is what fails; a source's own reason stops only its pairs.
 */
const SKIP_KINDS: readonly { reasons: readonly string[]; fixes: (type: CheckMethod) => SkipFix[] }[] = [
  { reasons: ["not_probeable", "no_tcp_line", "udp_only", "no_public_address", "no_inventory"], fixes: (type) => (type === "auto" ? ["exclude"] : ["auto", "exclude"]) },
  { reasons: ["agent_too_old", "icmp_not_permitted"], fixes: (type) => (type === "auto" ? ["pairs"] : ["auto", "pairs"]) },
  { reasons: ["beacon_not_enabled", "firewall_pending", "beacon_source_pending", "refused_by_node"], fixes: () => ["approve"] },
  { reasons: ["packet_budget"], fixes: () => ["pairs"] },
  { reasons: ["destination_refused"], fixes: () => ["pairs"] },
];

export type SkippedPair = Pick<PathItem, "key" | "source" | "sourceName" | "targetNode" | "targetName" | "reason" | "measure">;

export interface SkippedGroup<P extends SkippedPair = SkippedPair> {
  reason: string;
  paths: P[];
  fixes: SkipFix[];
}

/**
 * A definition's skipped pairs grouped by reason, each reason with its fixes
 * (design 32 R2): auto for a pair whose method has nothing to dial or whose
 * source cannot run it (not offered when the check is auto already), the
 * targets left out of the set when the target is what fails, those pairs
 * excluded when a source is, or the beacon plan approved. Paused pairs are
 * not skipped and are left out.
 */
export function skippedByReason<P extends SkippedPair>(paths: readonly P[], type: CheckMethod): SkippedGroup<P>[] {
  const by = new Map<string, P[]>();
  for (const path of paths) {
    if (path.measure !== "skipped") continue;
    const reason = reasonCode(path.reason) ?? path.reason ?? "";
    by.set(reason, [...(by.get(reason) ?? []), path]);
  }
  const rank = (reason: string) => {
    const i = SKIP_KINDS.findIndex((k) => k.reasons.includes(reason));
    return i < 0 ? SKIP_KINDS.length : i;
  };
  return [...by.entries()]
    .map(([reason, list]) => ({
      reason,
      paths: [...list].sort((a, b) => a.targetName.localeCompare(b.targetName) || a.sourceName.localeCompare(b.sourceName)),
      fixes: SKIP_KINDS[rank(reason)]?.fixes(type) ?? ["pairs"],
    }))
    .sort((a, b) => rank(a.reason) - rank(b.reason) || b.paths.length - a.paths.length || a.reason.localeCompare(b.reason));
}

/** A change the check sheet opens the editor with, for the operator to review and save. */
export type DefinitionFix = { kind: "auto" } | { kind: "exclude"; targets: readonly string[] } | { kind: "pairs"; pairs: readonly LatencyPair[] };

/**
 * The draft with a fix made: auto as the method, the pairs added to the
 * excluded pairs, or the targets left out of the set (a node named outright
 * leaves the list instead, so it is never both named and excluded).
 */
export function applyDefinitionFix(draft: DefinitionDraft, fix: DefinitionFix): DefinitionDraft {
  if (fix.kind === "auto") return withKind(draft, "auto");
  if (fix.kind === "pairs") {
    const pairs = [...draft.excludedPairs];
    for (const pair of fix.pairs) if (!pairs.some((p) => p.source === pair.source && p.target === pair.target)) pairs.push({ source: pair.source, target: pair.target });
    return { ...draft, excludedPairs: pairs };
  }
  const leave = new Set(fix.targets);
  const t = draft.targets;
  return {
    ...draft,
    targets: normalizeSelector({
      ...t,
      nodes: (t.nodes ?? []).filter((id) => !leave.has(id)),
      exclude: [...new Set([...(t.exclude ?? []), ...leave])],
    }),
  };
}

/**
 * "Stop measuring this pair" (design 32 R3): the definition's normal save,
 * its stored spec with the pair added to its excluded pairs, at the version
 * it was read at; undefined when the pair is excluded already.
 */
export function stopMeasuringSave(def: CheckDefinitionView, source: string, target: string): CheckDefinitionSave | undefined {
  const draft = draftFromDefinition(def);
  if (draft.excludedPairs.some((p) => p.source === source && p.target === target)) return undefined;
  draft.excludedPairs.push({ source, target });
  return buildDefinitionSave(draft, def, def.name);
}

/**
 * "Measure again": the same save the other way, the pair taken out of the
 * excluded pairs (its monitor and history were kept); undefined when the
 * pair is measured already. It is also the undo of a stop.
 */
export function measureAgainSave(def: CheckDefinitionView, source: string, target: string): CheckDefinitionSave | undefined {
  const draft = draftFromDefinition(def);
  const kept = draft.excludedPairs.filter((p) => p.source !== source || p.target !== target);
  if (kept.length === draft.excludedPairs.length) return undefined;
  return buildDefinitionSave({ ...draft, excludedPairs: kept }, def, def.name);
}
