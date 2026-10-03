/**
 * Pure model for an agent's loop health on the node page (node-agent 0.3.10
 * and later; lattice-server agent_health.go).
 *
 *   Work loop   last full cycle 8 s ago (2.1 s) · watchdog armed
 *   Step        Last OK    Errors   Last error
 *   config      9 s ago    0
 *   usage       25 min     9 in a row   post /api/agent/usage: 502
 *
 * Every instant the agent sent is its own clock. Its age here is
 * (collected_at - t) + (now - received_at): how old it was when the beat was
 * collected, plus how long ago the beat arrived. A node whose clock is an
 * hour off still reads correctly, and nothing compares the agent's clock
 * with the browser's.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { AgentLoopHealth } from "@/lib/api/types";

/** The loop's own order (node-agent cmd/lattice-agent/main.go); unknown steps follow by name. */
export const LOOP_STEP_ORDER = [
  "linechain_recovery",
  "hello",
  "config",
  "ip_refresh",
  "usage",
  "inventory",
  "tasks",
  "monitors",
  "log_sources",
  "trace",
  "debug",
  "guard_reality",
] as const;

/** Steps whose failure means the node is not doing what the control plane asks (the server's rule). */
export const CORE_STEPS = new Set(["config", "tasks", "monitors", "inventory"]);
export const STEP_STALE_ERRORS = 3;
export const STEP_STALE_MS = 15 * 60_000;
/** A beat older than this means the loop health shown is not current. */
export const LOOP_HEALTH_STALE_MS = 10 * 60_000;

function time(value: string | undefined): number {
  if (!value) return NaN;
  const at = Date.parse(value);
  return at > 0 ? at : NaN;
}

/** Age of an agent instant at `now` (browser clock), or undefined when it was never set. */
export function agentAge(health: Pick<AgentLoopHealth, "collected_at" | "received_at">, at: string | undefined, now: number): number | undefined {
  const t = time(at);
  const collected = time(health.collected_at);
  const received = time(health.received_at);
  if (Number.isNaN(t) || Number.isNaN(collected) || Number.isNaN(received)) return undefined;
  return Math.max(0, collected - t + (now - received));
}

export type LoopStepTone = "ok" | "failing" | "stale" | "idle";

export interface LoopStepRow {
  name: string;
  core: boolean;
  lastOkAgeMs?: number;
  lastErrorAgeMs?: number;
  errors: number;
  lastError?: string;
  /** stale: a core step past the server's rule; failing: its last run failed; idle: never ran. */
  tone: LoopStepTone;
  /** The step running right now. */
  running: boolean;
}

export function loopStepRows(health: AgentLoopHealth, now: number): LoopStepRow[] {
  const steps = health.steps ?? {};
  const order = new Map<string, number>(LOOP_STEP_ORDER.map((name, i) => [name, i]));
  const names = Object.keys(steps).sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b));
  return names.map((name) => {
    const step = steps[name] ?? {};
    const lastOkAgeMs = agentAge(health, step.last_ok_at, now);
    const lastErrorAgeMs = agentAge(health, step.last_error_at, now);
    const errors = step.consecutive_errors ?? 0;
    const core = CORE_STEPS.has(name);
    let tone: LoopStepTone = "idle";
    if (errors > 0) {
      const sinceOk = lastOkAgeMs ?? agentAge(health, health.started_at, now) ?? 0;
      tone = core && errors >= STEP_STALE_ERRORS && sinceOk >= STEP_STALE_MS ? "stale" : "failing";
    } else if (lastOkAgeMs !== undefined) {
      tone = "ok";
    }
    return { name, core, lastOkAgeMs, lastErrorAgeMs, errors, lastError: step.last_error?.trim() || undefined, tone, running: health.step === name };
  });
}

export interface LoopSummary {
  /** How long ago the last full cycle completed; undefined before the first. */
  cycleAgeMs?: number;
  cycleDurationMs?: number;
  step?: string;
  stepAgeMs?: number;
  blocked?: { reason: string; ageMs?: number };
  taskBusyAgeMs?: number;
  uptimeMs?: number;
  watchdog: boolean;
  queued: number;
  dropped: number;
  /** How long ago the beat carrying all this arrived. */
  beatAgeMs?: number;
  /** The beat is old: the node stopped reporting, so this is history. */
  stale: boolean;
}

export function loopSummary(health: AgentLoopHealth, now: number): LoopSummary {
  const received = time(health.received_at);
  const beatAgeMs = Number.isNaN(received) ? undefined : Math.max(0, now - received);
  return {
    cycleAgeMs: agentAge(health, health.cycle_completed_at, now),
    cycleDurationMs: health.cycle_duration_ms || undefined,
    step: health.step || undefined,
    stepAgeMs: health.step ? agentAge(health, health.step_since, now) : undefined,
    blocked: health.linechain_blocked ? { reason: health.linechain_blocked, ageMs: agentAge(health, health.linechain_blocked_since, now) } : undefined,
    taskBusyAgeMs: agentAge(health, health.task_busy_since, now),
    uptimeMs: agentAge(health, health.started_at, now),
    watchdog: !!health.watchdog,
    queued: health.monitor_results_queued ?? 0,
    dropped: health.monitor_results_dropped ?? 0,
    beatAgeMs,
    stale: beatAgeMs !== undefined && beatAgeMs > LOOP_HEALTH_STALE_MS,
  };
}

export type LoopProblemKind = "stalled" | "linechain_blocked" | "step_stale" | "results_dropped";

/** The server's problems as the panel words them; an unknown kind keeps its sentence. */
export function loopProblems(health: AgentLoopHealth): { kind: LoopProblemKind | "other"; step?: string; since: number; reason: string; pages: boolean; degrades: boolean }[] {
  const known = new Set<string>(["stalled", "linechain_blocked", "step_stale", "results_dropped"]);
  return (health.problems ?? []).map((p) => ({
    kind: known.has(p.kind) ? (p.kind as LoopProblemKind) : "other",
    step: p.step || undefined,
    since: time(p.since) || 0,
    reason: p.reason,
    pages: !!p.pages,
    degrades: !!p.degrades,
  }));
}
