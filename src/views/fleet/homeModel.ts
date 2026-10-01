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
import type { AuditEvent, DDNSView, ExpiringItem, TaskCounts } from "@/lib/api/types";
import { compareByAttention, nodeStatus, nodeStatusSince, type NodeStatusInput } from "@/lib/nodeStatus";

/** A node that went offline this many times in the window is flapping. */
export const FLAP_THRESHOLD = 3;
export const FLAP_WINDOW_MS = 24 * 3_600_000;
/** What home reads to find them: the offline transitions in the window. */
export const FLAP_READ_LIMIT = 500;
/** Rows home's "due in 7 days" shows before deferring to Upcoming. */
export const DUE_ROWS = 5;
export const DUE_WITHIN_DAYS = 7;

/** The audit query that counts flips: one action, one window. */
export function flipQuery(now: number): { action: string; at_from: string; limit: number } {
  return { action: "node.offline", at_from: new Date(now - FLAP_WINDOW_MS).toISOString(), limit: FLAP_READ_LIMIT };
}

/** Recent activity shows changes: node flips and observe events stay out (design 23, 4.1). */
export const CHANGES_QUERY = { exclude_action: "node.online,node.offline", exclude_decision: "observe" } as const;

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
  | { kind: "node"; key: string; tone: "danger" | "warning"; nodeId: string; name: string; status: "offline" | "never_reported" | "degraded"; sinceMs?: number; reason: string }
  | { kind: "flapping"; key: string; tone: "warning"; nodeId: string; name: string; count: number; lastAt: number }
  | { kind: "stalled"; key: string; tone: "danger"; count: number }
  | { kind: "ddns"; key: string; tone: "warning"; count: number; names: string[]; error: string }
  | { kind: "overdue"; key: string; tone: "danger"; count: number; titles: string[] }
  | { kind: "due"; key: string; tone: "warning"; count: number; titles: string[] };

export interface HomeNode extends NodeStatusInput {
  id: string;
  name?: string;
}

export interface HomeAttentionInput {
  now: number;
  nodes?: readonly HomeNode[];
  flaps?: readonly Flap[];
  counts?: Pick<TaskCounts, "stalled">;
  ddns?: readonly Pick<DDNSView, "name" | "last_error">[];
  /** Items from the expiring read; the model keeps those within 7 days. */
  expiring?: readonly Pick<ExpiringItem, "title" | "days" | "state">[];
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
    out.push({
      kind: "node",
      key: `node:${node.id}`,
      tone: status === "offline" ? "danger" : "warning",
      nodeId: node.id,
      name: node.name || node.id,
      status,
      sinceMs: Number.isNaN(sinceAt) ? undefined : Math.max(0, input.now - sinceAt),
      reason: node.status_reason?.trim() ?? "",
    });
  }
  for (const flap of input.flaps ?? []) {
    const node = byId.get(flap.nodeId);
    // An offline node already has its row; a disabled one was switched off.
    if (node && ["offline", "disabled"].includes(nodeStatus(node))) continue;
    out.push({ kind: "flapping", key: `flap:${flap.nodeId}`, tone: "warning", nodeId: flap.nodeId, name: node?.name || flap.nodeId, count: flap.count, lastAt: flap.lastAt });
  }
  const stalled = input.counts?.stalled ?? 0;
  if (stalled > 0) out.push({ kind: "stalled", key: "tasks:stalled", tone: "danger", count: stalled });
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
