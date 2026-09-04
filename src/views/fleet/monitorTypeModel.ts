/**
 * What each monitor type needs from the create form.
 *
 * `tcp` and `http` are agent probes: the operator picks which nodes run them,
 * and every result carries the node that produced it. `tls` is not. The server
 * dials the target itself, reads the leaf certificate and fails the probe once
 * fewer than `threshold_days` remain, so a node assignment on a tls monitor is
 * not a preference the server ignores, it is a request the server refuses.
 *
 * Encoding that here rather than in the template keeps the form and the
 * server's normalizer describing the same rule, and lets the rule be asserted.
 */
import type { MonitorCreateInput, MonitorType } from "@/lib/api";

export const MONITOR_TYPES: MonitorType[] = ["tcp", "http", "tls"];

/** Server defaults for a certificate watch, mirrored so the form opens on them. */
export const TLS_DEFAULT_THRESHOLD_DAYS = 14;
export const TLS_MAX_THRESHOLD_DAYS = 825;
/** Expiry moves by the day, so an hour is already far more often than it can change. */
export const TLS_DEFAULT_INTERVAL_SEC = 3600;
export const TLS_DEFAULT_TIMEOUT_SEC = 10;

/** Whether the control plane runs this probe itself instead of handing it to agents. */
export function isServerEvaluated(type: string): boolean {
  return type === "tls";
}

/** Whether the type carries an expiry window. Only the certificate watch does. */
export function usesThreshold(type: string): boolean {
  return type === "tls";
}

/**
 * Why a tls target is unacceptable, or undefined when it is fine. The probe
 * reads whatever certificate the endpoint presents at handshake and does not
 * speak the protocol behind the port, so a URL would promise something it does
 * not do: host:port only.
 */
export function tlsTargetError(target: string): string | undefined {
  const value = target.trim();
  if (!value) return "empty";
  if (value.includes("://") || value.includes("/")) return "not_host_port";
  const at = value.lastIndexOf(":");
  if (at <= 0 || at === value.length - 1) return "not_host_port";
  const port = Number(value.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port_range";
  return undefined;
}

export interface MonitorFormState {
  name: string;
  type: string;
  target: string;
  intervalSec: number;
  timeoutSec: number;
  thresholdDays: number;
  assignAll: boolean;
  nodeIds: string[];
}

/** Whether the form as it stands can be submitted at all. */
export function canSubmitMonitor(form: MonitorFormState): boolean {
  if (!form.name.trim() || !form.target.trim()) return false;
  if (isServerEvaluated(form.type)) {
    if (tlsTargetError(form.target)) return false;
    return (
      Number.isInteger(form.thresholdDays) &&
      form.thresholdDays >= 1 &&
      form.thresholdDays <= TLS_MAX_THRESHOLD_DAYS
    );
  }
  return form.assignAll || form.nodeIds.length > 0;
}

/**
 * The create body. A tls monitor is sent with no assignment at all and with
 * its threshold; an agent monitor is sent with its assignment and no
 * threshold, so a leftover value from a type the operator switched away from
 * never reaches the server.
 */
export function buildMonitorCreate(form: MonitorFormState): MonitorCreateInput {
  const base = {
    name: form.name.trim(),
    type: form.type as MonitorType,
    target: form.target.trim(),
    interval_sec: form.intervalSec,
    timeout_sec: form.timeoutSec,
  };
  if (isServerEvaluated(form.type)) {
    return { ...base, threshold_days: form.thresholdDays, assign_all: false };
  }
  return {
    ...base,
    assign_all: form.assignAll,
    node_ids: form.assignAll ? undefined : form.nodeIds,
  };
}

// ── Switching type without losing the operator's work ─────────────────────

/** Agent-probe defaults, mirrored so a form that returns to tcp or http opens on them. */
export const AGENT_DEFAULT_INTERVAL_SEC = 30;
export const AGENT_DEFAULT_TIMEOUT_SEC = 5;

/** The part of the create form a type switch used to overwrite. */
export interface ProbeAssignment {
  assignAll: boolean;
  nodeIds: string[];
  intervalSec: number;
  timeoutSec: number;
}

export interface TypeSwitch {
  /** The assignment and cadence after the switch. */
  state: ProbeAssignment;
  /** What to hold aside for the way back, or undefined once it has been handed back. */
  stash: ProbeAssignment | undefined;
}

/**
 * What a change of monitor type does to the assignment and the cadence.
 *
 * A certificate watch is dialled by the server, so it has no node assignment
 * and wants an hourly cadence, and the form has to say so. It used to say so
 * by overwriting: switching to tls emptied the node list and forced 3600/10,
 * switching back forced assign-all and 30/5, and a long picker the operator
 * had worked through was gone for good after one mis-click on a select.
 *
 * So the agent-probe state is held aside on the way out and handed back on the
 * way in. Nothing is destroyed by a round trip through tls, and a switch
 * between two agent types (tcp to http) leaves the assignment alone, because
 * both types run it.
 */
export function switchMonitorType(
  previous: string,
  next: string,
  current: ProbeAssignment,
  stash: ProbeAssignment | undefined,
): TypeSwitch {
  if (next === previous) return { state: current, stash };
  if (isServerEvaluated(next)) {
    return {
      // Keep the newest agent state, not the oldest: tcp to http to tls has to
      // come back to what the operator last had, not to what they had first.
      stash: isServerEvaluated(previous) ? stash : { ...current, nodeIds: [...current.nodeIds] },
      state: {
        assignAll: false,
        nodeIds: [],
        intervalSec: TLS_DEFAULT_INTERVAL_SEC,
        timeoutSec: TLS_DEFAULT_TIMEOUT_SEC,
      },
    };
  }
  if (!isServerEvaluated(previous)) return { state: current, stash };
  return {
    stash: undefined,
    state: stash
      ? { ...stash, nodeIds: [...stash.nodeIds] }
      : {
          assignAll: true,
          nodeIds: [],
          intervalSec: AGENT_DEFAULT_INTERVAL_SEC,
          timeoutSec: AGENT_DEFAULT_TIMEOUT_SEC,
        },
  };
}
