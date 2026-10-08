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
 * A CNAME profile (record_type "cname") follows no address. The server checks
 * it every interval and records the target it confirmed in `last_target`, so
 * it is current when that matches `cname_target`, and otherwise waiting for
 * its first check after a save or an edit, then stale.
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
  record_type?: string;
  cname_target?: string;
  last_target?: string;
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
  if (ddnsRecordType(profile.record_type) === "cname") return assessCname(profile, node, now, intervalS, lastRunMs);
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

/**
 * A CNAME profile against what the server last confirmed. The node's address
 * and whether it reports play no part: the record points at the provider's
 * hostname either way, so the node list being unread leaves it checkable.
 */
function assessCname(
  profile: DdnsProfileInput,
  node: DdnsNodeInput | undefined,
  now: number,
  intervalS: number,
  lastRunMs: number | null,
): DdnsAssessment {
  const confirmed = ddnsCnameInSync(profile);
  const since = lastRunMs ?? ddnsTime(profile.created_at);
  const overdue = since !== null && now - since > DDNS_STALE_FACTOR * intervalS * 1000;
  let state: DdnsState;
  if (trimmed(profile.last_error)) state = "failing";
  else if (confirmed) state = "current";
  else state = overdue ? "stale" : "waiting";
  return { state, intervalS, moved: [], noAddress: false, nodeDown: false, nodeUnknown: !node, lastRunMs };
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
  type: "A" | "AAAA" | "CNAME";
  /** The address, or for a CNAME the target, a run writes now. */
  value: string;
  /** What the record held after the profile's last write; "" when never written. */
  previous: string;
}

/**
 * What "Run now" writes (design 23, section 3.8: a run shows what goes out).
 * The server publishes the node's current address for each enabled family,
 * to every domain; a family the node reports no address for is skipped. A
 * CNAME profile points every domain at its target instead.
 */
export function ddnsRunPreview(
  profile: DdnsProfileInput & { domains: readonly string[] },
  node: Pick<DdnsNodeInput, "public_ip" | "public_ipv6"> | undefined,
): DdnsRecordPreview[] {
  const out: DdnsRecordPreview[] = [];
  if (ddnsRecordType(profile.record_type) === "cname") {
    const target = ddnsNormalizeHost(profile.cname_target ?? "");
    for (const domain of profile.domains) {
      out.push({ domain, type: "CNAME", value: target, previous: trimmed(profile.last_target) });
    }
    return out;
  }
  const v4 = profile.enable_ipv4 ? trimmed(node?.public_ip) : "";
  const v6 = profile.enable_ipv6 ? trimmed(node?.public_ipv6) : "";
  for (const domain of profile.domains) {
    if (v4) out.push({ domain, type: "A", value: v4, previous: trimmed(profile.last_ipv4) });
    if (v6) out.push({ domain, type: "AAAA", value: v6, previous: trimmed(profile.last_ipv6) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Record type                                                         */
/* ------------------------------------------------------------------ */

/**
 * What a profile publishes: A and AAAA records from the node's IP, or a CNAME
 * to a provider's hostname, for a node whose inbound traffic arrives at the
 * provider's edge rather than at the address its traffic leaves from. An
 * empty or unknown type is the address type, as lattice-server reads it.
 */
export type DdnsRecordType = "address" | "cname";
export const DDNS_RECORD_TYPES: readonly DdnsRecordType[] = ["address", "cname"];

export function ddnsRecordType(raw: string | undefined): DdnsRecordType {
  return (raw ?? "").trim() === "cname" ? "cname" : "address";
}

/** lattice-server's ddns.NormalizeHost: trimmed, lower case, no trailing dot. */
export function ddnsNormalizeHost(name: string): string {
  const value = name.trim();
  return (value.endsWith(".") ? value.slice(0, -1) : value).toLowerCase();
}

/** The server confirmed the target the profile asks for. */
export function ddnsCnameInSync(profile: Pick<DdnsProfileInput, "cname_target" | "last_target">): boolean {
  const target = ddnsNormalizeHost(profile.cname_target ?? "");
  return target !== "" && ddnsNormalizeHost(profile.last_target ?? "") === target;
}

/** lattice-server's ddns.MaxHostnameBytes. */
export const DDNS_HOSTNAME_MAX_BYTES = 253;

export type DdnsTargetProblem =
  | { kind: "empty" }
  | { kind: "ip" }
  | { kind: "tooLong"; bytes: number }
  | { kind: "singleLabel" }
  | { kind: "emptyLabel" }
  | { kind: "labelTooLong" }
  | { kind: "hyphen" }
  | { kind: "character" }
  | { kind: "loop"; domain: string };

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const LABEL_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * The checks lattice-server's ddns.ValidateRecordSettings runs on a CNAME
 * target, in its order: a hostname rather than an IP, at most 253 bytes, at
 * least two labels, each 1 to 63 letters, digits, hyphens or underscores and
 * not starting or ending with a hyphen, and not one of the profile's own
 * names or a name under one, which would loop.
 */
export function ddnsTargetProblem(raw: string, domains: readonly string[]): DdnsTargetProblem | null {
  const target = ddnsNormalizeHost(raw);
  if (!target) return { kind: "empty" };
  if (IPV4.test(target) || target.includes(":")) return { kind: "ip" };
  const bytes = new TextEncoder().encode(target).length;
  if (bytes > DDNS_HOSTNAME_MAX_BYTES) return { kind: "tooLong", bytes };
  const labels = target.split(".");
  if (labels.length < 2) return { kind: "singleLabel" };
  for (const label of labels) {
    if (!label) return { kind: "emptyLabel" };
    if (new TextEncoder().encode(label).length > 63) return { kind: "labelTooLong" };
    if (label.startsWith("-") || label.endsWith("-")) return { kind: "hyphen" };
    if (!LABEL_CHARS.test(label)) return { kind: "character" };
  }
  for (const entry of domains) {
    const domain = ddnsNormalizeHost(entry);
    if (domain && (target === domain || target.endsWith(`.${domain}`))) return { kind: "loop", domain };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Record comments                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a Cloudflare profile writes in each record's comment. An empty or
 * unknown mode from the server is the default mode: that is how
 * lattice-server treats a profile saved before comments existed.
 */
export type DdnsCommentMode = "default" | "custom" | "none";
export const DDNS_COMMENT_MODES: readonly DdnsCommentMode[] = ["default", "custom", "none"];

/** lattice-server's ddns.DefaultCommentTemplate. */
export const DDNS_DEFAULT_COMMENT_TEMPLATE = "Lattice DDNS for #node#, #time#";
/** The Cloudflare Free plan's comment limit, which the server cuts to. */
export const DDNS_COMMENT_MAX_CHARS = 100;
/** What the server accepts as a stored template. */
export const DDNS_COMMENT_TEMPLATE_MAX_BYTES = 200;
/** lattice-server's ddns.CommentPlaceholders, in the same order. */
export const DDNS_COMMENT_PLACEHOLDERS = [
  "#node#",
  "#node_id#",
  "#profile#",
  "#domain#",
  "#type#",
  "#ip#",
  "#old_ip#",
  "#target#",
  "#time#",
  "#date#",
  "#lattice#",
] as const;

export function ddnsCommentMode(raw: string | undefined): DdnsCommentMode {
  return raw === "custom" || raw === "none" ? raw : "default";
}

export interface DdnsCommentVars {
  node: string;
  node_id: string;
  profile: string;
  domain: string;
  type: string;
  ip: string;
  old_ip: string;
  /** The CNAME target; empty for an A or AAAA record, as #ip# is for a CNAME. */
  target: string;
  lattice: string;
  /** ms epoch; rendered in UTC as the server does. */
  now: number;
}

export interface DdnsCommentPreview {
  /** The comment as Cloudflare would store it. */
  text: string;
  /** Characters in `text`. */
  chars: number;
  /** Characters before the cut; more than DDNS_COMMENT_MAX_CHARS when cut. */
  fullChars: number;
}

// The known names spelled out, so an unknown #x# next to #node# does not
// swallow the leading # the way a generic pattern would. Longest first.
const KNOWN_PLACEHOLDER = /#(?:node_id|node|profile|domain|type|ip|old_ip|target|time|date|lattice)#/g;
const ANY_PLACEHOLDER = /#[A-Za-z0-9_]+#/g;
const CONTROL = /\p{Cc}/gu;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Mirrors ddns.RenderComment: fill, flatten to one line, cut to 100 characters. */
export function renderDdnsComment(template: string, vars: DdnsCommentVars): DdnsCommentPreview {
  const when = new Date(vars.now);
  const date = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`;
  const values: Record<string, string> = {
    "#node#": vars.node,
    "#node_id#": vars.node_id,
    "#profile#": vars.profile,
    "#domain#": vars.domain,
    "#type#": vars.type,
    "#ip#": vars.ip,
    "#old_ip#": vars.old_ip,
    "#target#": vars.target,
    "#time#": `${date} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}Z`,
    "#date#": date,
    "#lattice#": vars.lattice,
  };
  const filled = template.replace(KNOWN_PLACEHOLDER, (token) => values[token] ?? token).replace(CONTROL, " ").trim();
  const chars = Array.from(filled);
  if (chars.length <= DDNS_COMMENT_MAX_CHARS) return { text: filled, chars: chars.length, fullChars: chars.length };
  const text = chars.slice(0, DDNS_COMMENT_MAX_CHARS).join("").trim();
  return { text, chars: Array.from(text).length, fullChars: chars.length };
}

export type DdnsTemplateProblem =
  | { kind: "empty" }
  | { kind: "lineBreak" }
  | { kind: "tooLong"; bytes: number }
  | { kind: "unknown"; placeholder: string };

/** The checks lattice-server runs on a custom template before it saves it. */
export function ddnsTemplateProblem(template: string): DdnsTemplateProblem | null {
  if (!template.trim()) return { kind: "empty" };
  if (/[\r\n]/.test(template)) return { kind: "lineBreak" };
  const bytes = new TextEncoder().encode(template).length;
  if (bytes > DDNS_COMMENT_TEMPLATE_MAX_BYTES) return { kind: "tooLong", bytes };
  const known = new Set<string>(DDNS_COMMENT_PLACEHOLDERS);
  for (const found of template.match(ANY_PLACEHOLDER) ?? []) {
    if (!known.has(found)) return { kind: "unknown", placeholder: found };
  }
  return null;
}

/** Inserts a placeholder at the caret, replacing any selection. */
export function insertDdnsPlaceholder(
  template: string,
  placeholder: string,
  start: number | null | undefined,
  end: number | null | undefined,
): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start ?? template.length, template.length));
  const to = Math.max(from, Math.min(end ?? from, template.length));
  return { value: template.slice(0, from) + placeholder + template.slice(to), caret: from + placeholder.length };
}

const CLOUDFLARE_API_ERROR = /cloudflare: api error \(status (\d+)\): (.*)$/;

/**
 * A run's error as a person reads it. lattice-server joins one line per failed
 * record ("A name: cause"); a Cloudflare refusal carries the raw JSON error
 * list, which is reduced to its messages and codes. A plain sentence, such as
 * the one naming a CNAME in the way, passes through unchanged.
 */
export function ddnsErrorText(
  lastError: string | undefined,
  refused: (status: string, said: string) => string = (status, said) => `Cloudflare refused it, HTTP ${status}: ${said}`,
): string {
  const lines = (lastError ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .map((line) => {
      const match = CLOUDFLARE_API_ERROR.exec(line);
      if (!match) return line;
      let items: unknown;
      try {
        items = JSON.parse(match[2] ?? "");
      } catch {
        return line;
      }
      if (!Array.isArray(items) || items.length === 0) return line;
      const said = items
        .map((item: { code?: unknown; message?: unknown }) => {
          const message = typeof item?.message === "string" ? item.message.trim() : "";
          const code = typeof item?.code === "number" ? ` (code ${item.code})` : "";
          return message ? `${message}${code}` : "";
        })
        .filter(Boolean)
        .join("; ");
      if (!said) return line;
      return `${line.slice(0, match.index)}${refused(match[1] ?? "", said)}`;
    })
    .join("\n");
}
