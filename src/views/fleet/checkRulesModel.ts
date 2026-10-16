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
import type { LatencyProbePlan, Node } from "@/lib/api/types";

/* ------------------------------------------------------------------ */
/* Probe methods (Node.probe_methods, D11 capability facts)             */
/* ------------------------------------------------------------------ */

/** What an agent that reports nothing runs: every agent before M2a. */
export const LEGACY_PROBE_METHODS: readonly string[] = ["http", "tcp"];
const KNOWN_PROBE_METHODS = new Set(["tcp", "http", "icmp", "beacon"]);

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

/**
 * Whether the server speaks M2a, read from its answers rather than a
 * version: an M2a server lists `probe_methods` on every node (the effective
 * list, never empty), and its latency plan names each pair's method. A
 * session that reads neither is treated as talking to an older server.
 */
export function serverSpeaksM2a(nodes: readonly Pick<Node, "probe_methods">[] | undefined, plan?: Pick<LatencyProbePlan, "pairs" | "config"> | null): boolean {
  if ((nodes ?? []).some((n) => Array.isArray(n.probe_methods))) return true;
  if (!plan) return false;
  return typeof plan.config?.method === "string" || (plan.pairs ?? []).some((p) => typeof p.method === "string" && p.method !== "");
}

/** Kinds a node runs as a source: the agent kinds. tls runs on the control plane. */
export function runsOnAgent(kind: string): boolean {
  return kind === "tcp" || kind === "http" || kind === "icmp";
}

export type SourceSupport = { ok: true } | { ok: false; reason: string };

/**
 * Whether a node can be a source for a kind. On a server before M2a every
 * agent runs tcp and http and nothing else is offered, so everything is
 * supported. Otherwise a kind the agent does not report is refused: with
 * the host's refusal code when the agent named one (icmp_not_permitted),
 * else agent_too_old, the reasons the path would read.
 */
export function sourceSupport(node: Pick<Node, "probe_methods" | "probe_refusals"> | undefined, kind: string, m2a: boolean): SourceSupport {
  if (!m2a || !runsOnAgent(kind)) return { ok: true };
  if (effectiveProbeMethods(node).includes(kind)) return { ok: true };
  const refusal = node?.probe_refusals?.[kind];
  return { ok: false, reason: refusal && /^[a-z0-9_]{1,40}$/.test(refusal) ? refusal : "agent_too_old" };
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
  const [a, b, c, d] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8, "this network" and unspecified
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local and cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224 && a <= 239) return true; // multicast
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
  return false;
}

function v6Refused(g: number[]): boolean {
  const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUntil(8)) return true; // ::
  if (zeroUntil(7) && g[7] === 1) return true; // ::1
  if (zeroUntil(5) && g[5] === 0xffff) {
    // An IPv4-mapped address is judged as its IPv4 address.
    return v4Refused([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local, the metadata fd00:ec2::254 among them
  return false;
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

export type DestinationProblem = "refused" | "localhost" | "userinfo" | "notIPv4";

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

function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

/**
 * Why an address target breaks the destination rules (design 29 D11), or
 * undefined. Only an M2a server applies these; the shape of the target
 * (host:port, a URL) is monitorTypeModel's targetError.
 */
export function destinationProblem(kind: string, target: string): DestinationProblem | undefined {
  const value = target.trim();
  if (!value) return undefined;
  if (kind === "icmp") {
    const v4 = parseIPv4(value);
    if (!v4) return "notIPv4";
    return v4Refused(v4) ? "refused" : undefined;
  }
  if (kind === "tcp") {
    const host = hostOfHostPort(value);
    if (isLocalhostName(host)) return "localhost";
    return destinationRefused(host) ? "refused" : undefined;
  }
  if (kind === "http") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.username || url.password) return "userinfo";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isLocalhostName(host)) return "localhost";
    return destinationRefused(host) ? "refused" : undefined;
  }
  return undefined;
}
