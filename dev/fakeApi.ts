/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 * Everything the real barrel exports is re-exported unchanged (types,
 * ApiError, unwrap, the CSRF helpers); only `api` is replaced, and only the
 * calls SSH Guard and its stores make are implemented. Anything else throws,
 * loudly, so a new call path is noticed rather than silently fed nothing.
 */
import { ApiError } from "@/lib/api/client";
import type {
  ApprovalView,
  Node,
  NodeCapability,
  Principal,
  SSHGuardFinding,
  SSHGuardPlanRequest,
  SSHGuardPlanResponse,
} from "@/lib/api/index";

import { fixtureId, fixtureIso, toApiNodes } from "./sshGuardFixture";
import { state } from "./fixtureState";

export * from "@/lib/api/index";

const LATENCY_MS = 180;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

function nodeByName(name: string) {
  return state.nodes.find((n) => n.name === name);
}

// Two of the failed-arm nodes misbehave on purpose so the batch outcome shows
// every kind at once: one is refused by the pre-check, one fails outright.
const LINT_BLOCKED = nodeByName("[Metix]-DMIT-1")?.id;
const PLAN_FAILS = nodeByName("[Metix]-Oracle-KIX-arm")?.id;

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: ["sshguard:admin", "network:plan", "node:read", "node:admin", "netguard:read", "approval:read"],
  server_allowlist: [],
  csrf_token: "harness",
};

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the harness`));
    },
  },
);

export const api = {
  auth: {
    me: () => delay(principal),
  },
  approvals: {
    list: () => delay({ approvals: state.approvals.map((a) => ({ ...a })) }),
  },
  nodes: {
    list: () => delay({ nodes: toApiNodes(state.nodes) as Node[] }),
    capabilities: () => delay({ capabilities: state.capabilities.map((c) => ({ ...c })), known: [] }),
    setCapability: async (input: { node_id: string; capability: string; state: "enrolled" | "excluded" | ""; reason?: string }) => {
      await delay(undefined);
      const node = state.nodes.find((n) => n.id === input.node_id);
      if (!node) throw new ApiError(404, "not_found", "node not found");
      state.capabilities = state.capabilities.filter((c) => c.node_id !== input.node_id);
      node.scope = input.state || "undecided";
      const record: NodeCapability = {
        node_id: input.node_id,
        capability: input.capability,
        state: (input.state || "enrolled") as "enrolled" | "excluded",
        reason: input.reason,
        actor_id: principal.actor_id,
        updated_at: fixtureIso(0),
        enforced: true,
      };
      if (input.state) state.capabilities.push(record);
      return record;
    },
  },
  sshGuard: {
    plan: async (input: SSHGuardPlanRequest): Promise<SSHGuardPlanResponse> => {
      await delay(undefined);
      const node = state.nodes.find((n) => n.id === input.node_id);
      if (!node) throw new ApiError(404, "not_found", "node not found");
      if (node.scope !== "enrolled") {
        throw new ApiError(403, "capability_denied", `sshguard: node ${node.name} is not enrolled in SSH Guard`);
      }
      if (input.node_id === PLAN_FAILS) {
        throw new ApiError(503, "node_unreachable", "task queue: node has not reported for 3d 4h; refusing to arm a node that cannot post its result", "req_5c1e9a");
      }
      const findings: SSHGuardFinding[] = [];
      if (input.node_id === LINT_BLOCKED && !input.accept_findings) {
        findings.push(
          { code: "port_in_use", severity: "block", message: `tcp/${input.ssh_port ?? 58394} is already bound by sing-box on this node` },
          { code: "mgmt_source_unroutable", severity: "warn", message: "203.0.113.5 is not in any interface's prefix; it will be admitted but cannot be verified" },
        );
        throw new ApiError(409, "plan_blocked", "plan blocked by lint findings", "req_8d0f21", { error: "plan blocked by lint findings", findings });
      }
      if (input.enable_knock && !(input.mgmt_sources?.length)) {
        findings.push({ code: "knock_only_path", severity: "warn", message: "the knock sequence is the only permanent way in; the terminal fallback stands in for a source" });
      }
      const approval: ApprovalView = {
        id: fixtureId("apr"),
        node_id: input.node_id,
        plugin: "sshguard",
        action: "sshguard-arm:v1",
        plan: `stage: arm\nnode_id: ${input.node_id}\nssh_port: ${input.ssh_port ?? 0}\nconfirm_window_sec: ${input.confirm_window_sec ?? 900}\n`,
        status: "pending",
        created_at: fixtureIso(0),
        updated_at: fixtureIso(0),
      };
      state.approvals.push(approval);
      node.stage = "armPending";
      return { approval, findings };
    },
    confirm: async (node_id: string) => {
      await delay(undefined);
      const node = state.nodes.find((n) => n.id === node_id);
      if (!node) throw new ApiError(404, "not_found", "node not found");
      const approval: ApprovalView = {
        id: fixtureId("apr"),
        node_id,
        plugin: "sshguard",
        action: "sshguard-confirm:v1",
        plan: "stage: confirm\n",
        status: "pending",
        created_at: fixtureIso(0),
        updated_at: fixtureIso(0),
      };
      state.approvals.push(approval);
      return { approval };
    },
  },
  // Everything else: a loud failure, never a silent empty list.
  capabilities: unimplemented,
  plugins: unimplemented,
  audit: unimplemented,
};
