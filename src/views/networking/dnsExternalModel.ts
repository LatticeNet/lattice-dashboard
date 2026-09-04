/**
 * The reading half of the observed DNS engine.
 *
 * Lattice deploys `coredns`: it renders a Corefile, files an approval, and a
 * node applies it. It only watches `external`: the operator runs the daemon,
 * Lattice records where it listens and when its certificate expires, and every
 * write path is closed. The console has to make that difference visible,
 * because an observed row that offers a Plan button is a lie about who owns
 * the service.
 *
 * Everything here is pure so the difference can be asserted in a test rather
 * than eyeballed in a table cell.
 */
import type { DNSDeploymentBody, DNSDeploymentView, DNSListener, MonitorView } from "@/lib/api";
import { TLS_DEFAULT_THRESHOLD_DAYS } from "@/views/fleet/monitorTypeModel";

/** Milliseconds in a day, for the certificate countdown. */
const DAY_MS = 86_400_000;

/** Whether a record describes a daemon Lattice watches rather than one it deploys. */
export function isObservedEngine(engine: string | undefined): boolean {
  return (engine ?? "").trim().toLowerCase() === "external";
}

/**
 * An observed record is never plannable. The server refuses it too, but a
 * button that files a request the server will reject is still a button that
 * told the operator this page owns their resolver.
 */
export function canPlanDeployment(dep: Pick<DNSDeploymentView, "engine">): boolean {
  return !isObservedEngine(dep.engine);
}

/** Same reasoning for publishing: an observed record carries no credential and writes no record. */
export function canPublishDeployment(dep: Pick<DNSDeploymentView, "engine" | "hostname">): boolean {
  return !isObservedEngine(dep.engine) && !!dep.hostname;
}

/** `tcp/53` and friends, sorted by port then protocol so the same set always reads the same. */
export function formatListeners(listeners: DNSListener[] | undefined): string[] {
  return [...(listeners ?? [])]
    .sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol))
    .map((l) => `${l.protocol}/${l.port}`);
}

/**
 * The processes reality reported behind the recorded sockets, deduplicated.
 * One daemon usually owns every listener, and naming it is what turns a row of
 * port numbers into "this is dnsproxy".
 */
export function listenerProcesses(listeners: DNSListener[] | undefined): string[] {
  const seen = new Set<string>();
  for (const l of listeners ?? []) {
    const process = (l.process ?? "").trim();
    if (process) seen.add(process);
  }
  return [...seen].sort();
}

/** What the Listen column prints: the observed socket set, or the deployed port and its protocols. */
export function listenSummary(dep: DNSDeploymentView): string {
  if (isObservedEngine(dep.engine)) {
    const listeners = formatListeners(dep.listeners);
    return listeners.length ? listeners.join(", ") : "";
  }
  const protocols = [dep.enable_udp ? "udp" : null, dep.enable_tcp ? "tcp" : null].filter(Boolean);
  return protocols.length ? `${dep.listen_port} ${protocols.join("/")}` : String(dep.listen_port);
}

/**
 * The expiry as a plain UTC date, `2026-11-17`. A certificate's not-after is a
 * calendar fact the operator typed, so rendering it through a local-time
 * formatter can print the day before and make the console disagree with the
 * form that set it.
 */
export function certDate(certNotAfter: string | undefined): string {
  const raw = (certNotAfter ?? "").trim();
  if (!raw || raw.startsWith("0001")) return "";
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(0, 10);
}

export type CertTone = "unknown" | "ok" | "warn" | "expired";

export interface CertExpiry {
  tone: CertTone;
  /** Whole days until expiry, negative once it has lapsed. Zero when unknown. */
  days: number;
}

/**
 * The certificate countdown, judged against a threshold the caller supplies.
 *
 * The threshold used to be a constant thirty days living here, which made this
 * page disagree with the watch that owns the question: a tls monitor fails at
 * its own threshold_days, so a sixty-day watch went red on Monitoring while
 * this row still printed the same countdown in neutral grey, and a seven-day
 * watch stayed green while this row went amber. Two surfaces contradicting
 * each other about whether a certificate is about to break is worse than
 * either verdict alone, so there is no default: whoever renders the countdown
 * has to say what it is being measured against.
 *
 * A zero time from Go arrives as year 1, which formats into a real-looking
 * date, so it is treated as unknown rather than as a certificate that expired
 * two thousand years ago.
 */
export function certExpiry(certNotAfter: string | undefined, now: Date, thresholdDays: number): CertExpiry {
  const raw = (certNotAfter ?? "").trim();
  if (!raw || raw.startsWith("0001")) return { tone: "unknown", days: 0 };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { tone: "unknown", days: 0 };
  const days = Math.floor((at.getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return { tone: "expired", days };
  if (days <= thresholdDays) return { tone: "warn", days };
  return { tone: "ok", days };
}

// ── Who owns the expiry question ──────────────────────────────────────────
//
// The recorded cert_not_after is a date the operator typed. The thing that
// actually fires before it arrives is a tls monitor, which dials the endpoint,
// reads the leaf certificate and fails once fewer than threshold_days remain.
// So this page does not get to hold an opinion of its own: it either finds the
// watch and answers with the watch's threshold, or it says plainly that
// nothing is watching, which is the state an amber number was hiding. An
// observed resolver with no watch used to look exactly like a watched one.

/** The fields of a monitor this page needs. */
export type CertWatchMonitor = Pick<MonitorView, "id" | "name" | "type" | "target" | "threshold_days" | "enabled">;

export interface CertWatchLookup {
  /** `unknown` when the monitor list could not be read, which is not the same claim as "nothing watches this". */
  state: "watched" | "unwatched" | "unknown";
  monitor?: CertWatchMonitor;
  /** The days-left threshold the verdict is measured against; 0 when nothing watches. */
  thresholdDays: number;
}

/**
 * The host a tls target names. The probe takes host:port and nothing else, so
 * the port is dropped and the host compared case-insensitively, the way DNS
 * itself compares names.
 */
export function tlsTargetHost(target: string | undefined): string {
  const value = (target ?? "").trim().toLowerCase();
  const at = value.lastIndexOf(":");
  return (at > 0 ? value.slice(0, at) : value).replace(/^\[|\]$/g, "");
}

/**
 * The certificate watch pointed at this hostname.
 *
 * `monitors` undefined means the list was not read: a token without
 * monitor:read cannot see whether a watch exists, and answering "nothing
 * watches this" on its behalf would be a claim the page cannot support.
 */
export function lookupCertWatch(
  hostname: string | undefined,
  monitors: CertWatchMonitor[] | undefined,
): CertWatchLookup {
  const name = (hostname ?? "").trim().toLowerCase();
  if (!monitors || !name) return { state: "unknown", thresholdDays: 0 };
  const monitor = monitors.find(
    (candidate) =>
      candidate.type === "tls" && candidate.enabled !== false && tlsTargetHost(candidate.target) === name,
  );
  if (!monitor) return { state: "unwatched", thresholdDays: 0 };
  const threshold = monitor.threshold_days;
  return {
    state: "watched",
    monitor,
    // The server applies its own default when the field is absent, so mirror
    // that rather than treating a missing threshold as no threshold.
    thresholdDays: Number.isFinite(threshold) && (threshold ?? 0) > 0 ? (threshold as number) : TLS_DEFAULT_THRESHOLD_DAYS,
  };
}

/**
 * The countdown as this page is entitled to state it: at the watch's own
 * threshold when there is a watch, and with no threshold at all when there is
 * not, so an unwatched row reads neutral and says so instead of inventing an
 * amber that nothing behind it will act on. An expiry already in the past is
 * still called out, because that is a fact and not a judgement.
 */
export function certVerdict(
  certNotAfter: string | undefined,
  now: Date,
  watch: CertWatchLookup,
): CertExpiry {
  return certExpiry(certNotAfter, now, watch.thresholdDays);
}

/**
 * Badge tone for the drift verdict. `unknown` is a warning and not a neutral
 * state: it means the comparison did not run, which is worth as much attention
 * as a listener that moved.
 */
export function driftTone(status: string | undefined): "success" | "destructive" | "warning" {
  switch ((status ?? "").trim().toLowerCase()) {
    case "ok":
      return "success";
    case "drift":
      return "destructive";
    default:
      return "warning";
  }
}

// ── Deployments table layout ──────────────────────────────────────────────
//
// The table is auto-layout with eleven columns, and auto layout hands width to
// whatever cannot shrink. A hostname is one unbreakable mono string, so its
// column holds whatever it needs; the drift findings are prose that wraps
// anywhere, so their minimum width is the longest single word and the browser
// takes the rest away. The Reality column is the point of an observed record,
// and it was the column being crushed.
//
// So the verdict and the countdown reserve width rather than capping it, the
// two text columns that were hoarding it are capped and truncated, and the
// findings themselves leave the row entirely for a full-width detail panel:
// no column width makes a sentence read well beside ten other columns. These
// live here, and not inline in the template, because "this column reserves
// width" is the kind of claim that gets silently reverted to a max-width
// during a tidy-up.

/** Tailwind sizing applied to a deployments-table column, header and body cell. */
export const DNS_COLUMN_SIZING: Record<"node" | "hostname" | "hostnameWide" | "reality", string> = {
  node: "max-w-[150px]",
  hostname: "max-w-[150px]",
  hostnameWide: "min-w-[220px] whitespace-nowrap",
  reality: "w-[190px] min-w-[190px] align-top",
};

// ── What an observed-only table does not need ─────────────────────────────
//
// Capping the hostname was the right trade while eleven columns competed. On a
// table of nothing but observed records it is not: two of those columns
// describe an intent Lattice holds, an observed record holds neither, and both
// print a single "·" while taking about ninety pixels each. The hostname next
// to them was truncated to `resolver.xuezhan…`, and it is the identifier the
// whole observed story hangs on: it is what a certificate watch is pointed at
// and what the operator came to read. A title tooltip is not a recovery, since
// neither a keyboard nor a touch reader can open one.
//
// So the two intent columns leave the table when nothing on it has an intent,
// and the hostname turns its ceiling into a floor with the width they freed.

/** Columns that describe an intent Lattice holds rather than a fact about the daemon. */
export const DNS_INTENT_COLUMN_KEYS = ["credential", "published"];

/**
 * Whether every record loaded is one Lattice only watches.
 *
 * This reads the loaded rows and not the rows a search happens to be showing:
 * a column set that appears and disappears while the operator types costs more
 * than the width it wins back.
 */
export function isObservedOnlyTable(deployments: Pick<DNSDeploymentView, "engine">[]): boolean {
  return deployments.length > 0 && deployments.every((dep) => isObservedEngine(dep.engine));
}

/** The columns to render: the intent pair is dropped from an observed-only table. */
export function dnsVisibleColumns<C extends { key: string }>(columns: C[], observedOnly: boolean): C[] {
  if (!observedOnly) return columns;
  return columns.filter((column) => !DNS_INTENT_COLUMN_KEYS.includes(column.key));
}

/** The hostname column's sizing: a ceiling beside the intent columns, a floor without them. */
export function dnsHostnameSizing(observedOnly: boolean): string {
  return observedOnly ? DNS_COLUMN_SIZING.hostnameWide : DNS_COLUMN_SIZING.hostname;
}

/**
 * Whether a class string reserves horizontal space instead of only capping it.
 * `max-w-*` alone is a ceiling: a column that carries only one is free to be
 * squeezed to its longest word, which is what happened to Reality.
 */
export function reservesWidth(classes: string | undefined): boolean {
  return /(^|\s)(min-)?w-\[/.test(classes ?? "");
}

/** The reserved width in CSS pixels, or 0 when the class string reserves none. */
export function reservedWidthPx(classes: string | undefined): number {
  const widths = [...(classes ?? "").matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
  return widths.length ? Math.min(...widths) : 0;
}

// ── The observed body ─────────────────────────────────────────────────────

/** What the external branch of the deployment form holds. */
export interface ExternalFormInput {
  /** Set when an existing record is being edited. */
  id?: string;
  name: string;
  node_id: string;
  hostname: string;
  /** Ports arrive as strings from the number inputs until they are edited. */
  listeners: { protocol: string; port: string | number }[];
  /** `YYYY-MM-DD` from the date input, or "" when the expiry is not recorded. */
  cert_not_after: string;
}

/** The two fields the observed form does not show and must not overwrite. */
export type ExternalCarried = Pick<DNSDeploymentView, "exposure" | "zones">;

/**
 * The body for an observed record.
 *
 * `exposure` and `zones` are not in this form, and the server does not merge:
 * an upsert replaces the record, so an absent `zones` is nilled and an absent
 * `exposure` is defaulted to public. Sending nothing is therefore not the same
 * as leaving them alone; it destroys them. An operator who opens a LAN-only
 * resolver to add a listener would have silently published it and dropped
 * whatever zones it documented, with no diff and no cell in the table that
 * would have shown the change.
 *
 * So both are carried from the record being edited and handed straight back.
 * On a create there is nothing to carry, and the server's own default applies.
 */
export function buildExternalDnsBody(
  input: ExternalFormInput,
  carried?: ExternalCarried,
): DNSDeploymentBody {
  const listeners: DNSListener[] = input.listeners.map((listener) => ({
    protocol: listener.protocol,
    port: Number(listener.port),
  }));
  const body: DNSDeploymentBody = {
    ...(input.id ? { id: input.id } : {}),
    name: input.name.trim(),
    node_id: input.node_id,
    engine: "external",
    exposure: carriedExposure(carried),
    zones: carried?.zones ?? [],
    hostname: input.hostname.trim(),
    listeners,
  };
  if (input.cert_not_after) body.cert_not_after = `${input.cert_not_after}T00:00:00Z`;
  return body;
}

/**
 * The exposure to send back. An unrecognised value is not passed through: the
 * server refuses anything but mesh or public, and failing the whole save over
 * a field the form never showed would be a worse outcome than the default.
 */
function carriedExposure(carried: ExternalCarried | undefined): string {
  const value = (carried?.exposure ?? "").trim().toLowerCase();
  return value === "mesh" || value === "public" ? value : "public";
}

// ── The observed hostname ─────────────────────────────────────────────────

/** Why an observed hostname cannot be sent, or undefined when it can. */
export type ExternalHostnameProblem = "empty" | "not_fqdn";

/**
 * The hostname an observed record answers at.
 *
 * The server refuses anything without a dot, and this is the only handle a
 * certificate watch can be pointed at, so the rule is worth stating twice.
 * It returns which rule was broken rather than a boolean, because a red border
 * over a hint that only restates what the field is for tells the operator
 * nothing about what to type instead.
 */
export function externalHostnameProblem(hostname: string): ExternalHostnameProblem | undefined {
  const value = hostname.trim();
  if (!value) return "empty";
  if (!value.includes(".")) return "not_fqdn";
  return undefined;
}

/** Whether the hostname as typed can be sent. */
export function isExternalHostnameValid(hostname: string): boolean {
  return externalHostnameProblem(hostname) === undefined;
}
