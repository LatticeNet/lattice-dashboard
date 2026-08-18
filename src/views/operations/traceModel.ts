/**
 * Pure model for the correlation trace: given the audit events that share one
 * correlation id, order them into a timeline and pull out the approval / task
 * references buried in their metadata so the view can resolve the wider
 * operation (plan -> approve -> run -> per-node result) that a single request
 * touched. Kept free of Vue so `node --test` covers it directly.
 */
import type { AuditEvent } from "@/lib/api/types";

/** Metadata keys that carry a durable cross-request link. */
const APPROVAL_KEYS = ["approval_id"] as const;
const TASK_KEYS = ["task_id"] as const;

function metaString(event: AuditEvent, key: string): string | undefined {
  const v = event.metadata?.[key];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

/** Distinct approval ids referenced across the event group, in first-seen order. */
export function referencedApprovalIds(events: readonly AuditEvent[]): string[] {
  return distinctRefs(events, APPROVAL_KEYS);
}

/** Distinct task ids referenced across the event group, in first-seen order. */
export function referencedTaskIds(events: readonly AuditEvent[]): string[] {
  return distinctRefs(events, TASK_KEYS);
}

function distinctRefs(events: readonly AuditEvent[], keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) {
    for (const key of keys) {
      const id = metaString(event, key);
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Chronological order (oldest first) so the timeline reads top-to-bottom as it
 *  happened; ties break by id for stability. */
export function orderTimeline(events: readonly AuditEvent[]): AuditEvent[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    const na = Number.isNaN(ta) ? 0 : ta;
    const nb = Number.isNaN(tb) ? 0 : tb;
    if (na !== nb) return na - nb;
    return a.id.localeCompare(b.id);
  });
}

export interface TraceSummary {
  total: number;
  denied: number;
  firstAt?: string;
  lastAt?: string;
  /** Distinct nodes touched by the group (node_id present). */
  nodes: string[];
}

/** Headline counts for the trace header. */
export function summarize(events: readonly AuditEvent[]): TraceSummary {
  const ordered = orderTimeline(events);
  const nodes = new Set<string>();
  let denied = 0;
  for (const event of events) {
    if (event.decision === "deny") denied++;
    if (event.node_id) nodes.add(event.node_id);
  }
  return {
    total: events.length,
    denied,
    firstAt: ordered[0]?.at,
    lastAt: ordered[ordered.length - 1]?.at,
    nodes: [...nodes].sort((a, b) => a.localeCompare(b)),
  };
}
