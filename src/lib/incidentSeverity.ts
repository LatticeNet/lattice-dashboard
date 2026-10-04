/**
 * The incident severity table, mirroring lattice-server incidents.go
 * (incidentKinds, notifyEventSeverity) and notify_channel_fallback.go
 * (notifyCriticalEventTypes). Every console sentence that depends on
 * severity is built from here: the rule editor's escalation and quiet-hours
 * hints, the rule row's summary, a channel's fallback hint, and an incident
 * row's severity and phone line. One table, so the console says one thing
 * about when the phone rings.
 *
 *   critical  node.offline, service.down (and ssh.compromise_suspected)
 *             re-sent once when nobody acknowledges them, never held by
 *             quiet hours, and what a channel's fallback carries
 *   warning   monitor.down, agent.stalled (and every other event)
 *             never re-sent; quiet hours hold them
 *
 * A recovery has the severity of the incident it closes.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */

export type Severity = "critical" | "warning";

/** lattice-server incidentKinds, in the order the console lists kinds. */
export const INCIDENT_KIND_TABLE = {
  "node.offline": { severity: "critical", recovery: "node.online" },
  "service.down": { severity: "critical", recovery: "service.recovered" },
  "monitor.down": { severity: "warning", recovery: "monitor.recovered" },
  "agent.stalled": { severity: "warning", recovery: "agent.recovered" },
} as const satisfies Record<string, { severity: Severity; recovery: string }>;

export type IncidentKind = keyof typeof INCIDENT_KIND_TABLE;

export const INCIDENT_KINDS = Object.keys(INCIDENT_KIND_TABLE) as IncidentKind[];

/** Critical events that open no incident (notifyEventSeverity). */
export const CRITICAL_NON_INCIDENT_EVENTS = ["ssh.compromise_suspected"] as const;

const RECOVERY_OF: Record<string, IncidentKind> = Object.fromEntries(INCIDENT_KINDS.map((kind) => [INCIDENT_KIND_TABLE[kind].recovery, kind]));

export function isIncidentKind(value: string): value is IncidentKind {
  return Object.prototype.hasOwnProperty.call(INCIDENT_KIND_TABLE, value);
}

/** The severity quiet hours judge an event by (notifyEventSeverity). */
export function eventSeverity(eventType: string): Severity {
  if (isIncidentKind(eventType)) return INCIDENT_KIND_TABLE[eventType].severity;
  const open = RECOVERY_OF[eventType];
  if (open) return INCIDENT_KIND_TABLE[open].severity;
  return (CRITICAL_NON_INCIDENT_EVENTS as readonly string[]).includes(eventType) ? "critical" : "warning";
}

/** The incident kinds an unacknowledged incident is re-sent for: the critical ones. */
export const ESCALATING_KINDS: IncidentKind[] = INCIDENT_KINDS.filter((kind) => INCIDENT_KIND_TABLE[kind].severity === "critical");

/** The incident kinds quiet hours hold: the warnings. */
export const HELD_KINDS: IncidentKind[] = INCIDENT_KINDS.filter((kind) => INCIDENT_KIND_TABLE[kind].severity === "warning");

/**
 * What a channel's critical fallback carries: the critical opening events,
 * in the server's order (notifyCriticalEventList). Recoveries are not
 * handed over.
 */
export const CRITICAL_ALERT_EVENTS: string[] = [...ESCALATING_KINDS, ...CRITICAL_NON_INCIDENT_EVENTS];

/** An incident's severity: its record's own, else its kind's. */
export function incidentSeverity(incident: { kind: string; severity?: string }): Severity {
  if (incident.severity === "critical" || incident.severity === "warning") return incident.severity;
  return eventSeverity(incident.kind);
}

/** notifyRuleMatches: an empty list or "*" routes every event. */
export function ruleRoutes(eventTypes: readonly string[], eventType: string): boolean {
  if (eventTypes.length === 0) return true;
  return eventTypes.some((candidate) => candidate === "*" || candidate === eventType);
}

/** The incident kinds a rule routes, split by what happens to them. */
export interface RuleIncidentReach {
  /** Re-sent when nobody acknowledges them; go out at once in quiet hours. */
  critical: IncidentKind[];
  /** Never re-sent; held by quiet hours. */
  warning: IncidentKind[];
}

export function ruleIncidentReach(eventTypes: readonly string[]): RuleIncidentReach {
  const routed = INCIDENT_KINDS.filter((kind) => ruleRoutes(eventTypes, kind));
  return {
    critical: routed.filter((kind) => INCIDENT_KIND_TABLE[kind].severity === "critical"),
    warning: routed.filter((kind) => INCIDENT_KIND_TABLE[kind].severity === "warning"),
  };
}

/** The i18n key segment for an event type ("node.offline" to "node_offline"). */
export function eventKey(eventType: string): string {
  return eventType.replace(/\./g, "_");
}
