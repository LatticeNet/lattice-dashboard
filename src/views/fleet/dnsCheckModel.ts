/**
 * The DNS check method of design 32 S5a, as lattice-sdk model/monitor_dns.go
 * has it: a resolver endpoint as the target (https DoH with its path, tls
 * DoT, udp and tcp plain DNS), a question (name and type) and the answer
 * that passes (expected values, or a name that must not resolve). The
 * server and the agents apply the Go rules; the console mirrors them so the
 * editor refuses what the server would, and stores what the server would
 * store. The server stays the authority.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { MonitorLatest } from "@/lib/api/types";

import { destinationProblem, hostProblem, parseIPv4, parseIPv6, type DestinationProblem } from "@/views/fleet/checkRulesModel";

/** The question types a dns check asks (model.DNSTypes), in the order the editor offers them. */
export const DNS_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
export type DnsType = (typeof DNS_TYPES)[number];

export const DNS_NAME_MAX = 253;
export const DNS_EXPECT_MAX = 16;
export const DNS_VALUE_MAX = 255;
export const DNS_RCODE_NXDOMAIN = "NXDOMAIN";

/** The resolver transports, the schemes of a dns check's target, with their default ports. */
export const DNS_TRANSPORTS = { https: 443, tls: 853, udp: 53, tcp: 53 } as const;
export type DnsTransport = keyof typeof DNS_TRANSPORTS;

export interface DnsResolver {
  transport: DnsTransport;
  /** A lower-case name or an IP literal, without brackets. */
  host: string;
  port: number;
  /** A DoH URL's path; empty for the other transports. */
  path: string;
}

/** Why a resolver endpoint does not parse. */
export type ResolverProblem = "shape" | "scheme" | "extra" | "port" | "host" | "path" | "noPath";

export type ResolverResult = { ok: true; resolver: DnsResolver; canonical: string } | { ok: false; problem: ResolverProblem };

const encoder = new TextEncoder();

/** The RFC 5952 text of eight 16-bit groups, as Go's netip writes it; an IPv4-mapped address keeps its dotted tail. */
function formatIPv6(g: number[]): string {
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `::ffff:${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  }
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (list: number[]) => list.map((x) => x.toString(16)).join(":");
  if (best < 0) return hex(g);
  return `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
}

/** An IP literal in the form netip prints it, or undefined when the text is not one. */
function canonicalAddress(text: string): { kind: 4 | 6; text: string } | undefined {
  const v4 = parseIPv4(text);
  if (v4) return { kind: 4, text: v4.join(".") };
  if (text.includes("%")) return undefined;
  const v6 = parseIPv6(text);
  return v6 ? { kind: 6, text: formatIPv6(v6) } : undefined;
}

export type NameProblem = "empty" | "long" | "label" | "chars";
export type NameResult = { ok: true; name: string } | { ok: false; problem: NameProblem };

/**
 * A question name in canonical form (model.NormalizeDNSName): lower case,
 * without the trailing dot, at most 253 bytes of letters, digits, hyphens,
 * underscores and dots, in labels of 1 to 63 bytes.
 */
export function normalizeDnsName(raw: string): NameResult {
  const name = raw.trim().replace(/\.$/, "").toLowerCase();
  if (!name) return { ok: false, problem: "empty" };
  if (encoder.encode(name).length > DNS_NAME_MAX) return { ok: false, problem: "long" };
  for (const label of name.split(".")) {
    if (!label || label.length > 63) return { ok: false, problem: "label" };
    if (!/^[a-z0-9_-]+$/.test(label)) return { ok: false, problem: "chars" };
  }
  return { ok: true, name };
}

/** The canonical target (model.DNSResolver.String): the default port left out, so two spellings are one target. */
export function resolverString(r: DnsResolver): string {
  const host = r.host.includes(":") ? `[${r.host}]` : r.host;
  const port = r.port === DNS_TRANSPORTS[r.transport] ? "" : `:${r.port}`;
  return `${r.transport}://${host}${port}${r.path}`;
}

/**
 * Read a dns check target as model.ParseDNSResolver does. A target carries
 * no user info, query or fragment; only a DoH target has a path, and it
 * must. The destination rule is resolverDestination's.
 */
export function parseResolver(raw: string): ResolverResult {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(raw.trim());
  if (!m) return { ok: false, problem: "shape" };
  const scheme = m[1]!.toLowerCase();
  if (!(scheme in DNS_TRANSPORTS)) return { ok: false, problem: "scheme" };
  const transport = scheme as DnsTransport;
  const authority = m[2]!;
  const path = m[3]!;
  if (m[4] !== undefined || m[5] !== undefined || authority.includes("@")) return { ok: false, problem: "extra" };
  let hostText = authority;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return { ok: false, problem: "host" };
    hostText = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest && !rest.startsWith(":")) return { ok: false, problem: "host" };
    if (rest) portText = rest.slice(1);
    const addr = canonicalAddress(hostText);
    if (!addr || addr.kind !== 6) return { ok: false, problem: "host" };
    hostText = addr.text;
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      hostText = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
    }
    if (hostText.includes(":")) return { ok: false, problem: "host" };
    const addr = canonicalAddress(hostText);
    if (addr) hostText = addr.text;
    else {
      const name = normalizeDnsName(hostText);
      if (!name.ok) return { ok: false, problem: "host" };
      hostText = name.name;
    }
  }
  if (!hostText) return { ok: false, problem: "shape" };
  let port: number = DNS_TRANSPORTS[transport];
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return { ok: false, problem: "port" };
    port = Number(portText);
  }
  let outPath = "";
  if (transport === "https") {
    if (!path || path === "/") return { ok: false, problem: "noPath" };
    outPath = path;
  } else if (path && path !== "/") {
    return { ok: false, problem: "path" };
  }
  const resolver: DnsResolver = { transport, host: hostText, port, path: outPath };
  return { ok: true, resolver, canonical: resolverString(resolver) };
}

/** The canonical form of a target, or the text as typed when it does not parse. */
export function canonicalResolver(raw: string): string {
  const parsed = parseResolver(raw);
  return parsed.ok ? parsed.canonical : raw.trim();
}

/** Why a resolver breaks the destination rules the server applies on create (checkMonitorHost), or undefined. */
export function resolverDestination(raw: string): DestinationProblem | undefined {
  const parsed = parseResolver(raw);
  return parsed.ok ? hostProblem(parsed.resolver.host) : undefined;
}

/** Why any check's address target breaks the destination rules: a dns check's by its resolver's host. */
export function checkDestination(kind: string, target: string): DestinationProblem | undefined {
  return kind === "dns" ? resolverDestination(target) : destinationProblem(kind, target);
}

/** Whether a resolver's runs read a certificate (DoH and DoT), so the check feeds Expiring. */
export function resolverEncrypted(raw: string): boolean {
  const parsed = parseResolver(raw);
  return parsed.ok && (parsed.resolver.transport === "https" || parsed.resolver.transport === "tls");
}

export type ValueProblem = "notIPv4" | "notIPv6" | "notName" | "txtLength";
export type ValueResult = { ok: true; value: string } | { ok: false; problem: ValueProblem };

/**
 * An expected value in the form an agent compares answers in
 * (model.CanonicalDNSValue): an A value as an IPv4 address, an AAAA value as
 * an IPv6 one, a CNAME, MX or NS value as a name (an MX value is the
 * exchange, without its preference), a TXT value exactly as typed.
 */
export function canonicalDnsValue(type: string, raw: string): ValueResult {
  if (type === "A" || type === "AAAA") {
    const addr = canonicalAddress(raw.trim());
    if (type === "A") return addr?.kind === 4 ? { ok: true, value: addr.text } : { ok: false, problem: "notIPv4" };
    return addr?.kind === 6 ? { ok: true, value: addr.text } : { ok: false, problem: "notIPv6" };
  }
  if (type === "TXT") {
    const bytes = encoder.encode(raw).length;
    return bytes === 0 || bytes > DNS_VALUE_MAX ? { ok: false, problem: "txtLength" } : { ok: true, value: raw };
  }
  const name = normalizeDnsName(raw);
  return name.ok ? { ok: true, value: name.name } : { ok: false, problem: "notName" };
}

export interface ExpectProblem {
  /** The line, from 1, of the value at fault. */
  line: number;
  problem: ValueProblem;
}

export interface ExpectResult {
  /** The canonical values, once each, in the order typed. */
  values: string[];
  problems: ExpectProblem[];
  tooMany: boolean;
  /** NXDOMAIN takes no expected values. */
  withNxdomain: boolean;
}

/**
 * Read the expected values as the editor holds them, one per line (a TXT
 * value may hold a comma). Blank lines are skipped.
 */
export function parseExpect(type: string, text: string, rcode: string): ExpectResult {
  const out: ExpectResult = { values: [], problems: [], tooMany: false, withNxdomain: false };
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    // A TXT value is compared exactly; the line break is the separator, not part of it.
    const parsed = canonicalDnsValue(type, type === "TXT" ? line.replace(/\r$/, "") : line);
    if (!parsed.ok) out.problems.push({ line: i + 1, problem: parsed.problem });
    else if (!out.values.includes(parsed.value)) out.values.push(parsed.value);
  }
  out.tooMany = out.values.length > DNS_EXPECT_MAX;
  out.withNxdomain = rcode === DNS_RCODE_NXDOMAIN && (out.values.length > 0 || out.problems.length > 0);
  return out;
}

/** Whether the expected values block a save. */
export function expectBlocks(result: ExpectResult): boolean {
  return result.problems.length > 0 || result.tooMany || result.withNxdomain;
}

/** The editor's text for stored values. */
export function expectText(values: readonly string[] | undefined): string {
  return (values ?? []).join("\n");
}

/** The failure codes a dns run's error starts with (model.DNSFailure*). */
export const DNS_FAILURES = ["dns_rcode", "dns_mismatch", "dns_no_answer", "dns_transport"] as const;
export type DnsFailure = (typeof DNS_FAILURES)[number];

/** A dns run's error read as its code and the agent's sentence; undefined for any other text. */
export function dnsFailure(error: string | undefined): { code: DnsFailure; detail: string } | undefined {
  if (!error) return undefined;
  const colon = error.indexOf(":");
  if (colon < 0) return undefined;
  const code = error.slice(0, colon) as DnsFailure;
  return DNS_FAILURES.includes(code) ? { code, detail: error.slice(colon + 1).trim() } : undefined;
}

/** How many answers the sheet lists before it says how many more came back. */
export const ANSWERS_SHOWN = 4;

/** What a failed dns run got back, for the check sheet: the code and the first answers. Undefined when it got no response. */
export function failedAnswer(latest: Pick<MonitorLatest, "success" | "reason" | "dns_rcode" | "dns_answers"> | undefined): { rcode: string; answers: string[]; more: number } | undefined {
  if (!latest || latest.success || latest.reason || !latest.dns_rcode) return undefined;
  const answers = latest.dns_answers ?? [];
  return { rcode: latest.dns_rcode, answers: answers.slice(0, ANSWERS_SHOWN), more: Math.max(0, answers.length - ANSWERS_SHOWN) };
}
