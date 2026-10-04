/**
 * Pure model for keepalive incidents (lattice-server incidents.go): which
 * incidents a list shows, in what order, how each row reads, what the phone
 * was told about it, and the maintenance window editor's rules.
 *
 *   ! sing-box down on DMIT-4    14 min · paged 14:02 · not acknowledged   [Acknowledge] [Snooze] [...]
 *
 * Every word is composed in the view from these structured answers, so a
 * zh-CN console never shows the server's English. The server's own title is
 * kept for the row's proof line only when nothing better exists.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { Incident, MaintenanceWindow, MaintenanceWindowInput } from "@/lib/api/types";
import { INCIDENT_KINDS, isIncidentKind, type IncidentKind } from "@/lib/incidentSeverity";

/** The incident kinds the server opens today (lib/incidentSeverity); another kind is shown by its raw name. */
export { INCIDENT_KINDS };
export type { IncidentKind };

export function knownKind(kind: string): IncidentKind | undefined {
  return isIncidentKind(kind) ? kind : undefined;
}

/**
 * The list filters, in the order the filter control shows them. "active" is
 * the default: open and acknowledged incidents. Pending is not an incident
 * yet (nothing was recorded or sent), so it has its own filter and counts
 * as active nowhere, here or on Home.
 */
export const INCIDENT_FILTERS = ["active", "open", "acknowledged", "snoozed", "pending", "resolved", "all"] as const;
export type IncidentFilter = (typeof INCIDENT_FILTERS)[number];

export function parseIncidentFilter(raw: unknown): IncidentFilter {
  return INCIDENT_FILTERS.includes(raw as IncidentFilter) ? (raw as IncidentFilter) : "active";
}

/** Snooze lengths the row menu offers, in minutes. */
export const SNOOZE_MINUTES = [30, 60, 240, 1440] as const;

/** Rows Home shows before "All incidents". */
export const HOME_INCIDENTS_MAX = 3;

function time(value: string | undefined): number {
  if (!value) return NaN;
  const at = Date.parse(value);
  // The server's zero time (0001-01-01) is "never".
  return at > 0 ? at : NaN;
}

export function isActive(incident: Pick<Incident, "state">): boolean {
  return incident.state === "open" || incident.state === "acknowledged";
}

export function isSnoozed(incident: Pick<Incident, "state" | "snoozed" | "snoozed_until">, now: number): boolean {
  if (!isActive(incident)) return false;
  if (incident.snoozed) return true;
  const until = time(incident.snoozed_until);
  return !Number.isNaN(until) && until > now;
}

export function matchesFilter(incident: Incident, filter: IncidentFilter, now: number): boolean {
  switch (filter) {
    case "active":
      return isActive(incident);
    case "open":
      return incident.state === "open" && !isSnoozed(incident, now);
    case "acknowledged":
      return incident.state === "acknowledged";
    case "snoozed":
      return isSnoozed(incident, now);
    case "pending":
      return incident.state === "pending";
    case "resolved":
      return incident.state === "resolved";
    default:
      return true;
  }
}

export function filterCounts(incidents: readonly Incident[], now: number): Record<IncidentFilter, number> {
  const out = Object.fromEntries(INCIDENT_FILTERS.map((f) => [f, 0])) as Record<IncidentFilter, number>;
  for (const incident of incidents) {
    for (const filter of INCIDENT_FILTERS) if (matchesFilter(incident, filter, now)) out[filter] += 1;
  }
  return out;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Where an incident sorts: open ones nobody is handling first, then the
 * ones someone is (acknowledged, snoozed, or held by a maintenance window,
 * the same set incidentTone quiets), then pending, then resolved.
 */
function attentionRank(incident: Incident, now: number): number {
  if (incident.state === "open") return isSnoozed(incident, now) || incident.maintenance ? 1 : 0;
  if (incident.state === "acknowledged") return 1;
  if (incident.state === "pending") return 2;
  if (incident.state === "resolved") return 3;
  return 4;
}

/**
 * Worst first: unhandled open incidents, then handled ones, then pending,
 * then resolved; within the active ranks critical before warning and the
 * oldest problem first; resolved ones newest resolution first.
 */
export function compareIncidents(a: Incident, b: Incident, now: number): number {
  const rank = attentionRank(a, now) - attentionRank(b, now);
  if (rank !== 0) return rank;
  if (a.state === "resolved") return (time(b.resolved_at) || 0) - (time(a.resolved_at) || 0);
  const sev = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
  if (sev !== 0) return sev;
  const since = (time(a.since) || time(a.opened_at) || 0) - (time(b.since) || time(b.opened_at) || 0);
  return since !== 0 ? since : a.id.localeCompare(b.id);
}

export interface IncidentQuery {
  filter: IncidentFilter;
  kind: string;
  search: string;
}

/**
 * Rows in a held order: the ids in `held` keep their places, and a row the
 * held order does not know (it appeared meanwhile) follows them in its
 * sorted place. Used while an acknowledgement settles, so the row below an
 * acknowledged one does not move under the pointer (useIncidentActions).
 */
export function holdOrder<T extends { id: string }>(sorted: readonly T[], held: readonly string[] | null | undefined): T[] {
  if (!held?.length) return [...sorted];
  const at = new Map(held.map((id, index) => [id, index]));
  const known = sorted.filter((row) => at.has(row.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...known, ...sorted.filter((row) => !at.has(row.id))];
}

/**
 * The rows a list shows for its filters, worst first (or in a held order).
 * A `pinned` row stays even when it no longer matches the state filter: the
 * operator just acted on it (Acknowledge under Open, Snooze under Open), and
 * dropping it would slide the next row's Acknowledge under the pointer and
 * take keyboard focus with it (useIncidentActions holds the pin briefly).
 */
export function visibleIncidents(
  incidents: readonly Incident[],
  query: IncidentQuery,
  now: number,
  held?: readonly string[] | null,
  pinned?: ReadonlySet<string> | null,
): Incident[] {
  const needle = query.search.trim().toLowerCase();
  const sorted = incidents
    .filter((incident) => pinned?.has(incident.id) || matchesFilter(incident, query.filter, now))
    .filter((incident) => !query.kind || incident.kind === query.kind)
    .filter((incident) => {
      if (!needle) return true;
      return [incident.subject, incident.node_name, incident.node_id, incident.title, incident.kind]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle));
    })
    .sort((a, b) => compareIncidents(a, b, now));
  return holdOrder(sorted, held);
}

/** The held state behind arrivals(): the order shown, the rows acted on, and each incident as it was when the hold began. */
export interface HeldView {
  order: readonly string[] | null | undefined;
  pinned?: ReadonlySet<string> | null;
  before?: ReadonlyMap<string, Incident> | null;
}

/**
 * Rows a held order keeps out of their place. While the operator acts, the
 * rows hold still, and an incident that arrives meanwhile goes after them,
 * where it may sit below rows it should be above: a reopened critical under
 * a warning. An incident has arrived when it is new since the hold began, or
 * would now sort above where it sorted then (it reopened, its snooze ended,
 * it stopped pending); with no `before`, any row the held order does not
 * know has arrived. Such a row is held back when it would sort above a row
 * shown before it, or, with `limit` (Home's three), when it belongs among
 * the first `limit` rows but is not shown there. Rows acted on (pinned) do
 * not count as rows shown above: the hold keeps them out of place on
 * purpose. An acknowledged incident is never an arrival: someone is on it,
 * whether it sank because another operator acknowledged it or reopened and
 * was acknowledged since. The list cannot move held-back rows up under a resting pointer,
 * so it says they are there (HoldArrivals). Worst first.
 */
export function arrivals(shown: readonly Incident[], held: HeldView, now: number, limit?: number): Incident[] {
  if (!held.order?.length) return [];
  const inOrder = new Set(held.order);
  const arrived = (incident: Incident): boolean => {
    if (incident.state === "acknowledged") return false;
    if (!held.before) return !inOrder.has(incident.id);
    const was = held.before.get(incident.id);
    return !was || compareIncidents(incident, was, now) < 0;
  };
  const out = new Set<Incident>();
  const rest = shown.filter((incident) => !held.pinned?.has(incident.id));
  const rank = new Map([...rest].sort((a, b) => compareIncidents(a, b, now)).map((incident, index) => [incident.id, index]));
  let lowestAbove = -1;
  for (const incident of rest) {
    const at = rank.get(incident.id) ?? 0;
    if (at < lowestAbove && arrived(incident)) out.add(incident);
    lowestAbove = Math.max(lowestAbove, at);
  }
  if (limit !== undefined) {
    const top = new Set([...shown].sort((a, b) => compareIncidents(a, b, now)).slice(0, limit));
    for (const incident of shown.slice(limit)) if (top.has(incident) && arrived(incident)) out.add(incident);
  }
  return [...out].sort((a, b) => compareIncidents(a, b, now));
}

/**
 * Arrivals split by what happened, so the notice says "new" only when it is:
 * an incident that did not exist when the hold began, or was resolved or
 * still pending then, is new to the operator; one that was already open and
 * now sorts higher (its snooze or its window ended) has moved up. Without
 * `before`, every arrival is new.
 */
export function splitArrivals(arrived: readonly Incident[], before: ReadonlyMap<string, Incident> | null | undefined): { fresh: Incident[]; moved: Incident[] } {
  const fresh: Incident[] = [];
  const moved: Incident[] = [];
  for (const incident of arrived) {
    const was = before?.get(incident.id);
    if (!was || was.state === "resolved" || was.state === "pending") fresh.push(incident);
    else moved.push(incident);
  }
  return { fresh, moved };
}

/** The kinds present, for the kind filter; known kinds first in their fixed order. */
export function kindsPresent(incidents: readonly Incident[]): string[] {
  const present = new Set(incidents.map((incident) => incident.kind));
  const known = INCIDENT_KINDS.filter((kind) => present.has(kind));
  const other = [...present].filter((kind) => !knownKind(kind)).sort();
  return [...known, ...other];
}

export type IncidentTone = "danger" | "warning" | "info" | "muted";

/**
 * An open critical incident is red and an open warning amber; one someone
 * acknowledged, snoozed or that a window holds keeps its icon but goes quiet,
 * because nobody needs to act on it now. Pending is information; resolved is
 * history.
 */
export function incidentTone(incident: Incident, now: number): IncidentTone {
  if (incident.state === "resolved") return "muted";
  if (incident.state === "pending") return "info";
  if (incident.state === "acknowledged" || isSnoozed(incident, now) || incident.maintenance) return "muted";
  return incident.severity === "critical" ? "danger" : "warning";
}

/**
 * What the phone was told, the row's signature line. Built from the record's
 * own fields: what was last sent and when, what is owed, and why it is held.
 */
export type PhoneState =
  | { key: "pending"; opensAt?: number }
  | { key: "held"; reason: "maintenance" | "snoozed" | "flapping"; window?: string; until?: number }
  /** A message was held and nothing holds it any more: the next check sends it. */
  | { key: "released"; by: "window" | "hold" }
  | { key: "owed" }
  | { key: "paged"; at: number; escalatedAt?: number; unacknowledged: boolean; noEscalate: boolean }
  | { key: "recoveryOwed" }
  | { key: "recoveryHeld" }
  | { key: "recovered"; at: number }
  | { key: "silent" };

/** How lattice-server's incidentOpenHold begins the reason it records for a window's hold. */
const WINDOW_HOLD_REASON = "held by maintenance window";

function earliest(values: Record<string, string> | undefined): number | undefined {
  let out: number | undefined;
  for (const value of Object.values(values ?? {})) {
    const at = time(value);
    if (!Number.isNaN(at) && (out === undefined || at < out)) out = at;
  }
  return out;
}

export function phoneState(incident: Incident, now: number): PhoneState {
  if (incident.state === "pending") {
    const opens = time(incident.opens_at);
    return { key: "pending", opensAt: Number.isNaN(opens) ? undefined : opens };
  }
  if (incident.state === "resolved") {
    if (incident.notified === "resolved") return { key: "recovered", at: time(incident.notified_at) || time(incident.resolved_at) || 0 };
    if (incident.owed_recovery) return incident.flapping ? { key: "recoveryHeld" } : { key: "recoveryOwed" };
    return { key: "silent" };
  }
  if (incident.owed_open) {
    if (incident.maintenance) return { key: "held", reason: "maintenance", window: incident.maintenance };
    if (isSnoozed(incident, now)) {
      const until = time(incident.snoozed_until);
      return { key: "held", reason: "snoozed", until: Number.isNaN(until) ? undefined : until };
    }
    if (incident.flapping && incident.suppressed) return { key: "held", reason: "flapping" };
    // The server holds an open message only for a window, a snooze or
    // flapping (incidentOpenHold). Held before and none of them now means
    // the hold lifted, most often a window that ended: the next check sends it.
    if (incident.suppressed && incident.suppressed_at) return { key: "released", by: incident.suppressed.startsWith(WINDOW_HOLD_REASON) ? "window" : "hold" };
    return { key: "owed" };
  }
  if (incident.notified === "open") {
    return {
      key: "paged",
      at: time(incident.open_notified_at) || time(incident.notified_at) || 0,
      escalatedAt: earliest(incident.escalated),
      unacknowledged: incident.state === "open",
      noEscalate: !!incident.no_escalate,
    };
  }
  return { key: "owed" };
}

/** How long the problem has lasted (ms), from when its condition began. */
export function incidentAge(incident: Incident, now: number): number | undefined {
  const since = time(incident.since) || time(incident.opened_at);
  if (Number.isNaN(since) || !since) return undefined;
  const end = incident.state === "resolved" ? time(incident.resolved_at) || now : now;
  return Math.max(0, end - since);
}

/** Who may act on a row: the actions it offers. */
export function incidentActions(incident: Incident, now: number, canAdmin: boolean): { ack: boolean; snooze: boolean; unsnooze: boolean } {
  if (!canAdmin || !isActive(incident) || incident.id.startsWith("pending:")) return { ack: false, snooze: false, unsnooze: false };
  const snoozed = isSnoozed(incident, now);
  return { ack: incident.state === "open", snooze: true, unsnooze: snoozed };
}

/**
 * Home's incidents: the active ones, worst first, at most `max`, how many
 * more, and for each node with a shown incident the kinds shown, so Home can
 * drop the attention row that only one of those rows repeats (homeModel). An
 * incident Home only counts, beyond `max`, keeps its node's row. Pending
 * ones are listed per node, so Home words that node's row the way the
 * Incidents layer does (a warning that opens if it lasts), not as a problem.
 */
export function homeIncidents(
  incidents: readonly Incident[],
  now: number,
  max = HOME_INCIDENTS_MAX,
  held?: readonly string[] | null,
  hold?: Omit<HeldView, "order">,
): {
  shown: Incident[];
  more: number;
  total: number;
  /** Active incidents the held order keeps below their place or out of the rows shown (arrivals). */
  arrived: Incident[];
  nodeKinds: Map<string, Set<string>>;
  pendingNodes: Map<string, Map<string, number | undefined>>;
} {
  const active = holdOrder(
    incidents.filter(isActive).sort((a, b) => compareIncidents(a, b, now)),
    held,
  );
  const shown = active.slice(0, max);
  const arrived = arrivals(active, { order: held, ...hold }, now, max);
  const nodeKinds = new Map<string, Set<string>>();
  for (const incident of shown) {
    if (!incident.node_id) continue;
    const kinds = nodeKinds.get(incident.node_id) ?? new Set<string>();
    kinds.add(incident.kind);
    nodeKinds.set(incident.node_id, kinds);
  }
  // Conditions still inside their hold, per node and kind, with when each opens: Home words such a node's row as pending.
  const pendingNodes = new Map<string, Map<string, number | undefined>>();
  for (const incident of incidents) {
    if (incident.state !== "pending" || !incident.node_id) continue;
    const kinds = pendingNodes.get(incident.node_id) ?? new Map<string, number | undefined>();
    const opens = time(incident.opens_at);
    kinds.set(incident.kind, Number.isNaN(opens) ? undefined : opens);
    pendingNodes.set(incident.node_id, kinds);
  }
  return { shown, more: Math.max(0, active.length - max), total: active.length, arrived, nodeKinds, pendingNodes };
}

/**
 * Monitors whose failure nobody needs to act on now: every active or
 * pending monitor.down incident of theirs is pending, acknowledged, snoozed
 * or held by a window (the same set incidentTone quiets). Home words their
 * failing row as a warning, as the Incidents layer does, instead of a red
 * problem. A monitor with no such incident is not quiet.
 */
export function quietMonitorIds(incidents: readonly Incident[], now: number): Set<string> {
  const loud = new Set<string>();
  const quiet = new Set<string>();
  for (const incident of incidents) {
    if (incident.kind !== "monitor.down" || !incident.monitor_id) continue;
    if (incident.state === "resolved") continue;
    const tone = incidentTone(incident, now);
    if (tone === "muted" || tone === "info") quiet.add(incident.monitor_id);
    else loud.add(incident.monitor_id);
  }
  for (const id of loud) quiet.delete(id);
  return quiet;
}

/* ---------------------------- maintenance windows --------------------------- */

export type WindowPhase = "upcoming" | "active" | "ended";

export function windowPhase(window: Pick<MaintenanceWindow, "starts_at" | "ends_at">, now: number): WindowPhase {
  const start = time(window.starts_at);
  const end = time(window.ends_at);
  if (!Number.isNaN(end) && end <= now) return "ended";
  if (!Number.isNaN(start) && start > now) return "upcoming";
  return "active";
}

const PHASE_RANK: Record<WindowPhase, number> = { active: 0, upcoming: 1, ended: 2 };

/** A window that ended on the browser's current calendar day. */
function endedToday(window: Pick<MaintenanceWindow, "ends_at">, now: number): boolean {
  const end = time(window.ends_at);
  return !Number.isNaN(end) && end <= now && new Date(end).toDateString() === new Date(now).toDateString();
}

/**
 * Windows worth listing: active first (ending soonest), then upcoming
 * (starting soonest), then those that ended today (latest first), so a
 * window ended early can still be found and extended. Older ones are history.
 */
export function listedWindows(windows: readonly MaintenanceWindow[], now: number): MaintenanceWindow[] {
  return windows
    .filter((window) => windowPhase(window, now) !== "ended" || endedToday(window, now))
    .sort((a, b) => {
      const pa = PHASE_RANK[windowPhase(a, now)];
      const pb = PHASE_RANK[windowPhase(b, now)];
      if (pa !== pb) return pa - pb;
      if (pa === 0) return time(a.ends_at) - time(b.ends_at);
      if (pa === 1) return time(a.starts_at) - time(b.starts_at);
      return time(b.ends_at) - time(a.ends_at);
    });
}

/** Whether a window covers a node: by id, or through a group's resolved members. */
function windowCovers(window: Pick<MaintenanceWindow, "node_ids" | "group_ids">, nodeId: string, groupMembers: ReadonlyMap<string, readonly string[]>): boolean {
  if ((window.node_ids ?? []).includes(nodeId)) return true;
  return (window.group_ids ?? []).some((group) => groupMembers.get(group)?.includes(nodeId));
}

/**
 * The open incidents whose first message ending this window sends on the
 * next check. An incident someone acknowledged owes nothing, and one that
 * something else still holds stays held when this window ends: a snooze,
 * flapping, or another active window over its node (the server names only
 * one window per incident). A window that covers groups is resolved through
 * `groupMembers`; without them (no group:read) it is not counted as cover.
 */
export function windowHeldIncidents(
  incidents: readonly Incident[],
  window: Pick<MaintenanceWindow, "id">,
  now: number,
  windows: readonly MaintenanceWindow[] = [],
  groupMembers: ReadonlyMap<string, readonly string[]> = new Map(),
): Incident[] {
  const others = windows.filter((other) => other.id !== window.id && windowPhase(other, now) === "active");
  return incidents.filter(
    (incident) =>
      incident.maintenance_id === window.id &&
      incident.state === "open" &&
      !!incident.owed_open &&
      !isSnoozed(incident, now) &&
      !incident.flapping &&
      !(incident.node_id && others.some((other) => windowCovers(other, incident.node_id!, groupMembers))),
  );
}

/** What a window covers, by name: nodes, then groups. A name the console cannot resolve shows its id. */
export function windowCoverage(window: Pick<MaintenanceWindow, "node_ids" | "group_ids">, nodeNames: ReadonlyMap<string, string>, groupNames: ReadonlyMap<string, string>): { nodes: string[]; groups: string[] } {
  return {
    nodes: (window.node_ids ?? []).map((id) => nodeNames.get(id) ?? id),
    groups: (window.group_ids ?? []).map((id) => groupNames.get(id) ?? id),
  };
}

/** The editor's state. Times are `<input type="datetime-local">` values in the browser's zone. */
export interface WindowDraft {
  id?: string;
  name: string;
  reason: string;
  nodeIds: string[];
  groupIds: string[];
  /** "now" starts a new window when it is saved. */
  start: "now" | "at";
  startsAt: string;
  endsAt: string;
}

export const WINDOW_MAX_DAYS = 30;
export const WINDOW_NAME_MAX = 120;
export const WINDOW_REASON_MAX = 500;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** An instant as a datetime-local value in the browser's zone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value as an instant; NaN when it does not parse. */
export function fromLocalInput(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  return new Date(value).getTime();
}

/** A new window: starting now for an hour, over the node it was opened from. */
export function newWindowDraft(now: number, nodeId?: string): WindowDraft {
  return { name: "", reason: "", nodeIds: nodeId ? [nodeId] : [], groupIds: [], start: "now", startsAt: toLocalInput(now), endsAt: toLocalInput(now + 3_600_000) };
}

export function draftFromWindow(window: MaintenanceWindow): WindowDraft {
  return {
    id: window.id,
    name: window.name,
    reason: window.reason ?? "",
    nodeIds: [...(window.node_ids ?? [])],
    groupIds: [...(window.group_ids ?? [])],
    start: "at",
    startsAt: toLocalInput(time(window.starts_at)),
    endsAt: toLocalInput(time(window.ends_at)),
  };
}

export type WindowDraftError = "name" | "nameLong" | "reasonLong" | "target" | "start" | "end" | "endBeforeStart" | "endPast" | "tooLong";

/** What keeps a draft from saving, by the server's rules. */
export function windowDraftErrors(draft: WindowDraft, now: number): WindowDraftError[] {
  const errors: WindowDraftError[] = [];
  const name = draft.name.trim();
  if (!name) errors.push("name");
  else if (name.length > WINDOW_NAME_MAX) errors.push("nameLong");
  if (draft.reason.trim().length > WINDOW_REASON_MAX) errors.push("reasonLong");
  if (draft.nodeIds.length === 0 && draft.groupIds.length === 0) errors.push("target");
  const start = draft.start === "now" && !draft.id ? now : fromLocalInput(draft.startsAt);
  const end = fromLocalInput(draft.endsAt);
  if (Number.isNaN(start)) errors.push("start");
  if (Number.isNaN(end)) errors.push("end");
  if (!Number.isNaN(start) && !Number.isNaN(end)) {
    if (end <= start) errors.push("endBeforeStart");
    else if (end - start > WINDOW_MAX_DAYS * 86_400_000) errors.push("tooLong");
    if (!draft.id && end <= now) errors.push("endPast");
  }
  return errors;
}

/** The request for a valid draft. A new window starting now leaves starts_at out, so the server stamps it. */
export function windowDraftInput(draft: WindowDraft): MaintenanceWindowInput {
  const input: MaintenanceWindowInput = {
    name: draft.name.trim(),
    node_ids: draft.nodeIds,
    group_ids: draft.groupIds,
    ends_at: new Date(fromLocalInput(draft.endsAt)).toISOString(),
  };
  if (draft.id) input.id = draft.id;
  if (draft.reason.trim()) input.reason = draft.reason.trim();
  if (draft.id || draft.start === "at") input.starts_at = new Date(fromLocalInput(draft.startsAt)).toISOString();
  return input;
}

/**
 * Of the incidents a window released, those whose first message has gone
 * out since (the server's 20 s sweep can run before Undo): restoring the
 * window cannot take those back, and the restore says so.
 */
export function releasedAndPaged(incidents: readonly Incident[], releasedIds: readonly string[]): Incident[] {
  const released = new Set(releasedIds);
  return incidents.filter((incident) => released.has(incident.id) && incident.notified === "open" && !incident.owed_open);
}

/** A window as an upsert of itself; Undo after End now sends this to put the end time back. */
export function windowInput(window: MaintenanceWindow): MaintenanceWindowInput {
  return {
    id: window.id,
    name: window.name,
    reason: window.reason,
    node_ids: window.node_ids ?? [],
    group_ids: window.group_ids ?? [],
    starts_at: window.starts_at,
    ends_at: window.ends_at,
  };
}

/** Ending a running window now: the same window with ends_at set to now. */
export function endWindowInput(window: MaintenanceWindow, now: number): MaintenanceWindowInput {
  return { ...windowInput(window), ends_at: new Date(Math.max(now, time(window.starts_at) + 1000)).toISOString() };
}
