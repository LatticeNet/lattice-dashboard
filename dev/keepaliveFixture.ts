/**
 * Keepalive incidents, maintenance windows and agent loop health for the
 * fleet harness (dev/fleet*.html), shaped like lattice-server's
 * GET /api/incidents, GET /api/maintenance-windows and the node view's
 * loop_health.
 *
 * `?incidents=` picks the shape:
 *   none (default)  no incident and no window, as a quiet fleet
 *   some            every row state the Keepalive layer tells apart at once:
 *                   two critical sing-box incidents (one paged 14m ago, one
 *                   already re-sent as critical), DMIT-4 offline for days, an
 *                   acknowledged stalled agent, a snoozed failing monitor, a
 *                   sing-box incident on a node in a maintenance window, a
 *                   pending offline, and two resolved ones; one active window
 *                   over that node and one upcoming over a group
 *
 * Loop health rides on every reporting node: a healthy loop by default, and
 * with `?incidents=some` the stalled loop on [Metix]-qqpw-cd2-VDS (its agent
 * clock three minutes fast, so the panel's ages prove they do not compare
 * clocks), a failing usage step and dropped monitor results on malibu, and
 * DMIT-4's last loop report from six days ago. Names follow the fleet
 * fixture; times, reasons and errors are invented.
 */
import type { AgentLoopHealth, AgentLoopStep, Incident, MaintenanceWindow, Node } from "@/lib/api/index";

import { eventSeverity } from "@/lib/incidentSeverity";
import { DAY, GROUPS, HOUR, MINUTE, NODES, PARAMS, iso } from "./fleetFixture";

export const INCIDENT_SHAPE = (PARAMS.get("incidents") ?? "none") as "none" | "some";
const SOME = INCIDENT_SHAPE === "some" && NODES.length > 0;

const SECOND = 1000;

function nodeNamed(name: string): Node {
  const node = NODES.find((n) => n.name === name);
  if (!node) throw new Error(`keepalive fixture: no node ${name}`);
  return node;
}

/* ------------------------------ node states ------------------------------ */

const SINGBOX_DOWN = (minutes: number) => `Reporting, but sing-box is inactive (unit inactive/dead) for ${minutes}m.`;

/** How the nodes with an incident read, so the Nodes column and the incident agree. */
export function keepaliveNodeState(node: Node): Partial<Node> | undefined {
  if (!SOME) return undefined;
  switch (node.name) {
    case "[Metix]-DMIT-1":
      return { status: "degraded", status_since: iso(-16 * MINUTE), status_reason: SINGBOX_DOWN(16) };
    case "[cd]-bandwagon-dc6":
      return { status: "degraded", status_since: iso(-43 * MINUTE), status_reason: SINGBOX_DOWN(43) };
    case "[cd]-hetzner-hel":
      return { status: "degraded", status_since: iso(-9 * MINUTE), status_reason: SINGBOX_DOWN(9) };
    case "[Metix]-qqpw-cd2-VDS":
      return { status: "degraded", status_since: iso(-23 * MINUTE), status_reason: "Reporting, but the agent's work loop has been in step usage for 26m." };
    case "[cd]-cloudcone-la":
      return { status: "offline", online: false, reachability: "offline", status_since: iso(-50 * SECOND), last_seen: iso(-50 * SECOND), status_reason: "No report for 50s." };
    default:
      return undefined;
  }
}

/* ------------------------------ loop health ------------------------------ */

const CORE_ORDER = ["hello", "config", "ip_refresh", "usage", "inventory", "tasks", "monitors", "log_sources"];

/**
 * A loop report as the server shows it. `agent` is the agent's clock offset
 * from the harness (ms, positive when fast); `received` is how long ago the
 * beat arrived.
 */
function loopHealth(input: {
  agent?: number;
  received?: number;
  uptime: number;
  cycleAgo: number;
  cycleMs: number;
  step?: { name: string; for: number };
  steps?: Record<string, Partial<{ okAgo: number; errorAgo: number; error: string; errors: number }>>;
  queued?: number;
  dropped?: number;
  problems?: AgentLoopHealth["problems"];
}): AgentLoopHealth {
  const skew = input.agent ?? 0;
  const received = input.received ?? 3 * SECOND;
  // An instant `ago` before the beat was collected, by the agent's clock.
  const at = (ago: number) => iso(-received - ago + skew);
  const steps: Record<string, AgentLoopStep> = {};
  for (const [i, name] of CORE_ORDER.entries()) {
    const override = input.steps?.[name] ?? {};
    const okAgo = override.okAgo ?? input.cycleAgo + (CORE_ORDER.length - i) * 220;
    steps[name] = {
      last_ok_at: okAgo >= 0 ? at(okAgo) : undefined,
      last_error_at: override.errorAgo !== undefined ? at(override.errorAgo) : undefined,
      last_error: override.error,
      consecutive_errors: override.errors || undefined,
    };
  }
  return {
    started_at: at(input.uptime),
    cycle_started_at: at(input.cycleAgo + input.cycleMs),
    cycle_completed_at: at(input.cycleAgo),
    cycle_duration_ms: input.cycleMs,
    step: input.step?.name,
    step_since: input.step ? at(input.step.for) : undefined,
    steps,
    monitor_results_queued: input.queued,
    monitor_results_dropped: input.dropped,
    watchdog: true,
    collected_at: iso(-received + skew),
    received_at: iso(-received),
    problems: input.problems,
  };
}

/** The loop health a node's view carries; none for a node that never reported or is disabled. */
export function loopHealthFor(node: Node, index: number): AgentLoopHealth | null {
  if (node.status === "never_reported" || node.status === "disabled") return null;
  if (node.name === "[Metix]-DMIT-4") {
    // The last beat before it went quiet, six days ago.
    return loopHealth({ received: 6 * DAY + 3 * HOUR, uptime: 30 * DAY, cycleAgo: 9 * SECOND, cycleMs: 2400 });
  }
  if (SOME && node.name === "[Metix]-qqpw-cd2-VDS") {
    return loopHealth({
      agent: 3 * MINUTE,
      uptime: 9 * DAY,
      cycleAgo: 26 * MINUTE,
      cycleMs: 2600,
      step: { name: "usage", for: 26 * MINUTE },
      steps: { usage: { okAgo: 26 * MINUTE + 30 * SECOND }, inventory: { okAgo: 27 * MINUTE }, tasks: { okAgo: 26 * MINUTE + 40 * SECOND }, monitors: { okAgo: 26 * MINUTE + 50 * SECOND } },
      queued: 212,
      problems: [
        {
          kind: "stalled",
          step: "usage",
          since: iso(-23 * MINUTE),
          reason: "The agent's work loop has been in step usage for 26m; heartbeats still arrive.",
          degrades: true,
          pages: true,
        },
      ],
    });
  }
  if (SOME && node.name === "[cd]-DMIT-pro-malibu") {
    return loopHealth({
      uptime: 12 * DAY,
      cycleAgo: 6 * SECOND,
      cycleMs: 3100,
      steps: { usage: { okAgo: 25 * MINUTE, errorAgo: 6 * SECOND, error: "post /api/agent/usage: 502 Bad Gateway", errors: 9 } },
      queued: 64,
      dropped: 12,
      problems: [
        {
          kind: "results_dropped",
          since: iso(-4 * MINUTE),
          reason: "The agent dropped 12 monitor results because its queue was full.",
          degrades: true,
        },
      ],
    });
  }
  return loopHealth({ uptime: (3 + (index % 11)) * DAY, cycleAgo: (2 + (index % 7)) * SECOND, cycleMs: 1400 + (index % 5) * 300 });
}

/* -------------------------------- windows -------------------------------- */

export let windows: MaintenanceWindow[] = SOME
  ? [
      {
        id: "mw_kernel",
        name: "Kernel upgrade",
        reason: "apt full-upgrade and a reboot onto 6.12",
        node_ids: [nodeNamed("[cd]-hetzner-hel").id],
        starts_at: iso(-10 * MINUTE),
        ends_at: iso(50 * MINUTE),
        created_by: "cdcd",
        created_at: iso(-12 * MINUTE),
        updated_at: iso(-12 * MINUTE),
      },
      {
        id: "mw_dmit_net",
        name: "DMIT network work",
        reason: "The provider replaces a core switch in LAX",
        group_ids: [GROUPS[0]?.id ?? "grp_openjobs_vpn"],
        starts_at: iso(DAY + 2 * HOUR),
        ends_at: iso(DAY + 4 * HOUR),
        created_by: "cdcd",
        created_at: iso(-3 * HOUR),
        updated_at: iso(-3 * HOUR),
      },
    ]
  : [];

export function setWindows(next: MaintenanceWindow[]): void {
  windows = next;
}

function windowCovering(nodeId: string, now: number): MaintenanceWindow | undefined {
  return windows.find((w) => {
    if (Date.parse(w.starts_at) > now || Date.parse(w.ends_at) <= now) return false;
    if ((w.node_ids ?? []).includes(nodeId)) return true;
    return (w.group_ids ?? []).some((gid) => GROUPS.find((g) => g.id === gid)?.resolved_members.includes(nodeId));
  });
}

/* ------------------------------- incidents ------------------------------- */

function key(kind: string, nodeId: string, monitorId = ""): string {
  return [kind, nodeId, monitorId].filter(Boolean).join("\u0000");
}

// Every incident's severity comes from the console's severity table
// (lib/incidentSeverity, which mirrors lattice-server incidents.go), so the
// harness renders node.offline as the critical it is in production.
function base(kind: string, node: Node, extra: Partial<Incident>): Incident {
  const severity = eventSeverity(kind);
  return {
    id: `inc_${kind.replace(".", "_")}_${node.id}`,
    key: key(kind, node.id, extra.monitor_id),
    kind,
    recovery_kind: kind.replace(/\.(offline|down|stalled)$/, (m) => ({ ".offline": ".online", ".down": ".recovered", ".stalled": ".recovered" })[m] ?? m),
    severity,
    state: "open",
    node_id: node.id,
    node_name: node.name,
    subject: node.name,
    first_opened_at: extra.opened_at ?? iso(0),
    updated_at: extra.opened_at ?? iso(0),
    ...extra,
  } as Incident;
}

function build(): Incident[] {
  if (!SOME) return [];
  const dmit1 = nodeNamed("[Metix]-DMIT-1");
  const bwg = nodeNamed("[cd]-bandwagon-dc6");
  const dmit4 = nodeNamed("[Metix]-DMIT-4");
  const qqpw = nodeNamed("[Metix]-qqpw-cd2-VDS");
  const fsn = nodeNamed("[cd]-hetzner-fsn");
  const hel = nodeNamed("[cd]-hetzner-hel");
  const mac = nodeNamed("[cd]-mac-air");
  const malibu = nodeNamed("[cd]-DMIT-pro-malibu");
  return [
    base("service.down", dmit1, {
      title: `sing-box inactive on ${dmit1.name}`,
      since: iso(-16 * MINUTE),
      opened_at: iso(-14 * MINUTE),
      notified: "open",
      notified_at: iso(-14 * MINUTE),
      open_notified_at: iso(-14 * MINUTE),
    }),
    base("service.down", bwg, {
      title: `sing-box inactive on ${bwg.name}`,
      since: iso(-43 * MINUTE),
      opened_at: iso(-41 * MINUTE),
      notified: "open",
      notified_at: iso(-11 * MINUTE),
      open_notified_at: iso(-41 * MINUTE),
      escalated: { nrl_alerts: iso(-11 * MINUTE) },
    }),
    base("node.offline", dmit4, {
      title: `Lattice node offline: ${dmit4.name}`,
      since: iso(-(6 * DAY + 3 * HOUR)),
      opened_at: iso(-(6 * DAY + 3 * HOUR) + 3 * MINUTE),
      notified: "open",
      notified_at: iso(-(6 * DAY + 3 * HOUR) + 3 * MINUTE),
      open_notified_at: iso(-(6 * DAY + 3 * HOUR) + 3 * MINUTE),
      no_escalate: true,
    }),
    base("agent.stalled", qqpw, {
      title: `Lattice agent stalled on ${qqpw.name}`,
      state: "acknowledged",
      since: iso(-26 * MINUTE),
      opened_at: iso(-21 * MINUTE),
      notified: "open",
      notified_at: iso(-21 * MINUTE),
      open_notified_at: iso(-21 * MINUTE),
      acked_by: "cdcd",
      acked_at: iso(-18 * MINUTE),
    }),
    base("monitor.down", fsn, {
      id: `inc_monitor_down_${fsn.id}_mon_hk_tcp`,
      monitor_id: "mon_hk_tcp",
      subject: `HK relay port on ${fsn.name}`,
      title: `Monitor down: HK relay port on ${fsn.name}`,
      since: iso(-12 * MINUTE),
      opened_at: iso(-12 * MINUTE),
      notified: "open",
      notified_at: iso(-12 * MINUTE),
      open_notified_at: iso(-12 * MINUTE),
      snoozed_by: "cdcd",
      snoozed_until: iso(2 * HOUR + 40 * MINUTE),
    }),
    base("service.down", hel, {
      title: `sing-box inactive on ${hel.name}`,
      since: iso(-9 * MINUTE),
      opened_at: iso(-7 * MINUTE),
      owed_open: true,
      suppressed: `held by maintenance window "Kernel upgrade" until ${iso(50 * MINUTE)}`,
      suppressed_at: iso(-7 * MINUTE),
    }),
    base("node.offline", mac, {
      state: "resolved",
      title: `Lattice node offline: ${mac.name}`,
      since: iso(-3 * HOUR),
      opened_at: iso(-3 * HOUR + 2 * MINUTE),
      resolved_at: iso(-(2 * HOUR + 10 * MINUTE)),
      notified: "resolved",
      notified_at: iso(-(2 * HOUR + 10 * MINUTE)),
      open_notified_at: iso(-3 * HOUR + 2 * MINUTE),
      flaps: 4,
    }),
    base("monitor.down", malibu, {
      id: `inc_monitor_down_${malibu.id}_mon_console`,
      monitor_id: "mon_console",
      subject: `Lattice console on ${malibu.name}`,
      state: "resolved",
      since: iso(-5 * HOUR - 20 * MINUTE),
      opened_at: iso(-5 * HOUR - 19 * MINUTE),
      resolved_at: iso(-5 * HOUR),
      notified: "resolved",
      notified_at: iso(-5 * HOUR),
      open_notified_at: iso(-5 * HOUR - 19 * MINUTE),
    }),
  ];
}

let incidents: Incident[] = build();

/** The pending offline on cloudcone: derived on read, as the server does. */
function pending(now: number): Incident[] {
  if (!SOME) return [];
  const node = nodeNamed("[cd]-cloudcone-la");
  const k = key("node.offline", node.id);
  return [
    {
      id: `pending:${k}`,
      key: k,
      kind: "node.offline",
      severity: eventSeverity("node.offline"),
      state: "pending",
      node_id: node.id,
      node_name: node.name,
      subject: node.name,
      since: iso(-50 * SECOND),
      opens_at: new Date(now + 70 * SECOND).toISOString(),
      first_opened_at: "0001-01-01T00:00:00Z",
      opened_at: "0001-01-01T00:00:00Z",
      updated_at: iso(-50 * SECOND),
    },
  ];
}

/** GET /api/incidents: records with their window and snooze folded in, plus the pending ones and the active windows. */
export function incidentList() {
  const now = Date.now();
  const rows = incidents.map((incident) => {
    const window = incident.state === "resolved" || !incident.node_id ? undefined : windowCovering(incident.node_id, now);
    const snoozed = !!incident.snoozed_until && Date.parse(incident.snoozed_until) > now && incident.state !== "resolved";
    return { ...incident, maintenance: window?.name, maintenance_id: window?.id, snoozed: snoozed || undefined };
  });
  const active = windows.filter((w) => Date.parse(w.starts_at) <= now && Date.parse(w.ends_at) > now);
  return { incidents: [...rows, ...pending(now)], windows: active, durable: PARAMS.get("durable") !== "no", now: new Date(now).toISOString() };
}

export function findIncident(id: string): Incident | undefined {
  return incidents.find((incident) => incident.id === id);
}

export function updateIncident(id: string, change: Partial<Incident>): Incident {
  incidents = incidents.map((incident) => (incident.id === id ? { ...incident, ...change, updated_at: new Date().toISOString() } : incident));
  return findIncident(id)!;
}
