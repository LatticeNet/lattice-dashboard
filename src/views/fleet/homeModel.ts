/**
 * Pure model for home (design 23, section 4.1): what needs the operator, as
 * facts the page words and links.
 *
 *   Attention  DMIT-4 offline 6d · mac-air offline 14 times in 24h ·
 *              1 task stalled · 2 DDNS profiles failing · 2 renewals overdue
 *
 * Offline, never-reported and degraded nodes each get a row, worst first;
 * a node that keeps dropping (the flips the audit log records) gets one too,
 * even when it is online right now, because an agent that drops fourteen
 * times a day is the problem the online count hides. Disabled nodes do not:
 * somebody switched them off on purpose. Things that are counted rather than
 * named (stalled tasks, failing DDNS profiles, renewals) get one row each.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { AuditEvent, AuditQueryResponse, DDNSView, ExpiringItem, TaskCounts } from "@/lib/api/types";
import { compareByAttention, nodeStatus, nodeStatusSince, type NodeStatusInput } from "@/lib/nodeStatus";

/** A node that went offline this many times in the window is flapping. */
export const FLAP_THRESHOLD = 3;
export const FLAP_WINDOW_MS = 24 * 3_600_000;
/** What home reads to find them: the offline transitions in the window. */
export const FLAP_READ_LIMIT = 500;
/** Rows home's "due in 7 days" shows before deferring to Upcoming. */
export const DUE_ROWS = 5;
/** Rows of recent changes home reads and shows; the Audit page has the rest. */
export const CHANGES_ROWS = 4;
/** Attention rows home shows before "Show all N", so the page fits one desktop screen. */
export const HOME_ATTENTION_MAX = 3;
export const DUE_WITHIN_DAYS = 7;

/** The audit query that counts flips: one action, one window. */
export function flipQuery(now: number): { action: string; at_from: string; limit: number } {
  return { action: "node.offline", at_from: new Date(now - FLAP_WINDOW_MS).toISOString(), limit: FLAP_READ_LIMIT };
}

/** Recent activity shows changes: node flips and observe events stay out (design 23, 4.1). */
export const CHANGES_QUERY = { exclude_action: "node.online,node.offline", exclude_decision: "observe" } as const;

/** Whether an audit row is a change by CHANGES_QUERY's rule, matched as the server matches it (action prefixes). */
export function isChange(event: Pick<AuditEvent, "action" | "decision">): boolean {
  const prefixes = CHANGES_QUERY.exclude_action.split(",");
  const decisions: string[] = CHANGES_QUERY.exclude_decision.split(",");
  return !decisions.includes(event.decision) && !prefixes.some((prefix) => event.action.startsWith(prefix));
}

/**
 * The changes in an answer to CHANGES_QUERY. A server from before the
 * exclusions (pre a101) ignores them and returns flips and observe events;
 * those are dropped here, and `ignored` says the server did not filter, so
 * the page does not claim the rows are the latest changes.
 */
export function changesOnly<T extends Pick<AuditEvent, "action" | "decision">>(events: readonly T[]): { events: T[]; ignored: boolean } {
  const kept = events.filter(isChange);
  return { events: kept, ignored: kept.length < events.length };
}

/**
 * Whether the flip read missed offline transitions in the window: the
 * server returned fewer rows than it counted (the read limit), or its scan
 * stopped at the cap. Counts from such a read are lower bounds.
 */
export function flipReadPartial(response: Pick<AuditQueryResponse, "total" | "complete"> & { events?: readonly unknown[] }): boolean {
  return response.complete === false || (response.events?.length ?? 0) < response.total;
}

export interface Flap {
  nodeId: string;
  count: number;
  /** When it last went offline (ms epoch). */
  lastAt: number;
}

/** Offline transitions per node, from the flip read; flapping nodes only, most first. */
export function flappingNodes(events: readonly Pick<AuditEvent, "node_id" | "action" | "at">[], threshold = FLAP_THRESHOLD): Flap[] {
  const byNode = new Map<string, Flap>();
  for (const event of events) {
    if (event.action !== "node.offline" || !event.node_id) continue;
    const at = Date.parse(event.at);
    const entry = byNode.get(event.node_id) ?? { nodeId: event.node_id, count: 0, lastAt: 0 };
    entry.count += 1;
    if (!Number.isNaN(at) && at > entry.lastAt) entry.lastAt = at;
    byNode.set(event.node_id, entry);
  }
  return [...byNode.values()].filter((flap) => flap.count >= threshold).sort((a, b) => b.count - a.count || a.nodeId.localeCompare(b.nodeId));
}

export type HomeAttention =
  | {
      kind: "node";
      key: string;
      tone: "danger" | "warning";
      nodeId: string;
      name: string;
      status: "offline" | "never_reported" | "degraded";
      sinceMs?: number;
      /** How long ago the last report came; undefined when none ever did. */
      lastSeenMs?: number;
      agentVersion?: string;
      /** The server's sentence. Shown only for degraded, where it names the broken part. */
      reason: string;
    }
  | { kind: "flapping"; key: string; tone: "warning"; nodeId: string; name: string; count: number; lastAt: number; atLeast: boolean }
  | { kind: "stalled"; key: string; tone: "danger"; count: number }
  | { kind: "ddns"; key: string; tone: "warning"; count: number; names: string[]; error: string }
  | { kind: "overdue"; key: string; tone: "danger"; count: number; titles: string[] }
  | { kind: "due"; key: string; tone: "warning"; count: number; titles: string[] }
  | { kind: "monitors"; key: string; tone: "danger"; count: number; names: string[]; firstId: string };

export interface HomeNode extends NodeStatusInput {
  id: string;
  name?: string;
  agent_version?: string;
}

export interface HomeAttentionInput {
  now: number;
  nodes?: readonly HomeNode[];
  flaps?: readonly Flap[];
  /** The flip read missed rows (flipReadPartial), so each count is "at least". */
  flapsPartial?: boolean;
  counts?: Pick<TaskCounts, "stalled">;
  ddns?: readonly Pick<DDNSView, "name" | "last_error">[];
  /** Items from the expiring read; the model keeps those within 7 days. */
  expiring?: readonly Pick<ExpiringItem, "title" | "days" | "state">[];
  /** Monitors whose newest results include a failure, worst first. */
  failingMonitors?: readonly { id: string; name: string }[];
}

/**
 * The attention items, worst first within a tone (AttentionList sorts by
 * tone). A read that has not landed contributes nothing: the page's proof
 * line says it was not read, and an attention list never claims an all-clear
 * for something it did not see.
 */
export function homeAttention(input: HomeAttentionInput): HomeAttention[] {
  const out: HomeAttention[] = [];
  const nodes = [...(input.nodes ?? [])].sort((a, b) => compareByAttention(a, b) || (a.name ?? a.id).localeCompare(b.name ?? b.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const status = nodeStatus(node);
    if (status !== "offline" && status !== "never_reported" && status !== "degraded") continue;
    const since = nodeStatusSince(node);
    const sinceAt = since ? Date.parse(since) : NaN;
    const seenAt = node.last_seen ? Date.parse(node.last_seen) : NaN;
    // A zero time (0001-01-01) is the server's "never"; it parses to a negative instant.
    const seen = !Number.isNaN(seenAt) && seenAt > 0;
    out.push({
      kind: "node",
      key: `node:${node.id}`,
      tone: status === "offline" ? "danger" : "warning",
      nodeId: node.id,
      name: node.name || node.id,
      status,
      sinceMs: Number.isNaN(sinceAt) ? undefined : Math.max(0, input.now - sinceAt),
      lastSeenMs: seen ? Math.max(0, input.now - seenAt) : undefined,
      agentVersion: node.agent_version?.trim() || undefined,
      reason: node.status_reason?.trim() ?? "",
    });
  }
  for (const flap of input.flaps ?? []) {
    const node = byId.get(flap.nodeId);
    // An offline node already has its row; a disabled one was switched off.
    if (node && ["offline", "disabled"].includes(nodeStatus(node))) continue;
    out.push({
      kind: "flapping",
      key: `flap:${flap.nodeId}`,
      tone: "warning",
      nodeId: flap.nodeId,
      name: node?.name || flap.nodeId,
      count: flap.count,
      lastAt: flap.lastAt,
      atLeast: !!input.flapsPartial,
    });
  }
  const stalled = input.counts?.stalled ?? 0;
  if (stalled > 0) out.push({ kind: "stalled", key: "tasks:stalled", tone: "danger", count: stalled });
  const monitors = input.failingMonitors ?? [];
  if (monitors.length > 0) {
    out.push({ kind: "monitors", key: "monitors:failing", tone: "danger", count: monitors.length, names: monitors.map((m) => m.name), firstId: monitors[0]!.id });
  }
  const failing = (input.ddns ?? []).filter((profile) => profile.last_error?.trim());
  if (failing.length > 0) {
    out.push({ kind: "ddns", key: "ddns:failing", tone: "warning", count: failing.length, names: failing.map((profile) => profile.name), error: failing[0]!.last_error!.trim() });
  }
  const soon = (input.expiring ?? []).filter((item) => item.days <= DUE_WITHIN_DAYS && item.state !== "auto");
  const overdue = soon.filter((item) => item.days < 0 || item.state === "overdue");
  const due = soon.filter((item) => !overdue.includes(item));
  if (overdue.length > 0) out.push({ kind: "overdue", key: "expiring:overdue", tone: "danger", count: overdue.length, titles: overdue.map((item) => item.title) });
  if (due.length > 0) out.push({ kind: "due", key: "expiring:due", tone: "warning", count: due.length, titles: due.map((item) => item.title) });
  return out;
}

/**
 * Home's "due in 7 days": what needs a hand first (overdue, then by date),
 * at most DUE_ROWS, and how many auto-renewals fall in the same week (they
 * renew by themselves, so they are counted, not listed).
 */
export function dueThisWeek<T extends Pick<ExpiringItem, "days" | "state" | "title">>(items: readonly T[], rows = DUE_ROWS): { shown: T[]; more: number; auto: number } {
  const week = items.filter((item) => item.days <= DUE_WITHIN_DAYS);
  const manual = week.filter((item) => item.state !== "auto").sort((a, b) => a.days - b.days || a.title.localeCompare(b.title));
  return { shown: manual.slice(0, rows), more: Math.max(0, manual.length - rows), auto: week.length - manual.length };
}

/** The first thing past the week, so an empty week still says what comes next. */
export function nextAfterWeek<T extends Pick<ExpiringItem, "days" | "state">>(items: readonly T[]): T | undefined {
  return [...items].filter((item) => item.days > DUE_WITHIN_DAYS).sort((a, b) => a.days - b.days)[0];
}

/** What one of home's reads holds right now, so a number is never printed for a read that did not land. */
export type ReadState = "reading" | "ready" | "failed" | "forbidden" | "unsupported";

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Ready whenever a good read is held, even if the last refresh failed (the
 * proof line says the page is stale); otherwise why there is no number. A
 * 404 is a server without the read, whatever an earlier image answered.
 */
export function readState(input: { data?: unknown; error?: unknown }): ReadState {
  const code = statusOf(input.error);
  if (code === 404) return "unsupported";
  if (input.data !== undefined) return "ready";
  if (input.error) return code === 403 ? "forbidden" : "failed";
  return "reading";
}
