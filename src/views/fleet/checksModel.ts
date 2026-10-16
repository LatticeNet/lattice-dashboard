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
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { MonitorAlertPolicy, MonitorCreateInput, MonitorType, MonitorUpdateInput, MonitorView } from "@/lib/api/types";

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

/** The kinds a check can be created as in M1 (beacon and icmp arrive with M2). */
export const CHECK_KINDS: readonly MonitorType[] = ["tcp", "http", "tls"];

/** Bounds the server enforces on a check. */
export const CHECK_MIN_INTERVAL_SEC = 10;
export const CHECK_MAX_INTERVAL_SEC = 86400;
export const CHECK_MAX_TIMEOUT_SEC = 300;

export type CheckGroup = "operator" | "pathset";
export const CHECK_GROUP_ORDER: readonly CheckGroup[] = ["operator", "pathset"];

export function checkGroup(monitor: Pick<MonitorView, "managed_by">): CheckGroup {
  return monitor.managed_by ? "pathset" : "operator";
}

/**
 * Whether the console may edit this check: the server has the edit route
 * (it answered the paths read, design 29) and the check is an operator's.
 * The version is not the signal: a check never edited is version zero, which
 * the server leaves out of the list.
 */
export function canEditCheck(monitor: Pick<MonitorView, "managed_by">, serverEdits: boolean): boolean {
  return serverEdits && !monitor.managed_by;
}

export interface CheckDraft {
  type: MonitorType;
  name: string;
  target: string;
  intervalSec: number;
  timeoutSec: number;
  thresholdDays: number;
  assignAll: boolean;
  nodeIds: string[];
  pausedNodeIds: string[];
  /** down pages when a source fails twice in a row; off never pages. */
  alert: "off" | "down";
}

export function emptyDraft(type: MonitorType = "http"): CheckDraft {
  const tls = isServerEvaluated(type);
  return {
    type,
    name: "",
    target: "",
    intervalSec: tls ? TLS_DEFAULT_INTERVAL_SEC : AGENT_DEFAULT_INTERVAL_SEC,
    timeoutSec: tls ? TLS_DEFAULT_TIMEOUT_SEC : AGENT_DEFAULT_TIMEOUT_SEC,
    thresholdDays: TLS_DEFAULT_THRESHOLD_DAYS,
    assignAll: !tls,
    nodeIds: [],
    pausedNodeIds: [],
    alert: "down",
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
    intervalSec: monitor.interval_sec,
    timeoutSec: monitor.timeout_sec,
    thresholdDays: monitor.threshold_days ?? TLS_DEFAULT_THRESHOLD_DAYS,
    assignAll: !!monitor.assign_all,
    nodeIds: uniqueSorted(monitor.node_ids),
    pausedNodeIds: uniqueSorted(monitor.paused_node_ids),
    alert: monitor.alert === "off" ? "off" : "down",
  };
}

/** A name the form offers until the operator types one: "HTTP status.example.com". */
export function suggestName(type: string, target: string): string {
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

export type DraftProblem = "target" | "interval" | "timeout" | "timeoutVsInterval" | "sources" | "threshold";

export function draftProblems(draft: CheckDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (targetError(draft.type, draft.target)) out.push("target");
  const interval = Number(draft.intervalSec);
  const timeout = Number(draft.timeoutSec);
  if (!Number.isInteger(interval) || interval < CHECK_MIN_INTERVAL_SEC || interval > CHECK_MAX_INTERVAL_SEC) out.push("interval");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > CHECK_MAX_TIMEOUT_SEC) out.push("timeout");
  else if (!out.includes("interval") && timeout >= interval) out.push("timeoutVsInterval");
  if (isServerEvaluated(draft.type)) {
    const days = Number(draft.thresholdDays);
    if (!Number.isInteger(days) || days < 1 || days > TLS_MAX_THRESHOLD_DAYS) out.push("threshold");
  } else if (!draft.assignAll && draft.nodeIds.length === 0) {
    out.push("sources");
  }
  return out;
}

/** The method or the target changed: saving makes a new check and pauses this one. */
export function identityChanged(monitor: Pick<MonitorView, "type" | "target">, draft: Pick<CheckDraft, "type" | "target">): boolean {
  return monitor.type !== draft.type || (monitor.target ?? "").trim() !== draft.target.trim();
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = uniqueSorted(a);
  const y = uniqueSorted(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Whether the draft differs from what the check holds. */
export function draftChanged(monitor: MonitorView, draft: CheckDraft): boolean {
  return JSON.stringify(draftFromMonitor(monitor)) !== JSON.stringify({ ...draft, nodeIds: uniqueSorted(draft.nodeIds), pausedNodeIds: uniqueSorted(draft.pausedNodeIds) });
}

/**
 * The edit body: the version it was read at and the fields that changed.
 * Kind and target are never sent (identityChanged covers that path). A pause
 * names only sources the check runs on; a source taken off the check drops
 * its pause with it.
 */
export function buildUpdate(monitor: MonitorView, draft: CheckDraft): MonitorUpdateInput {
  const before = draftFromMonitor(monitor);
  const body: MonitorUpdateInput = { id: monitor.id, version: monitor.version ?? 0 };
  const name = draft.name.trim() || suggestName(draft.type, draft.target);
  if (name !== before.name) body.name = name;
  if (Number(draft.intervalSec) !== before.intervalSec) body.interval_sec = Number(draft.intervalSec);
  if (Number(draft.timeoutSec) !== before.timeoutSec) body.timeout_sec = Number(draft.timeoutSec);
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
  return body;
}

/** The create body for a new check (or the replacement of one whose method or target changed). */
export function buildCreate(draft: CheckDraft, withAlert: boolean): MonitorCreateInput & { alert?: MonitorAlertPolicy } {
  const base: MonitorCreateInput & { alert?: MonitorAlertPolicy } = {
    name: draft.name.trim() || suggestName(draft.type, draft.target),
    type: draft.type,
    target: draft.target.trim(),
    interval_sec: Number(draft.intervalSec),
    timeout_sec: Number(draft.timeoutSec),
  };
  if (isServerEvaluated(draft.type)) {
    base.threshold_days = Number(draft.thresholdDays);
    base.assign_all = false;
  } else {
    base.assign_all = draft.assignAll;
    if (!draft.assignAll) base.node_ids = uniqueSorted(draft.nodeIds);
  }
  if (withAlert) base.alert = draft.alert;
  return base;
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

/** When switching method, carry the assignment over: tls takes none and wants an hourly cadence. */
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
    return { stash: undefined, draft: { ...draft, type: next, ...back, nodeIds: [...back.nodeIds] } };
  }
  return { draft: { ...draft, type: next }, stash };
}
