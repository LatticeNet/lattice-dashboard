/**
 * What a monitor is doing now, read from its results (design 23, 4.2).
 *
 * The list used to show configuration only (type, target, every) and drew
 * every enabled monitor in the success colour, so a monitor that had failed
 * its last three checks sat beside the healthy ones with the same green
 * icon. The state comes from each node's newest result, the same rule the
 * sheet's badge uses, so the row and the sheet never disagree. The server
 * sends those newest results with the monitors list (`latest`), so every
 * listed monitor has a state without a read of its own.
 *
 * A newest result older than three intervals (three minutes at least) is not
 * a current reading: the agents stopped reporting it, and the row says when
 * the last one arrived instead of "up".
 *
 * Kept free of Vue so `node --test` covers it directly.
 */

export interface HealthMonitor {
  id: string;
  enabled: boolean;
  interval_sec: number;
}

export interface HealthResult {
  node_id?: string;
  at: string;
  success: boolean;
  latency_ms?: number;
}

export type MonitorHealth =
  | { kind: "disabled" }
  /** Results not read yet, or the read failed or was not made. */
  | { kind: "unread" }
  | { kind: "none" }
  | { kind: "failing"; failing: number; total: number; lastAt: number }
  | { kind: "stale"; lastAt: number }
  | { kind: "up"; total: number; latencyMs?: number; lastAt: number };

/** Failing first, then what cannot be trusted, then what is fine. */
const RANK: Record<MonitorHealth["kind"], number> = {
  failing: 0,
  stale: 1,
  none: 2,
  unread: 3,
  up: 4,
  disabled: 5,
};

export function healthRank(health: MonitorHealth): number {
  return RANK[health.kind];
}

function time(at: string): number {
  const value = Date.parse(at);
  return Number.isNaN(value) ? 0 : value;
}

/** Each node's newest result (a tls result has no node: the control plane's). */
export function latestPerNode<R extends HealthResult>(results: readonly R[]): R[] {
  const newest = new Map<string, R>();
  for (const result of results) {
    const key = result.node_id ?? "";
    const held = newest.get(key);
    if (!held || time(result.at) >= time(held.at)) newest.set(key, result);
  }
  return [...newest.values()];
}

/** How old the newest result may be before it stops counting as a reading. */
export function staleAfterMs(monitor: Pick<HealthMonitor, "interval_sec">): number {
  const interval = Number.isFinite(monitor.interval_sec) && monitor.interval_sec > 0 ? monitor.interval_sec : 60;
  return Math.max(3 * interval, 180) * 1000;
}

export function monitorHealth(
  monitor: HealthMonitor,
  results: readonly HealthResult[] | undefined,
  now: number,
): MonitorHealth {
  if (!monitor.enabled) return { kind: "disabled" };
  if (results === undefined) return { kind: "unread" };
  const latest = latestPerNode(results);
  if (latest.length === 0) return { kind: "none" };
  const lastAt = Math.max(...latest.map((result) => time(result.at)));
  const failing = latest.filter((result) => !result.success).length;
  if (failing > 0) return { kind: "failing", failing, total: latest.length, lastAt };
  if (now - lastAt > staleAfterMs(monitor)) return { kind: "stale", lastAt };
  const latencies = latest
    .map((result) => result.latency_ms)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const latencyMs = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : undefined;
  return { kind: "up", total: latest.length, latencyMs, lastAt };
}

/** Monitors whose newest results include a failure, worst first (most nodes failing). */
export function failingMonitors<M extends HealthMonitor>(
  monitors: readonly M[],
  health: (monitor: M) => MonitorHealth,
): { monitor: M; failing: number; total: number }[] {
  const out: { monitor: M; failing: number; total: number }[] = [];
  for (const monitor of monitors) {
    const state = health(monitor);
    if (state.kind === "failing") out.push({ monitor, failing: state.failing, total: state.total });
  }
  return out.sort((a, b) => b.failing - a.failing);
}
