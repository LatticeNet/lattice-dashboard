/**
 * Shapes the approvals endpoint answers, decoded without touching the network
 * or the DOM so the rules can run under bare node.
 */
import type { ApprovalCounts, ApprovalView } from "./types";

/** Total of a listing: the server's count when enveloped, else the rows. */
export function approvalListTotal(res: { approvals: ApprovalView[]; total?: number } | ApprovalView[]): number {
  if (Array.isArray(res)) return res.length;
  return typeof res.total === "number" ? res.total : res.approvals.length;
}

export function unwrapApproval(res: { approval: ApprovalView } | ApprovalView): ApprovalView {
  return "approval" in res && res.approval && typeof res.approval === "object" ? res.approval : (res as ApprovalView);
}

const APPROVAL_COUNT_KEYS = ["pending", "approved", "stale", "applied", "rejected", "dismissed", "total"] as const;

/** Every known key present, zero when the server left it out. */
export function unwrapApprovalCounts(res: { counts?: Partial<ApprovalCounts> } | Partial<ApprovalCounts>): ApprovalCounts {
  const raw = ("counts" in res && res.counts && typeof res.counts === "object" ? res.counts : res) as Partial<ApprovalCounts>;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  for (const key of APPROVAL_COUNT_KEYS) out[key] ??= 0;
  return out as ApprovalCounts;
}

