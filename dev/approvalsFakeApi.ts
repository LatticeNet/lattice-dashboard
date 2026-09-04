/**
 * An in-memory stand-in for `@/lib/api` for the approvals page, wired in by
 * vite.harness.config.ts through a resolve alias so the production config and
 * bundle never see it.
 *
 *   LATTICE_HARNESS=approvals pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/approvals.html
 *   open http://127.0.0.1:5185/dev/approvals.html?state=empty
 *   open http://127.0.0.1:5185/dev/approvals.html?state=small   (the eleven hand-written rows only)
 *   open http://127.0.0.1:5185/dev/approvals.html?scope=read
 *   open http://127.0.0.1:5185/dev/approvals.html?legacy=1      (every listing carries plan text, as before)
 *
 * The default fixture is a fleet's worth: production's 1,084 applied and 190
 * rejected rows, a pending wave, and every way an approved change can be
 * stuck (see ./approvalsFixture.ts). Latency is proportional to bytes, so the
 * page is slow here in exactly the way it was slow in production when it
 * reads too much. window.__approvalsRequests lists what the fake answered.
 *
 * Everything the real barrel exports is re-exported unchanged; only `api` is
 * replaced, and only the calls ApprovalsView makes are implemented. Anything
 * else rejects, loudly, so a new call path is noticed rather than silently fed
 * nothing.
 */
import type { ApprovalView, Principal } from "@/lib/api/index";
import { HAND_WRITTEN, buildApprovalsFixture, fakeApprovalsApi, type FakeRequest } from "./approvalsFixture";

export * from "@/lib/api/index";

const LATENCY_MS = 60;

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function query(key: string): string {
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

const approvals: ApprovalView[] =
  query("state") === "empty" ? [] : query("state") === "small" ? HAND_WRITTEN.map((a) => ({ ...a })) : buildApprovalsFixture();

const requests: FakeRequest[] = [];
(window as unknown as { __approvalsRequests: FakeRequest[] }).__approvalsRequests = requests;
(window as unknown as { __approvalsStoreSize: number }).__approvalsStoreSize = approvals.length;

const listing = fakeApprovalsApi(approvals, { log: requests, legacyAlwaysPlan: query("legacy") === "1" });

function find(id: string): ApprovalView | undefined {
  return approvals.find((approval) => approval.id === id);
}

// A read-only operator must be able to see the explanation and be told plainly
// that the exits are not theirs to take.
const READ_ONLY_SCOPES = ["node:read", "approval:read", "task:read", "audit:read"];
const FULL_SCOPES = [...READ_ONLY_SCOPES, "network:apply", "network:plan", "node:admin", "netpolicy:admin", "proxy:admin", "sshguard:admin"];

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: query("scope") === "read" ? READ_ONLY_SCOPES : FULL_SCOPES,
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the approvals harness`));
    },
  },
);

export const api = {
  auth: { me: () => delay(principal) },
  approvals: {
    list: (params?: Record<string, unknown>) => listing.list(params),
    counts: (params?: Record<string, unknown>) => listing.counts(params),
    get: (id: string) => listing.get(id),
    approve: (approval_id: string, queue_apply: boolean, plan_sha256?: string) => {
      const approval = find(approval_id);
      if (!approval) return Promise.reject(new Error("approval not found"));
      // The server checks the digest against the stored plan; the fake checks
      // that one was sent, which is the console's half of the contract.
      if (!plan_sha256) return Promise.reject(new Error("plan_sha256 is required"));
      approval.status = "approved";
      approval.approved_by = "cdcd";
      approval.updated_at = new Date().toISOString();
      approval.waiting = queue_apply
        ? {
            code: "task_queued",
            reason: `Queued as task task_${approval_id.slice(-8)}; the node picks it up on its next poll.`,
            blocked: false,
            node_id: approval.node_id,
            node_status: "online",
            dismissible: false,
          }
        : {
            code: "not_queued",
            reason: "Approved without queueing an apply, and nothing has queued one since.",
            blocked: true,
            node_id: approval.node_id,
            node_status: "online",
            dismissible: false,
          };
      return delay(undefined);
    },
    reject: (approval_id: string) => {
      const approval = find(approval_id);
      if (approval && approval.status === "pending") {
        approval.status = "rejected";
        approval.updated_at = new Date().toISOString();
        approval.waiting = undefined;
      }
      return delay(approval);
    },
    dismiss: (approval_id: string) => {
      const approval = find(approval_id);
      if (!approval?.waiting?.dismissible) {
        return Promise.reject(new Error("approval is not stale; reject or approve it explicitly"));
      }
      approval.status = "dismissed";
      approval.reason = `Approved but never applied, dismissed by an operator. ${approval.waiting.reason} Re-plan if this change is still wanted.`;
      approval.updated_at = new Date().toISOString();
      approval.waiting = undefined;
      return delay(approval);
    },
  },
  agentUpdates: {
    plan: () => Promise.reject(new Error("fake api: re-planning is not implemented in the approvals harness")),
  },
  nodes: { list: () => delay({ nodes: [] }) },
  tasks: unimplemented,
  audit: unimplemented,
  capabilities: unimplemented,
  plugins: unimplemented,
} as unknown as typeof import("@/lib/api/index").api;
