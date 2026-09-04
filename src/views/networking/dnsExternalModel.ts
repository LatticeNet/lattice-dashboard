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
import type { DNSDeploymentView, DNSListener } from "@/lib/api";

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
