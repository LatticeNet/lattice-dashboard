// What node.offline does for each node, read from node tags the same way the
// server reads them (internal/server/node_offline_alerts.go): the quiet tag
// wins, of several valid delay tags the longest wins, and a delay tag that
// does not parse falls back to the default. The server ignores a bad tag
// silently, so this is where the operator finds out.

export const NODE_OFFLINE_EVENT = "node.offline";
export const DEFAULT_OFFLINE_MINUTES = 10;
export const QUIET_TAG = "no-offline-alert";
export const DELAY_TAG_PREFIX = "offline-alert-after:";
const MIN_MINUTES = 2;
const MAX_MINUTES = 7 * 24 * 60;

export function ruleRoutesNodeOffline(rule: { event_types?: string[] | null }): boolean {
  const events = rule.event_types ?? [];
  return events.length === 0 || events.includes("*") || events.includes(NODE_OFFLINE_EVENT);
}

/** Minutes from "offline-alert-after:<digits><m|h>", or null when it does not parse. */
export function parseDelayTag(tag: string): number | null {
  const lower = tag.trim().toLowerCase();
  if (!lower.startsWith(DELAY_TAG_PREFIX)) return null;
  const value = lower.slice(DELAY_TAG_PREFIX.length);
  const match = /^(\d{1,5})([mh])$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * (match[2] === "h" ? 60 : 1);
  return minutes >= MIN_MINUTES && minutes <= MAX_MINUTES ? minutes : null;
}

export interface OfflinePolicyNode {
  id: string;
  name?: string;
  tags?: string[] | null;
}

export interface NodeOfflinePolicy {
  /** Nodes that page after the default delay. */
  defaultCount: number;
  /** Nodes with their own delay, longest first. */
  delayed: { name: string; minutes: number }[];
  /** Nodes that never page. */
  quiet: string[];
  /**
   * Delay tags the server will ignore, with the node they sit on. Listed even
   * when the node is quiet or has another valid delay: a typo is worth
   * fixing wherever it sits, and the counts above already say what the node
   * actually does.
   */
  invalid: { name: string; tag: string }[];
}

export function nodeOfflinePolicy(nodes: OfflinePolicyNode[]): NodeOfflinePolicy {
  const out: NodeOfflinePolicy = { defaultCount: 0, delayed: [], quiet: [], invalid: [] };
  for (const node of nodes) {
    const name = node.name?.trim() || node.id;
    let quiet = false;
    let minutes = 0;
    for (const tag of node.tags ?? []) {
      const lower = tag.trim().toLowerCase();
      if (lower === QUIET_TAG) quiet = true;
      else if (lower.startsWith(DELAY_TAG_PREFIX)) {
        const parsed = parseDelayTag(lower);
        if (parsed === null) out.invalid.push({ name, tag: tag.trim() });
        else minutes = Math.max(minutes, parsed);
      }
    }
    if (quiet) out.quiet.push(name);
    else if (minutes > 0) out.delayed.push({ name, minutes });
    else out.defaultCount++;
  }
  out.delayed.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
  out.quiet.sort((a, b) => a.localeCompare(b));
  return out;
}

/** "10 min", "3 h", "1 h 30 min", matching the server's phone copy. */
export function formatOfflineDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
