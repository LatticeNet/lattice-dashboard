/**
 * The check rules of design 29 M2a, as lattice-sdk model/monitor_checks.go
 * has them: which kinds an agent runs, expected status sets, request header
 * rules, the origin secrets are bound to, and the destinations an agent
 * refuses. The server and the agents apply the Go functions; the console
 * mirrors them so the editor refuses what the server would, before saving,
 * with the same reason. The server stays the authority.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { LatencyProbePlan, MonitorView, Node } from "@/lib/api/types";

/* ------------------------------------------------------------------ */
/* Probe methods (Node.probe_methods, D11 capability facts)             */
/* ------------------------------------------------------------------ */

/** What an agent that reports nothing runs: every agent before M2a. */
export const LEGACY_PROBE_METHODS: readonly string[] = ["http", "tcp"];
const KNOWN_PROBE_METHODS = new Set(["tcp", "http", "icmp", "beacon", "dns"]);

/** The known kinds of a report, once each and sorted (model.NormalizeProbeMethods). */
export function normalizeProbeMethods(list: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const kind = String(raw).trim();
    if (KNOWN_PROBE_METHODS.has(kind)) out.add(kind);
  }
  return [...out].sort();
}

/** What a node's agent runs (model.EffectiveProbeMethods): its report, or tcp and http when it reported nothing. */
export function effectiveProbeMethods(node: Pick<Node, "probe_methods"> | undefined): string[] {
  const reported = node?.probe_methods;
  if (!reported || reported.length === 0) return [...LEGACY_PROBE_METHODS];
  return normalizeProbeMethods(reported);
}

type M2aMonitorFields = Pick<MonitorView, "target_node" | "packets" | "expect_status" | "headers" | "secrets_origin" | "latest">;

/** Whether a check carries a field only an M2a server writes. */
export function monitorSpeaksM2a(monitor: M2aMonitorFields | undefined): boolean {
  if (!monitor) return false;
  if (monitor.target_node || monitor.packets || monitor.expect_status || monitor.secrets_origin || monitor.headers?.length) return true;
  return (monitor.latest ?? []).some((l) => l.sent !== undefined || !!l.reason);
}

/**
 * Whether the server speaks M2a, read from its answers rather than a
 * version: an M2a server lists `probe_methods` on every node (the effective
 * list, never empty), its latency plan names each pair's method, and its
 * checks carry M2a fields. A session that reads none of these, one that
 * cannot read nodes and has no path set among them, is treated as talking
 * to an older server unless a check says otherwise.
 */
export function serverSpeaksM2a(
  nodes: readonly Pick<Node, "probe_methods">[] | undefined,
  plan?: Pick<LatencyProbePlan, "pairs" | "config"> | null,
  monitors?: readonly M2aMonitorFields[],
): boolean {
  if ((nodes ?? []).some((n) => Array.isArray(n.probe_methods))) return true;
  if ((monitors ?? []).some(monitorSpeaksM2a)) return true;
  if (!plan) return false;
  return typeof plan.config?.method === "string" || (plan.pairs ?? []).some((p) => typeof p.method === "string" && p.method !== "");
}

/**
 * Whether the server speaks design 29 M2b (the beacon), read from its
 * answers as M2a is: a node whose agent reports beacon facts or runs the
 * beacon client, a plan node with a beacon endpoint or a generated beacon
 * check, a pair or a check that probes by beacon, or a reachability check.
 * An M2b server whose agents all predate M2b answers none of these; it then
 * has no source that could send a beacon request either, so the console
 * offers nothing new until one does.
 */
export function serverSpeaksM2b(
  nodes: readonly Pick<Node, "probe_methods" | "beacon">[] | undefined,
  plan?: Pick<LatencyProbePlan, "pairs" | "nodes" | "config"> | null,
  monitors?: readonly Pick<MonitorView, "type" | "managed_by">[],
): boolean {
  if ((nodes ?? []).some((n) => !!n.beacon || (n.probe_methods ?? []).includes("beacon"))) return true;
  if ((monitors ?? []).some((m) => m.type === "beacon" || m.managed_by === "beacon")) return true;
  if (!plan) return false;
  if ((plan.nodes ?? []).some((n) => !!n.beacon_target || !!n.beacon_monitor_id)) return true;
  if (plan.config?.method === "beacon" || Object.values(plan.config?.source_methods ?? {}).includes("beacon")) return true;
  return (plan.pairs ?? []).some((p) => p.method === "beacon");
}

/** Kinds a node runs as a source: the agent kinds. tls runs on the control plane. */
export function runsOnAgent(kind: string): boolean {
  return kind === "tcp" || kind === "http" || kind === "icmp" || kind === "beacon" || kind === "dns";
}

export type SourceSupport = { ok: true } | { ok: false; reason: string };

/**
 * Whether the node's agent reported its methods, as an M2a agent does. The
 * node read carries the effective list, which is tcp and http for an agent
 * that reported nothing, so the two are told apart by icmp: an M2a agent
 * always names it, among its methods or among its refusals.
 */
export function agentReportsMethods(node: Pick<Node, "probe_methods" | "probe_refusals"> | undefined): boolean {
  if (!node) return false;
  return (node.probe_methods ?? []).includes("icmp") || Object.keys(node.probe_refusals ?? {}).length > 0;
}

/**
 * Whether an http check uses a field agents older than M2a ignore: any
 * request header, or a status set other than the default (the server's
 * monitorNeedsCurrentAgent). The server sends such a check only to agents
 * that report their methods; on an older one its path reads agent_too_old.
 */
export function needsCurrentAgent(kind: string, expectStatus: string, headerCount: number): boolean {
  if (kind !== "http") return false;
  if (headerCount > 0) return true;
  if (!expectStatus.trim()) return false;
  const set = parseStatusSet(expectStatus);
  return !set.ok || set.canonical !== EXPECT_STATUS_DEFAULT;
}

/**
 * Whether a node can be a source for a kind. On a server before M2a every
 * agent runs tcp and http and nothing else is offered, so everything is
 * supported. Otherwise a kind the agent does not report is refused: with
 * the host's refusal code when the agent named one (icmp_not_permitted),
 * else agent_too_old, the reasons the path would read. An http check that
 * needs a current agent (needsCurrentAgent) is refused on an agent that
 * reports nothing. A node this session cannot see is the server's to judge.
 */
export function sourceSupport(node: Pick<Node, "probe_methods" | "probe_refusals"> | undefined, kind: string, m2a: boolean, current = false): SourceSupport {
  if (!m2a || !runsOnAgent(kind) || !node) return { ok: true };
  if (!effectiveProbeMethods(node).includes(kind)) {
    const refusal = node.probe_refusals?.[kind];
    return { ok: false, reason: refusal && /^[a-z0-9_]{1,40}$/.test(refusal) ? refusal : "agent_too_old" };
  }
  if (current && !agentReportsMethods(node)) return { ok: false, reason: "agent_too_old" };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Expected status sets (model.ParseMonitorStatusSet)                   */
/* ------------------------------------------------------------------ */

export const EXPECT_STATUS_DEFAULT = "200-399";
export const EXPECT_STATUS_MAX_PARTS = 16;

export interface StatusRange {
  lo: number;
  hi: number;
}

export type StatusSetProblem =
  | { code: "tooMany"; count: number }
  | { code: "notStatus"; entry: string }
  | { code: "backwards"; entry: string };

export type StatusSetResult = { ok: true; ranges: StatusRange[]; canonical: string } | { ok: false; problem: StatusSetProblem };

function statusCode(raw: string): number | undefined {
  const text = raw.trim();
  // Three characters that Go's strconv.Atoi reads as 100 to 599; a sign makes the value too small.
  if (text.length !== 3 || !/^[+-]?\d+$/.test(text)) return undefined;
  const code = Number(text);
  return code >= 100 && code <= 599 ? code : undefined;
}

/**
 * Read an expect_status list as the server does: codes and ranges between
 * 100 and 599, separated by commas, at most 16; empty is the default set.
 * The canonical form is sorted, merged and has no spaces.
 */
export function parseStatusSet(raw: string): StatusSetResult {
  const text = raw.trim() || EXPECT_STATUS_DEFAULT;
  const parts = text.split(",");
  if (parts.length > EXPECT_STATUS_MAX_PARTS) return { ok: false, problem: { code: "tooMany", count: parts.length } };
  const ranges: StatusRange[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    const dash = part.indexOf("-");
    const lo = statusCode(dash < 0 ? part : part.slice(0, dash));
    if (lo === undefined) return { ok: false, problem: { code: "notStatus", entry: part } };
    let hi = lo;
    if (dash >= 0) {
      const end = statusCode(part.slice(dash + 1));
      if (end === undefined) return { ok: false, problem: { code: "notStatus", entry: part } };
      if (end < lo) return { ok: false, problem: { code: "backwards", entry: part } };
      hi = end;
    }
    ranges.push({ lo, hi });
  }
  ranges.sort((a, b) => a.lo - b.lo);
  const merged: StatusRange[] = [{ ...ranges[0]! }];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi);
    else merged.push({ ...r });
  }
  return { ok: true, ranges: merged, canonical: merged.map((r) => (r.lo === r.hi ? `${r.lo}` : `${r.lo}-${r.hi}`)).join(",") };
}

/** The canonical form of a list, or undefined when it does not parse. Empty reads as the default. */
export function canonicalStatusSet(raw: string | undefined): string | undefined {
  const parsed = parseStatusSet(raw ?? "");
  return parsed.ok ? parsed.canonical : undefined;
}

/* ------------------------------------------------------------------ */
/* Request headers (model.ValidateMonitorHeader)                        */
/* ------------------------------------------------------------------ */

export const HEADERS_MAX = 8;
export const HEADER_NAME_MAX = 64;
export const HEADER_VALUE_MAX = 4096;

const TOKEN_EXTRA = "!#$%&'*+-.^_`|~";
function isTokenChar(c: string): boolean {
  return /[A-Za-z0-9]/.test(c) || TOKEN_EXTRA.includes(c);
}

/** Set by the agent's HTTP stack or change how the request travels; Proxy-* is refused too. */
const FORBIDDEN_HEADERS = new Set(["Connection", "Content-Length", "Expect", "Host", "Keep-Alive", "Proxy-Connection", "Te", "Trailer", "Transfer-Encoding", "Upgrade"]);

/**
 * The form names are stored and compared in, as Go's
 * textproto.CanonicalMIMEHeaderKey writes them: "x-api-key" becomes
 * "X-Api-Key". A name with a character a token cannot carry is returned
 * as it is, as Go does.
 */
export function canonicalHeaderName(name: string): string {
  const text = name.trim();
  if ([...text].some((c) => !isTokenChar(c))) return text;
  let upper = true;
  let out = "";
  for (const c of text) {
    out += upper ? c.toUpperCase() : c.toLowerCase();
    upper = c === "-";
  }
  return out;
}

export type HeaderNameProblem = "nameLength" | "nameChars" | "nameForbidden";
export type HeaderValueProblem = "valueLength" | "valueControl";

export function headerNameProblem(name: string): HeaderNameProblem | undefined {
  const text = name.trim();
  if (!text || text.length > HEADER_NAME_MAX) return "nameLength";
  if ([...text].some((c) => !isTokenChar(c))) return "nameChars";
  const canonical = canonicalHeaderName(text);
  if (FORBIDDEN_HEADERS.has(canonical) || canonical.startsWith("Proxy-")) return "nameForbidden";
  return undefined;
}

const encoder = new TextEncoder();

/** The value as the server measures it: 1 to 4096 bytes of UTF-8, no control character but tab. */
export function headerValueProblem(value: string): HeaderValueProblem | undefined {
  const bytes = encoder.encode(value).length;
  if (bytes === 0 || bytes > HEADER_VALUE_MAX) return "valueLength";
  for (const c of value) {
    const code = c.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return "valueControl";
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Origins (model.MonitorOrigin)                                        */
/* ------------------------------------------------------------------ */

/** scheme://host:port in lower case with the port always written, or undefined for anything but an http or https URL with a host. */
export function monitorOrigin(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return undefined;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return undefined;
  const host = url.hostname.toLowerCase();
  if (!host) return undefined;
  const port = url.port || (scheme === "https" ? "443" : "80");
  return `${scheme}://${host}:${port}`;
}

export function isHttpsUrl(rawUrl: string): boolean {
  return monitorOrigin(rawUrl)?.startsWith("https://") ?? false;
}

/* ------------------------------------------------------------------ */
/* Destinations (model.MonitorDestinationRefused)                       */
/* ------------------------------------------------------------------ */

/** Four octets of a dotted IPv4 literal, or undefined. */
export function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    // netip refuses leading zeros, so "010.0.0.1" is not an address there either.
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit groups of an IPv6 literal (a zone is dropped), or undefined. */
export function parseIPv6(text: string): number[] | undefined {
  let s = text.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return undefined;
  // A trailing dotted IPv4 ("::ffff:1.2.3.4") is the last two groups.
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return undefined;
    s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  const rest = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !rest) return undefined;
  const known = head.length + rest.length;
  if (halves.length === 2) {
    if (known > 7) return undefined;
    return [...head, ...new Array<number>(8 - known).fill(0), ...rest];
  }
  return known === 8 ? head : undefined;
}

function v4Refused(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8, "this network" and unspecified
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local and cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, RFC 6598
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments, RFC 6890
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, RFC 2544
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved, RFC 1112, broadcast included
  return false;
}

/** The IPv4 address two 16-bit groups carry. */
function embedded(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function v6Refused(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // An IPv4-mapped address is judged as its IPv4 address.
  if (zero(0, 5) && g[5] === 0xffff) return v4Refused(embedded(g[6]!, g[7]!));
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local, the metadata fd00:ec2::254 among them
  // IPv6 forms that reach IPv4 space: refused outright, or judged by the IPv4 address they embed.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64, RFC 8215
  if (zero(0, 6)) return true; // IPv4-compatible, deprecated
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local, deprecated
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4Refused(embedded(g[6]!, g[7]!)); // NAT64, RFC 6052
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4Refused(embedded(g[6]!, g[7]!)); // IPv4-translated, RFC 2765
  if (g[0] === 0x2002) return v4Refused(embedded(g[1]!, g[2]!)); // 6to4, RFC 3056
  return false;
}

/**
 * A node's public IPv4 as the server takes it for ICMP: a dotted IPv4 that
 * the destination rule would not refuse; undefined otherwise.
 */
export function publicIPv4(raw: string | undefined): string | undefined {
  const v4 = parseIPv4((raw ?? "").trim());
  return v4 && !v4Refused(v4) ? (raw ?? "").trim() : undefined;
}

/**
 * Whether an agent refuses to dial an IP literal for a check whose target
 * is not a node reference. Undefined when the text is not an IP literal (a
 * name, which the agent resolves and judges at dial time).
 */
export function destinationRefused(literal: string): boolean | undefined {
  const v4 = parseIPv4(literal.trim());
  if (v4) return v4Refused(v4);
  const v6 = parseIPv6(literal);
  if (v6) return v6Refused(v6);
  return undefined;
}

export type DestinationProblem = "refused" | "localhost" | "userinfo" | "notIPv4" | "numeric" | "notHost";

/** The host of a host:port target, without brackets. */
function hostOfHostPort(target: string): string {
  const value = target.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  const at = value.lastIndexOf(":");
  return at > 0 ? value.slice(0, at) : value;
}

/**
 * The host of a URL as typed, the way Go's url.Parse reads it. The
 * browser's URL parser rewrites numeric hosts ("127.1" becomes
 * "127.0.0.1"), which would judge a host the server never sees.
 */
function hostOfUrl(target: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(target.trim());
  if (!m) return undefined;
  const authority = m[1]!.slice(m[1]!.lastIndexOf("@") + 1);
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end > 0 ? authority.slice(1, end) : authority;
  }
  const colon = authority.lastIndexOf(":");
  return colon >= 0 ? authority.slice(0, colon) : authority;
}

function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

/** A host label that is all decimal digits, or 0x and hexadecimal digits (the server's monitorNumericLabel). */
export function numericLabel(label: string): boolean {
  if (label.startsWith("0x")) return /^[0-9a-f]*$/.test(label.slice(2));
  return /^[0-9]+$/.test(label);
}

/**
 * The server's checkMonitorHost: a zone or a space is never a host, then
 * localhost, then an address literal by the destination rule, then a host
 * whose last label is a number, an address in a form some resolvers read
 * (2130706433, 127.1, 0x7f.1), since no DNS name ends in one.
 */
export function hostProblem(raw: string): DestinationProblem | undefined {
  const host = raw.trim().replace(/^\[+|\]+$/g, "");
  if (!host) return undefined;
  if (/[%\s]/.test(host)) return "notHost";
  if (isLocalhostName(host)) return "localhost";
  const literal = destinationRefused(host);
  if (literal !== undefined) return literal ? "refused" : undefined;
  const lower = host.toLowerCase().replace(/\.$/, "");
  return numericLabel(lower.slice(lower.lastIndexOf(".") + 1)) ? "numeric" : undefined;
}

/**
 * Why an address target breaks the destination rules (design 29 D11), or
 * undefined. Only an M2a server applies these, and only when a check is
 * created: an edit cannot change the target, so a check saved before the
 * rules stays editable. The shape of the target (host:port, a URL) is
 * monitorTypeModel's targetError.
 */
export function destinationProblem(kind: string, target: string): DestinationProblem | undefined {
  const value = target.trim();
  if (!value) return undefined;
  if (kind === "icmp") {
    const v4 = parseIPv4(value);
    if (!v4) return "notIPv4";
    return v4Refused(v4) ? "refused" : undefined;
  }
  if (kind === "tcp") return hostProblem(hostOfHostPort(value));
  if (kind === "http") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.username || url.password) return "userinfo";
    return hostProblem(hostOfUrl(value) ?? url.hostname);
  }
  return undefined;
}
