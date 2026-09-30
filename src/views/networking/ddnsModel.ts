/**
 * Pure model for the DDNS page (design 23, section 4.4): whether each
 * profile's public records are right, and what the page head counts.
 *
 * What "stale" can mean is set by how lattice-server publishes. Its sweep
 * wakes every minute and writes a profile only when the node's address has
 * moved away from what the profile last wrote, or when the last write failed
 * (server.go, sweepDDNSOnce). `last_run_at` therefore stays put for as long
 * as an address holds still: a datacenter node whose profile last ran four
 * months ago is correct, not late. A profile is stale when the node reports
 * an address the profile has not written and the profile has not run for
 * twice its interval, which is past the point where the sweep should have
 * caught up. Until then it is waiting for the next sweep. A profile that has
 * never written anything is stale once twice its interval has passed since it
 * was created.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */

/** lattice-server's ddnsDefaultInterval, for a profile that sets none. */
export const DDNS_DEFAULT_INTERVAL_S = 300;
/** A profile is overdue once this many intervals pass without a run. */
export const DDNS_STALE_FACTOR = 2;

/**
 * `unchecked` is a profile whose node this page has no address for (the node
 * list was not read, or does not hold the node): it has not failed, and
 * nothing says whether its records are right.
 */
export type DdnsState = "failing" | "stale" | "waiting" | "current" | "unchecked";

export type DdnsFamily = "v4" | "v6";

export interface DdnsProfileInput {
  id: string;
  node_id: string;
  enable_ipv4: boolean;
  enable_ipv6: boolean;
  interval_seconds?: number;
  last_ipv4?: string;
  last_ipv6?: string;
  last_run_at?: string;
  last_error?: string;
  created_at?: string;
}

export interface DdnsNodeInput {
  public_ip?: string;
  public_ipv6?: string;
  /** The agent is not in contact (offline, never reported, disabled). */
  down: boolean;
}

export interface DdnsMove {
  family: DdnsFamily;
  /** What the profile last wrote; "" when it never wrote this family. */
  published: string;
  /** What the node reports now. */
  current: string;
}

export interface DdnsAssessment {
  state: DdnsState;
  /** Seconds between attempts, the server default filled in. */
  intervalS: number;
  /** Families whose record differs from the node's address. */
  moved: DdnsMove[];
  /** The node reports no address for any family the profile writes. */
  noAddress: boolean;
  /** The profile's node is not reporting; it cannot follow a new address. */
  nodeDown: boolean;
  /** The node is not in the node list (deleted, or out of this session's scope). */
  nodeUnknown: boolean;
  /** Last run, ms epoch, or null when the profile never ran. */
  lastRunMs: number | null;
}

const EARLIEST_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);

/** A timestamp as ms epoch, or null for absent, unparsable or Go zero times. */
export function ddnsTime(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms < EARLIEST_PLAUSIBLE_MS ? null : ms;
}

export function ddnsInterval(profile: Pick<DdnsProfileInput, "interval_seconds">): number {
  const seconds = profile.interval_seconds ?? 0;
  return seconds > 0 ? seconds : DDNS_DEFAULT_INTERVAL_S;
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

export function assessDdns(profile: DdnsProfileInput, node: DdnsNodeInput | undefined, now: number): DdnsAssessment {
  const intervalS = ddnsInterval(profile);
  const lastRunMs = ddnsTime(profile.last_run_at);
  const moved: DdnsMove[] = [];
  let noAddress = false;

  if (node) {
    const wanted: { family: DdnsFamily; on: boolean; current: string; published: string }[] = [
      { family: "v4", on: profile.enable_ipv4, current: trimmed(node.public_ip), published: trimmed(profile.last_ipv4) },
      { family: "v6", on: profile.enable_ipv6, current: trimmed(node.public_ipv6), published: trimmed(profile.last_ipv6) },
    ];
    const enabled = wanted.filter((entry) => entry.on);
    for (const entry of enabled) {
      if (entry.current && entry.current !== entry.published) {
        moved.push({ family: entry.family, published: entry.published, current: entry.current });
      }
    }
    noAddress = enabled.length > 0 && enabled.every((entry) => !entry.current);
  }

  const since = lastRunMs ?? ddnsTime(profile.created_at);
  const overdue = since !== null && now - since > DDNS_STALE_FACTOR * intervalS * 1000;

  let state: DdnsState;
  if (trimmed(profile.last_error)) state = "failing";
  else if (!node) state = "unchecked";
  else if (moved.length > 0) state = overdue ? "stale" : "waiting";
  else if (lastRunMs === null) state = overdue ? "stale" : "waiting";
  else state = "current";

  return {
    state,
    intervalS,
    moved,
    noAddress,
    nodeDown: !!node?.down,
    nodeUnknown: !node,
    lastRunMs,
  };
}

export interface DdnsCounts {
  total: number;
  current: number;
  failing: number;
  stale: number;
  waiting: number;
  unchecked: number;
  /** Profiles whose node is not reporting, whatever their state. */
  nodeDown: number;
}

export function ddnsCounts(assessments: readonly DdnsAssessment[]): DdnsCounts {
  const counts: DdnsCounts = { total: assessments.length, current: 0, failing: 0, stale: 0, waiting: 0, unchecked: 0, nodeDown: 0 };
  for (const entry of assessments) {
    counts[entry.state] += 1;
    if (entry.nodeDown) counts.nodeDown += 1;
  }
  return counts;
}

/** The subsets the collection filters to, on `?show=`. */
export const DDNS_SHOWS = ["all", "failing", "stale", "down"] as const;
export type DdnsShow = (typeof DDNS_SHOWS)[number];

export function parseDdnsShow(raw: unknown): DdnsShow {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && (DDNS_SHOWS as readonly string[]).includes(value) ? (value as DdnsShow) : "all";
}

export function ddnsMatchesShow(assessment: DdnsAssessment, show: DdnsShow): boolean {
  switch (show) {
    case "failing":
      return assessment.state === "failing";
    case "stale":
      return assessment.state === "stale";
    case "down":
      return assessment.nodeDown;
    default:
      return true;
  }
}

export interface DdnsRecordPreview {
  domain: string;
  type: "A" | "AAAA";
  /** The address a run writes now. */
  value: string;
  /** What the record held after the profile's last write; "" when never written. */
  previous: string;
}

/**
 * What "Run now" writes (design 23, section 3.8: a run shows what goes out).
 * The server publishes the node's current address for each enabled family,
 * to every domain; a family the node reports no address for is skipped.
 */
export function ddnsRunPreview(
  profile: DdnsProfileInput & { domains: readonly string[] },
  node: Pick<DdnsNodeInput, "public_ip" | "public_ipv6"> | undefined,
): DdnsRecordPreview[] {
  const out: DdnsRecordPreview[] = [];
  const v4 = profile.enable_ipv4 ? trimmed(node?.public_ip) : "";
  const v6 = profile.enable_ipv6 ? trimmed(node?.public_ipv6) : "";
  for (const domain of profile.domains) {
    if (v4) out.push({ domain, type: "A", value: v4, previous: trimmed(profile.last_ipv4) });
    if (v6) out.push({ domain, type: "AAAA", value: v6, previous: trimmed(profile.last_ipv6) });
  }
  return out;
}
