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
