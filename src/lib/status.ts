/**
 * Single source of truth: status -> visual treatment.
 *
 * Eliminates the ad-hoc `status -> color` logic duplicated across ~12 views
 * (NodesView, UsersView, SubscriptionsView, ...). Every helper returns a
 * {@link StatusMeta} whose class strings are GUARANTEED to exist in
 * `src/style/app.css` (success / warning / info / destructive tokens) and
 * whose `badgeVariant` is one of the REAL `badgeVariants` defined in
 * `src/components/ui/badge/badgeVariants.ts`.
 *
 * Pure TS — no Vue import. Safe to use in `<script setup>`, computed getters,
 * table cells, or plain data transforms.
 */

import type { BadgeVariants } from "@/components/ui/badge/badgeVariants";

/** Health states understood by {@link StatusDot} (`src/components/common/StatusDot.vue`). */
export type NodeHealth = "online" | "offline" | "degraded" | "pending" | "unknown";

/** Real Badge variants — mirrors {@link BadgeVariants} so it can never drift. */
export type BadgeVariant = NonNullable<BadgeVariants["variant"]>;

/** Quota usage buckets: under the soft limit / approaching it / over it. */
export type QuotaState = "ok" | "near" | "over";

/**
 * The full visual treatment for a status. Every field is a class string (or
 * variant token) the caller can bind directly — `:variant`, `:class`, etc.
 */
export interface StatusMeta {
  /** Drives `<StatusDot :status="...">` (and conveys the canonical health). */
  dotStatus: NodeHealth;
  /** Drives `<Badge :variant="...">` — always a real variant token. */
  badgeVariant: BadgeVariant;
  /** Foreground text color, e.g. `text-success` / `text-warning`. */
  textClass: string;
  /** Soft tinted background + matching border, e.g. `bg-success/5 border-success/40`. */
  softBgClass: string;
  /** Optional icon-chip background (StatCard-style), e.g. `bg-success/10 text-success`. */
  iconBgClass?: string;
}

/* ------------------------------------------------------------------ */
/* Treatment table — the ONLY place colors are assigned to a state.    */
/* ------------------------------------------------------------------ */

/**
 * Canonical mapping from a health/severity tone to its class treatment.
 * Keyed by {@link NodeHealth} so it doubles as the lookup for nodes,
 * quotas, plans, and approvals (all of which normalize to one of these).
 */
const TREATMENT: Record<NodeHealth, StatusMeta> = {
  online: {
    dotStatus: "online",
    badgeVariant: "success",
    textClass: "text-success",
    softBgClass: "bg-success/5 border-success/40",
    iconBgClass: "bg-success/10 text-success",
  },
  offline: {
    dotStatus: "offline",
    badgeVariant: "destructive",
    textClass: "text-destructive",
    softBgClass: "bg-destructive/5 border-destructive/40",
    iconBgClass: "bg-destructive/10 text-destructive",
  },
  degraded: {
    dotStatus: "degraded",
    badgeVariant: "warning",
    textClass: "text-warning",
    softBgClass: "bg-warning/5 border-warning/40",
    iconBgClass: "bg-warning/10 text-warning",
  },
  pending: {
    dotStatus: "pending",
    badgeVariant: "info",
    textClass: "text-info",
    softBgClass: "bg-info/5 border-info/40",
    iconBgClass: "bg-info/10 text-info",
  },
  unknown: {
    dotStatus: "unknown",
    badgeVariant: "secondary",
    textClass: "text-muted-foreground",
    softBgClass: "bg-muted/40 border-border",
    iconBgClass: "bg-accent text-accent-foreground",
  },
};

/**
 * Resolve a {@link NodeHealth} to its visual treatment. Returns a fresh object
 * so callers can never mutate the shared table.
 */
export function statusMeta(health: NodeHealth): StatusMeta {
  return { ...TREATMENT[health] };
}

/* ------------------------------------------------------------------ */
/* Node health.                                                        */
/* ------------------------------------------------------------------ */

/** Minimal shape needed to derive node health — structurally matches `Node`. */
export interface NodeHealthInput {
  online?: boolean;
  disabled?: boolean;
  last_seen?: string;
  metrics?: {
    cpu_percent?: number;
    memory_used?: number;
    memory_total?: number;
    disk_used?: number;
    disk_total?: number;
  };
}

/**
 * Derive a node's health.
 *
 * Rules (in order):
 *  - `disabled` -> `"offline"` (an operator-disabled node is treated as down).
 *  - `online === false` -> `"offline"`.
 *  - `online === true`:
 *      - degraded when any core resource is critically saturated
 *        (CPU >= 90%, memory >= 90%, or disk >= 95%). This derivation is
 *        OPTIONAL/heuristic — pass a node without metrics and it stays
 *        `"online"`. Tweak {@link DEGRADED_THRESHOLDS} to adjust.
 *      - otherwise `"online"`.
 *  - `online === undefined` (no signal at all) -> `"unknown"`.
 *
 * `"pending"` is never produced here — it is reserved for enrollment/approval
 * flows that call {@link statusMeta}/{@link approvalStatusMeta} directly.
 */
export function nodeHealth(node: NodeHealthInput): NodeHealth {
  if (node.disabled) return "offline";
  if (node.online === false) return "offline";
  if (node.online === true) {
    return isDegraded(node.metrics) ? "degraded" : "online";
  }
  return "unknown";
}

/** Saturation thresholds (percent) above which a node is considered degraded. */
const DEGRADED_THRESHOLDS = { cpu: 90, memory: 90, disk: 95 } as const;

function pct(used?: number, total?: number): number {
  if (!used || !total || total <= 0) return 0;
  return (used / total) * 100;
}

function isDegraded(metrics?: NodeHealthInput["metrics"]): boolean {
  if (!metrics) return false;
  if ((metrics.cpu_percent ?? 0) >= DEGRADED_THRESHOLDS.cpu) return true;
  if (pct(metrics.memory_used, metrics.memory_total) >= DEGRADED_THRESHOLDS.memory) return true;
  if (pct(metrics.disk_used, metrics.disk_total) >= DEGRADED_THRESHOLDS.disk) return true;
  return false;
}

/** Visual treatment for a node, derived from {@link nodeHealth}. */
export function nodeStatusMeta(node: NodeHealthInput): StatusMeta {
  return statusMeta(nodeHealth(node));
}

/* ------------------------------------------------------------------ */
/* Quota usage.                                                        */
/* ------------------------------------------------------------------ */

/** Ratio (0-1) at/above which quota is "near" the limit. */
export const QUOTA_NEAR_RATIO = 0.8;
/** Ratio (0-1) at/above which quota is "over" the limit. */
export const QUOTA_OVER_RATIO = 1;

/**
 * Bucket a usage ratio.
 * @param usedRatio used/total as a fraction in [0, ∞). 0.5 == 50%, 1 == 100%.
 */
export function quotaState(usedRatio: number): QuotaState {
  if (!Number.isFinite(usedRatio)) return "ok";
  if (usedRatio >= QUOTA_OVER_RATIO) return "over";
  if (usedRatio >= QUOTA_NEAR_RATIO) return "near";
  return "ok";
}

const QUOTA_HEALTH: Record<QuotaState, NodeHealth> = {
  ok: "online",
  near: "degraded",
  over: "offline",
};

/**
 * Visual treatment for a quota usage ratio.
 * - `ok`   -> success (online-style green)
 * - `near` -> warning (degraded-style amber)
 * - `over` -> destructive (offline-style red)
 *
 * @param usedRatio used/total as a fraction (e.g. `used / limit`). Values >= 1
 *   are "over". Pass `bytesUsed / bytesLimit`, NOT a 0-100 percentage.
 */
export function quotaStatusMeta(usedRatio: number): StatusMeta {
  return statusMeta(QUOTA_HEALTH[quotaState(usedRatio)]);
}

/* ------------------------------------------------------------------ */
/* Plan / approval / generic lifecycle states.                         */
/* ------------------------------------------------------------------ */

/**
 * Proxy-user / subscription lifecycle states (matches `ProxyUserStatus`).
 * `over_quota` and `expired` both render as a warning per existing views.
 */
export type LifecycleStatus = "active" | "expired" | "over_quota" | "pending" | string;

const LIFECYCLE_HEALTH: Record<string, NodeHealth> = {
  active: "online",
  expired: "degraded",
  over_quota: "degraded",
  pending: "pending",
};

/**
 * Visual treatment for a proxy-user / subscription lifecycle status.
 * Unrecognized values fall back to `"unknown"` (neutral/secondary).
 */
export function lifecycleStatusMeta(status: LifecycleStatus): StatusMeta {
  return statusMeta(LIFECYCLE_HEALTH[status] ?? "unknown");
}

/** Mutation / enrollment approval states (plan -> approve -> apply). */
export type ApprovalStatus =
  | "approved"
  | "applied"
  | "pending"
  | "rejected"
  | "failed"
  | "expired"
  | string;

const APPROVAL_HEALTH: Record<string, NodeHealth> = {
  approved: "online",
  applied: "online",
  pending: "pending",
  rejected: "offline",
  failed: "offline",
  expired: "degraded",
};

/**
 * Visual treatment for an approval/mutation state.
 * Unrecognized values fall back to `"pending"` (info) since unknown approval
 * states are most safely surfaced as awaiting action.
 */
export function approvalStatusMeta(status: ApprovalStatus): StatusMeta {
  return statusMeta(APPROVAL_HEALTH[status] ?? "pending");
}
