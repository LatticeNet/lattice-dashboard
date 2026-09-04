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
import type { DNSDeploymentBody, DNSDeploymentView, DNSListener } from "@/lib/api";

/** Milliseconds in a day, for the certificate countdown. */
const DAY_MS = 86_400_000;

/**
 * How close an expiry has to be before the console calls it out. Thirty days
 * is the usual Let's Encrypt renewal window, so a certificate still inside it
 * is one that automatic renewal has already failed to move.
 */
export const CERT_WARN_DAYS = 30;

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
 * The certificate countdown. A zero time from Go arrives as year 1, which
 * formats into a real-looking date, so it is treated as unknown rather than as
 * a certificate that expired two thousand years ago.
 */
export function certExpiry(certNotAfter: string | undefined, now: Date): CertExpiry {
  const raw = (certNotAfter ?? "").trim();
  if (!raw || raw.startsWith("0001")) return { tone: "unknown", days: 0 };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { tone: "unknown", days: 0 };
  const days = Math.floor((at.getTime() - now.getTime()) / DAY_MS);
  if (days < 0) return { tone: "expired", days };
  if (days <= CERT_WARN_DAYS) return { tone: "warn", days };
  return { tone: "ok", days };
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
export const DNS_COLUMN_SIZING: Record<"node" | "hostname" | "reality", string> = {
  node: "max-w-[150px]",
  hostname: "max-w-[150px]",
  reality: "w-[190px] min-w-[190px] align-top",
};

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
