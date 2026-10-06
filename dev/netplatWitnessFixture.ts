/**
 * Control-plane witness fixtures for the netplat harness
 * (dev/netplat-notifications.html): GET /api/notify/witness as the console
 * reads it, and the plan endpoint.
 *
 * The default is the state right after the agent prerelease with witness mode
 * reaches the service node: no witness configured, one node that could run
 * one. `?witness=` picks another state:
 *
 *   none       no witness, one capable node (default)
 *   nocapable  no witness and no node whose agent has witness mode
 *   nourl      the server has no public URL, so there is nothing to watch
 *   pending    a configure plan waits for approval
 *   watching   applied, watching, the last recovery push accepted
 *   override   applied and watching a URL the operator set (a CDN-proxied name)
 *   failing    the control plane has not answered for three checks
 *   down       the witness pushed the unreachable alert
 *   network    the node's own network is down
 *   stale      the agent stopped relaying the status 20 minutes ago
 *   stopped    the agent still relays, but the witness stopped checking 14 minutes ago
 *   never      applied, but no status has ever arrived
 *   pushfail   watching, but its last push was not accepted
 *   differs    the node runs a config other than the last applied one
 *   failed     the last plan's task failed
 *   ?fail=witness  the read answers 502
 */
import type { ApprovalView, WitnessNodeView, WitnessPlanRequest, WitnessReport, WitnessStatusResponse } from "@/lib/api/index";

import { HOUR, MINUTE, flags, iso } from "./netplatFixture";

const NODE_ID = "node_pulse_nano";
const NODE_NAME = "[cd]-gomami-jpn-pulse-nano";
const SHA = "5cf6a9092bf77ef14b5cf503ff412e41982a54105b074dda8dc7eb3da285d63e";
const PUBLIC_READYZ = "https://lattice.example.org/readyz";
const PROXIED_READYZ = "https://lattice-ready.example.org/readyz";

const applied = {
  approval_id: "approval_witness_applied",
  action: "configure",
  status: "applied",
  config_sha256: SHA,
  channel_id: "ch_bark_urgent",
  channel_name: "Bark urgent",
  key_sha256_prefix: "41b88fb74e0a",
  created_at: iso(-3 * HOUR),
  updated_at: iso(-3 * HOUR + 2 * MINUTE),
  health_url: PUBLIC_READYZ,
};

function report(over: Partial<WitnessReport> = {}): WitnessReport {
  return {
    version: 1,
    config_sha256: SHA,
    started_at: iso(-3 * HOUR),
    phase: "watching",
    health_url: PUBLIC_READYZ,
    reference_count: 2,
    interval_seconds: 30,
    hold_seconds: 180,
    last_check_at: iso(-12_000),
    last_check_ok: true,
    last_ok_at: iso(-12_000),
    alerted: false,
    last_push_at: iso(-2 * HOUR),
    last_push_kind: "recovery",
    last_push_ok: true,
    pushes: 4,
    ...over,
  };
}

function node(over: Partial<WitnessNodeView> = {}): WitnessNodeView {
  return {
    node_id: NODE_ID,
    node_name: NODE_NAME,
    capable: true,
    configured: applied,
    report: report(),
    reported_at: iso(-10_000),
    report_fresh: true,
    check_stale: false,
    config_matches: true,
    ...over,
  };
}

const mode = flags.get("witness") ?? "none";

function nodesFor(): WitnessNodeView[] {
  switch (mode) {
    case "pending":
      return [node({ configured: undefined, report: undefined, report_fresh: false, config_matches: false, pending: { ...applied, approval_id: "approval_witness_pending", status: "pending", created_at: iso(-4 * MINUTE) } })];
    case "watching":
      return [node()];
    case "override":
      return [node({ configured: { ...applied, health_url: PROXIED_READYZ }, report: report({ health_url: PROXIED_READYZ }) })];
    case "failing":
      return [node({ report: report({ phase: "failing", last_check_ok: false, last_check_detail: "http 502", failing_since: iso(-95_000), consecutive_failures: 3, last_ok_at: iso(-125_000) }) })];
    case "down":
      return [node({ report: report({ phase: "down", last_check_ok: false, last_check_detail: "timeout", failing_since: iso(-9 * MINUTE), down_since: iso(-9 * MINUTE), consecutive_failures: 18, alerted: true, alerted_at: iso(-6 * MINUTE), last_push_at: iso(-6 * MINUTE), last_push_kind: "down", pushes: 5 }) })];
    case "network":
      return [node({ report: report({ phase: "network_down", last_check_ok: false, last_check_detail: "dns", network_down_since: iso(-3 * MINUTE) }) })];
    case "stale":
      return [node({ reported_at: iso(-20 * MINUTE), report_fresh: false, report: report({ last_check_at: iso(-20 * MINUTE) }) })];
    case "stopped":
      return [node({ check_stale: true, report: report({ last_check_at: iso(-14 * MINUTE), last_ok_at: iso(-14 * MINUTE), relayed_at: iso(-10_000) }) })];
    case "never":
      return [node({ report: undefined, reported_at: undefined, report_fresh: false, config_matches: false })];
    case "pushfail":
      return [node({ report: report({ last_push_at: iso(-40 * MINUTE), last_push_kind: "down", last_push_ok: false, last_push_error: "http 400" }) })];
    case "differs":
      return [node({ config_matches: false, report: report({ config_sha256: "9".repeat(64) }) })];
    case "failed":
      return [node({ configured: undefined, report: undefined, report_fresh: false, config_matches: false, last_failed: { ...applied, approval_id: "approval_witness_failed", status: "rejected", reason: "exit_code=1 stderr=lattice witness: this agent has no witness mode; update the agent first", created_at: iso(-30 * MINUTE) } })];
    default:
      return [];
  }
}

const state: WitnessStatusResponse = {
  health_url: mode === "nourl" ? undefined : PUBLIC_READYZ,
  health_url_error: mode === "nourl" ? "this server has no public URL (LATTICE_PUBLIC_URL)" : undefined,
  nodes: nodesFor(),
  capable_nodes: mode === "nocapable" ? [] : [{ node_id: NODE_ID, node_name: NODE_NAME, online: true }],
  defaults: {
    reference_urls: ["https://www.cloudflare.com/cdn-cgi/trace", "https://www.apple.com/library/test/success.html"],
    interval_seconds: 30,
    hold_seconds: 180,
    recover_seconds: 60,
    bark_level: "critical",
    bark_levels: ["active", "timeSensitive", "passive", "critical"],
    key_file: "/etc/lattice-witness/bark-device-key",
    config_file: "/etc/lattice-witness/witness.json",
    unit: "lattice-witness.service",
  },
};

export function witnessStatus(): WitnessStatusResponse {
  return JSON.parse(JSON.stringify(state)) as WitnessStatusResponse;
}

let seq = 1;

/** As the server: a configure or remove plan, pending, and the status shows it waiting. */
export function planWitness(input: WitnessPlanRequest): { approval: ApprovalView } {
  const id = `approval_witness_new_${seq++}`;
  const remove = !!input.remove;
  const view = {
    approval_id: id,
    action: remove ? "remove" : "configure",
    status: "pending",
    channel_id: input.channel_id,
    channel_name: input.channel_id === "ch_bark_urgent" ? "Bark urgent" : input.channel_id,
    created_at: iso(0),
    health_url: remove ? undefined : (input.health_url ?? state.health_url),
  };
  const existing = state.nodes.find((n) => n.node_id === input.node_id);
  if (existing) existing.pending = view;
  else state.nodes.push({ node_id: input.node_id, node_name: NODE_NAME, capable: true, pending: view, report_fresh: false, check_stale: false, config_matches: false });
  return {
    approval: {
      id,
      node_id: input.node_id,
      plugin: "controlplane-witness",
      action: remove ? "witness-remove:v1" : "witness-configure:v1",
      status: "pending",
      created_at: iso(0),
    } as unknown as ApprovalView,
  };
}
