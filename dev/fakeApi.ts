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
  SSHGuardKnockStateResponse,
  SSHGuardPlanRequest,
  SSHGuardPlanResponse,
} from "@/lib/api/index";

import { NO_KNOCK_NODE, SUPERSEDED_CODE, fixtureId, fixtureIso, toApiNodes } from "./sshGuardFixture";
import { state } from "./fixtureState";

export * from "@/lib/api/index";

const LATENCY_MS = 180;



function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

function nodeByName(name: string) {
  return state.nodes.find((n) => n.name === name);
}

/** Stable per node so a reveal, a hide and a second reveal agree, and so a rotation's digest can be checked against it. */
function knockPorts(nodeId: string): number[] {
  const seed = [...nodeId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 40000, 7);
  return [20000 + seed, 20000 + ((seed * 7 + 911) % 40000), 20000 + ((seed * 13 + 5077) % 40000)];
}

function knockDigest(nodeId: string): string {
  return knockPorts(nodeId).map((p) => p.toString(16).padStart(4, "0")).join("").padEnd(64, "0");
}

/** Whether an arm plan carried a firewall with a knock, read from the header line RenderArmPlan writes. */
function planKnocks(a: ApprovalView): boolean {
  return /^knock: true$/m.test(a.plan ?? "");
}

/** The port the arm plan moved sshd to, as the server reads it back out of the plan. */
function planSshPort(a: ApprovalView | undefined): number {
  const m = /^ssh_port:\s*(\d+)\s*$/m.exec(a?.plan ?? "");
  return m ? Number(m[1]) : 58394;
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
  // Step-up, so the reveal's second factor can be exercised here. Any six
  // digits pass: the harness is for driving the states the page renders, and
  // the real check lives on the server where the grant is minted.
  security: {
    stepUp: async (code: string) => {
      await delay(undefined);
      if (!/^\d{6}$/.test(code.trim())) throw new ApiError(401, "unauthorized", "invalid second factor");
      return { ok: true, grant: fixtureId("grant"), expires_at: new Date(Date.now() + 60_000).toISOString() };
    },
    stepUpWebAuthnBegin: async () => {
      await delay(undefined);
      throw new ApiError(400, "bad_request", "the harness has no relying party; use the passcode");
    },
    stepUpWebAuthnFinish: async () => {
      await delay(undefined);
      throw new ApiError(400, "bad_request", "the harness has no relying party; use the passcode");
    },
  },
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
      // Rotation, as server_sshguard.go's sshGuardRotation reads it: the
      // digest must name the sequence the control plane holds as installed,
      // and previous_knock_ports is the path for a node it never armed.
      const rotation = !!input.rotate_from_sha256 || !!input.previous_knock_ports?.length;
      if (input.rotate_from_sha256) {
        const known: SSHGuardKnockStateResponse = await api.sshGuard.knockState(input.node_id);
        if (known.knowledge !== "installed" && known.knowledge !== "installed_superseded") {
          throw new ApiError(409, "conflict", "the control plane holds no installed knock sequence for this node to rotate from; if the node knocks on a sequence Lattice never installed, pass previous_knock_ports");
        }
        if (input.rotate_from_sha256 !== knockDigest(node.id)) {
          throw new ApiError(409, "conflict", `rotate_from_sha256 does not name the sequence the control plane holds as installed (from ${known.approval_id}); reveal it again, or pass previous_knock_ports if the node runs something else`);
        }
      }
      if (rotation && input.enable_knock === false) {
        throw new ApiError(400, "bad_request", "a rotation with knocking off is a contradiction; drop the rotation fields or turn knocking on");
      }
      if (rotation && node.rotationBlocked && !input.accept_findings) {
        const port = input.ssh_port ?? 58394;
        throw new ApiError(409, "plan_blocked", "plan blocked by lint findings", "req_3b7e10", {
          error: "plan blocked by lint findings",
          findings: [
            { code: "sshguard_no_reality", severity: "warn", message: "this node has never reported its listeners, so the port-conflict and firewall-override checks could not run. The apply verifies the port is listening before it gates anything, but that is a later and more expensive place to find out." },
            { code: "sshguard_overridden_by_guard", severity: "block", message: `this node's lattice_guard ruleset is policy drop and does not accept tcp/${port}. An accept in the knock table does not let a packet skip lattice_guard, so knocking would appear to succeed and the connection would still never open. Open tcp/${port} in netguard first.` },
          ],
        });
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
        plan: `stage: arm\nnode_id: ${input.node_id}\nssh_port: ${input.ssh_port ?? 0}\nknock: ${input.enable_knock !== false}\nconfirm_window_sec: ${input.confirm_window_sec ?? 900}\n${rotation ? "\n## Rotation\n\nThe sequence the node runs today stays honoured beside the new one until the confirm applies.\n" : ""}`,
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
    // The knock endpoints, close enough to the server that every state the
    // page can render is reachable here: installed and confirmed, installed
    // but never confirmed, planned, knocking off, and nothing known at all.
    knockState: async (node_id: string) => {
      await delay(undefined);
      const node = state.nodes.find((n) => n.id === node_id);
      if (!node) throw new ApiError(404, "not_found", "node not found");
      const mine = state.approvals.filter((a) => a.node_id === node_id && a.plugin === "sshguard");
      const arms = mine.filter((a) => a.action === "sshguard-arm:v1");
      // The arm that governs the knock is the newest applied one that carried
      // a firewall with a sequence, as the server's sshGuardKnockStateFor
      // reads it: a hardening-only re-arm on top neither supplies nor
      // retires a knock, so it is skipped and the earlier arm is named.
      const appliedArms = arms.filter((a) => a.status === "applied" && planKnocks(a));
      const applied = appliedArms.length ? appliedArms[appliedArms.length - 1] : undefined;
      const confirmed = mine.some((a) => a.action === "sshguard-confirm:v1" && a.status === "applied");
      // An arm retired as superseded still governs the node when a confirm
      // was dispatched after it, which the server reads from the confirm's
      // own retirement. The fixture files both together.
      const supersededArm = arms.find((a) => a.stale_code === SUPERSEDED_CODE);
      const supersededConfirm = mine.some((a) => a.action === "sshguard-confirm:v1" && a.stale_code === SUPERSEDED_CODE);
      const previous = node.previousPorts?.length ? { previous_honoured: true as const } : {};
      // One host in the fixture was hardened without knocking, so the "there
      // is no sequence" copy has somewhere to render.
      const noKnock = node.name === NO_KNOCK_NODE;
      if (!arms.length) {
        return {
          ok: true, node_id, knowledge: "unknown" as const, revealable: false,
          requires_step_up: true, interactive_only: true,
          note: "The control plane has no SSH Guard plan for this node, so it does not know a knock sequence. If this node knocks, it was configured outside Lattice and the sequence is only wherever that was recorded.",
        };
      }
      if (noKnock) {
        return {
          ok: true, node_id, knowledge: "no_knock" as const, revealable: false,
          requires_step_up: true, interactive_only: true, approval_id: arms[arms.length - 1]!.id,
          note: "SSH Guard is set up on this node without port knocking. There is no sequence to show; reach SSH from a management source.",
        };
      }
      if (!applied && supersededArm && supersededConfirm) {
        return {
          ok: true, node_id, knowledge: "installed_superseded" as const, revealable: true,
          requires_step_up: true, interactive_only: true, approval_id: supersededArm.id, confirmed: false,
          port_count: 3, seq_timeout_sec: 15, open_for: "12h", ssh_port: planSshPort(supersededArm), ...previous,
          note: "The control plane knows this node's knock sequence from an arm record that was later dismissed as superseded. The dismissal retired the record, not the change: the arm and a confirm after it were both approved and dispatched before apply results were recorded on approvals, so neither outcome was written back. No later plan has replaced the knock since. Treat this as the sequence the node was last told to run, and prove it with a knock before relying on it.",
        };
      }
      // A rejected or dismissed arm governs nothing: its sequence was never
      // written to the node. Only an arm still awaiting a decision is planned.
      const live = arms.filter((a) => a.status === "pending" || a.status === "approved");
      if (!applied && !live.length) {
        return {
          ok: true, node_id, knowledge: "unknown" as const, revealable: false,
          requires_step_up: true, interactive_only: true,
          note: "Every SSH Guard plan for this node was rejected or dismissed, so none of their sequences ever reached it. The control plane knows no sequence that opens this node.",
        };
      }
      if (!applied) {
        return {
          ok: true, node_id, knowledge: "planned" as const, revealable: true,
          requires_step_up: true, interactive_only: true, approval_id: live[live.length - 1]!.id,
          port_count: 3, seq_timeout_sec: 15, open_for: "12h", ssh_port: planSshPort(live[live.length - 1]),
          note: "An SSH Guard plan for this node carries a knock sequence, but it has not been applied. The node is not knocking on it yet.",
        };
      }
      return {
        ok: true, node_id, knowledge: "installed" as const, revealable: true,
        requires_step_up: true, interactive_only: true, approval_id: applied.id,
        applied_at: applied.updated_at, confirmed,
        port_count: 3, seq_timeout_sec: 15, open_for: "12h", ssh_port: planSshPort(applied),
        ...(confirmed ? {} : previous),
        note: confirmed
          ? "The control plane knows this node's knock sequence. It was applied and confirmed, so it is the sequence the node is running."
          : "The control plane knows the knock sequence from the arm that was applied. That arm was never confirmed, so its automatic revert may have removed it from the node since.",
      };
    },
    revealKnock: async (node_id: string, step_up_grant: string) => {
      await delay(undefined);
      if (!step_up_grant) throw new ApiError(403, "forbidden", "second-factor step-up required");
      const node = state.nodes.find((n) => n.id === node_id);
      if (!node) throw new ApiError(404, "not_found", "node not found");
      if (node.name === NO_KNOCK_NODE) {
        throw new ApiError(404, "not_found", "SSH Guard is applied on this node without port knocking, so there is no sequence");
      }
      const ports = knockPorts(node.id);
      const addr = node.publicIp;
      const stateNow: SSHGuardKnockStateResponse = await api.sshGuard.knockState(node_id);
      const digest = knockDigest(node.id);
      const sshPort = stateNow.ssh_port ?? 58394;
      return {
        ok: true, node_id, knowledge: stateNow.knowledge, approval_id: stateNow.approval_id ?? fixtureId("apr"),
        note: stateNow.note, confirmed: stateNow.confirmed ?? false,
        ports, seq_timeout_sec: 15, open_for: "12h", ssh_port: sshPort, address: addr,
        command: `for p in ${ports.join(" ")}; do printf k | nc -u -w1 ${addr} $p; sleep 1; done\nssh -p ${sshPort} root@${addr}`,
        sequence_sha256: digest,
        ...(stateNow.previous_honoured && node.previousPorts ? { previous_ports: node.previousPorts } : {}),
      };
    },
  },
  // Everything else: a loud failure, never a silent empty list.
  capabilities: unimplemented,
  plugins: unimplemented,
  audit: unimplemented,
};
