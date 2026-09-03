// Server model views (secret-free) faithful to lattice-server. Expanded
// per-domain as screens are built; this covers identity, fleet, safe-ops.

import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@/lib/webauthn";

export interface Principal {
  actor_id: string;
  username?: string;
  token_id?: string;
  scopes: string[];
  server_allowlist: string[];
  csrf_token: string;
  totp_enabled?: boolean;
  mfa_required?: boolean;
  totp_policy_required?: boolean;
}

export interface BuildInfo {
  server_version: string;
  server_commit: string;
  server_date: string;
  dashboard_ref?: string;
  dashboard_built?: string;
  task_execution_disabled?: boolean;
}

export interface LoginResponse {
  csrf_token?: string;
  actor_id?: string;
  totp_required?: boolean;
  challenge_id?: string;
  mfa_required?: boolean;
  totp_policy_required?: boolean;
}

export interface TOTPEnrollResponse {
  secret: string;
  otpauth_uri: string;
  recovery_codes: string[];
}

/** A registered passkey, secret-free (public key stays server-side). */
export interface WebAuthnCredentialView {
  id: string;
  name: string;
  created_at: string;
  last_used_at?: string;
  backed_up: boolean;
  transports?: string[];
  aaguid?: string;
}

export interface WebAuthnRegisterBeginResponse {
  challenge_id: string;
  publicKey: PublicKeyCredentialCreationOptionsJSON;
}

export interface WebAuthnLoginBeginResponse {
  challenge_id: string;
  publicKey: PublicKeyCredentialRequestOptionsJSON;
}

export interface WebAuthnCredentialResponse {
  credential: WebAuthnCredentialView;
}

export interface WebAuthnCredentialsResponse {
  credentials: WebAuthnCredentialView[];
}

export interface SSOProvider {
  id: string;
  display_name: string;
}

export interface Metrics {
  cpu_percent?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  memory_total?: number;
  memory_used?: number;
  disk_total?: number;
  disk_used?: number;
  net_rx_bytes?: number;
  net_tx_bytes?: number;
  net_rx_speed?: number;
  net_tx_speed?: number;
  uptime_seconds?: number;
  collected_at?: string;
}

export interface HostFacts {
  hostname?: string;
  os?: string;
  platform?: string;
  platform_version?: string;
  kernel_version?: string;
  kernel?: string;
  arch?: string;
  cpu_cores?: number;
  cpu_model?: string;
  memory_total?: number;
  swap_total?: number;
  virtualization?: string;
  boot_time?: string;
}

export interface NodeGeo {
  country?: string;
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
  ip?: string;
  asn?: number;
  as_org?: string;
  provider?: string;
  source?: "operator" | "auto" | string;
  updated_at?: string;
}

// NodeInventory mirrors the operator-registered provenance/quality metadata on
// the node model. E.g. "98% pure, high quality" IP purity notes kept in the
// fleet inventory. Purely informational; nothing branches on it.
export interface NodeInventory {
  purity_percent?: number;
  quality?: string;
  notes?: string;
}

export interface AgentDebugPolicy {
  enabled: boolean;
  collect: boolean;
  updated_at?: string;
}

export interface AgentLaunchConfig {
  allow_exec?: boolean;
  allow_root_exec?: boolean;
  no_exec?: boolean;
  allow_terminal?: boolean;
  terminal_transport?: "poll" | "stream" | string;
  ssh_alerts?: boolean;
  singbox_discover?: boolean;
  singbox_bin?: string;
  updated_at?: string;
}

/**
 * One enrolment decision: may this capability act on this node.
 *
 * Three states, and the third one carries its weight. No record means nobody
 * has decided, and the capability's own default applies. "excluded" means
 * somebody looked and said no, and `reason` is why - a NAT box with no exposed
 * port is not waiting its turn, it is deliberately out until port forwarding
 * exists. `enforced` says whether the decision currently bites, so a capability
 * that is declared but not yet live cannot be mistaken for a guarantee.
 */
/** One declared capability. `enforced` says whether a decision about it
 *  currently bites; `mutates` is why it is opt-in (it changes the machine). */
export interface KnownCapability {
  id: string;
  enforced: boolean;
  mutates: boolean;
}

/**
 * One capability's effective answer for one node: what the gate would decide
 * right now, and where that answer came from.
 *
 * `source` matters. A node can be allowed with no explicit record at all,
 * because its own older configuration already says so - a machine with sing-box
 * discovery switched on is in scope for sing-box management without anyone
 * enrolling it. Showing that as "not decided" would read as blocked.
 */
/**
 * One capability's gate, and what it would do to this fleet.
 *
 * `allow_count` / `refuse_count` are resolved as if the gate were live, whether
 * or not it is. Enforcing a capability that cannot derive an answer refuses
 * every node with no explicit enrolment, which on a fresh table is the whole
 * fleet, so the number has to be visible before the switch rather than
 * discovered after it.
 */
export interface CapabilityImpact {
  capability: string;
  enforced: boolean;
  mutates: boolean;
  derived: boolean;
  allow_count: number;
  refuse_count: number;
  refused?: Array<{ node_id: string; name?: string; reason?: string }>;
}

export interface NodeCapabilityEffective {
  capability: string;
  enforced: boolean;
  mutates: boolean;
  allowed: boolean;
  source: "record" | "derived" | "default";
  reason?: string;
  state?: "enrolled" | "excluded";
  record_reason?: string;
  actor_id?: string;
  updated_at?: string;
}

export interface NodeCapability {
  node_id: string;
  capability: string;
  state: "enrolled" | "excluded";
  reason?: string;
  actor_id?: string;
  updated_at: string;
  enforced: boolean;
}

export interface AgentRuntimeConfig {
  allow_exec?: boolean;
  allow_root_exec?: boolean;
  no_exec?: boolean;
  allow_terminal?: boolean;
  terminal_transport?: "poll" | "stream" | string;
  task_sandbox?: string;
  task_sandbox_features?: string[];
  task_sandbox_warning?: string;
  ssh_alerts?: boolean;
  singbox_discover?: boolean;
  singbox_bin?: string;
  reported_at?: string;
}

/** The node status vocabulary the control plane derives; see `Node.status`. */
export type NodeStatus = "never_reported" | "online" | "degraded" | "offline" | "disabled";

export interface Node {
  id: string;
  lattice_identity_uuid?: string;
  name: string;
  comment?: string;
  tags?: string[];
  role?: string;
  inventory?: NodeInventory | null;
  public_ip?: string;
  public_ipv6?: string;
  internal_ip?: string;
  internal_ipv6?: string;
  agent_version?: string;
  online: boolean;
  /**
   * What the control plane actually knows about contact: "online" | "offline"
   * | "never". `online` cannot express the last one, so a node that has never
   * reported is indistinguishable from one that died. Derive display state
   * through `nodeHealth` in `@/lib/status` rather than reading either directly.
   */
  reachability?: "online" | "offline" | "never";
  /**
   * The one word the control plane derives for this node (lattice-server
   * node_status.go): never_reported, online, degraded, offline, disabled.
   * Every renderer reads it through `@/lib/nodeStatus`; `online` and
   * `reachability` stay for older servers and say less, never otherwise.
   */
  status?: NodeStatus;
  /** When the node entered `status`; absent when the server does not know. */
  status_since?: string;
  /** One sentence naming the evidence behind `status`. */
  status_reason?: string;
  disabled?: boolean;
  agent_source_allowlist?: string[];
  token_last_used_at?: string;
  last_seen?: string;
  metrics?: Metrics;
  host_facts?: HostFacts;
  geo?: NodeGeo;
  agent_debug?: AgentDebugPolicy;
  agent_launch?: AgentLaunchConfig | null;
  agent_runtime?: AgentRuntimeConfig | null;
  ip_config?: NodeIPConfig | null;
  group_ids?: string[];
}

// NodeDeletePlanView mirrors the server's nodeDeleteSummary wire DTO returned by
// both POST /api/nodes/delete/plan (mutated=false, a dry-run preview) and
// POST /api/nodes/delete (mutated=true, the applied cascade). Every count is the
// number of dependent records the hard-delete touched (stripped or removed).
export interface NodeDeletePlanView {
  node_id: string;
  node_name: string;
  found: boolean;
  mutated: boolean;
  tasks_stripped: number;
  tasks_deleted: number;
  task_results: number;
  ddns_profiles: number;
  machine_profiles: number;
  nft_inputs: number;
  dns_deployments: number;
  net_policies: number;
  net_peer_rules_stripped: number;
  group_policy_rules_stripped: number;
  geo_routing_stripped: number;
  geo_routing_deleted: number;
  agent_update_policies: number;
  proxy_node_profiles: number;
  proxy_usage_snapshots: number;
  monitors_stripped: number;
  monitor_results: number;
  log_sources: number;
  groups: number;
  approvals: number;
  tunnels: number;
  guard_reality_snapshots: number;
  guard_bindings: number;
  managed_lines: number;
  line_chain_attempts_released: number;
  line_chain_definitions_deleted: number;
  line_chain_targets_drifted: number;
  line_chain_lease_conflicts: number;
  terminal_sessions: number;
  proxy_drift_cleared: number;
  log_store_purged: number;
  log_store_purge_errs: number;
}

// NodeIPConfig is the operator-owned, per-node override for how the agent
// determines its public IPs. An empty/absent mode means "no override".
export interface NodeIPConfig {
  mode?: "" | "auto" | "static" | "resolver" | "script";
  static_ipv4?: string;
  static_ipv6?: string;
  resolvers?: string[];
  script?: string;
  script_sha256?: string;
  updated_at?: string;
}

export interface NodeGeoView {
  id: string;
  name: string;
  tags?: string[];
  role?: string;
  online: boolean;
  /** The same derived status the node view carries; see `Node.status`. */
  status?: NodeStatus;
  status_since?: string;
  status_reason?: string;
  disabled?: boolean;
  public_ip?: string;
  public_ipv6?: string;
  internal_ip?: string;
  internal_ipv6?: string;
  wireguard_ip?: string;
  host_facts?: HostFacts;
  agent_runtime?: AgentRuntimeConfig | null;
  geo?: NodeGeo;
}

export interface NodeGeoInput {
  country?: string;
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
  asn?: number;
  as_org?: string;
  provider?: string;
}

export interface NodeGeoResolveResult {
  node_id: string;
  ip?: string;
  status: "updated" | "skipped_existing" | "no_public_ip" | "resolver_disabled" | "lookup_failed" | "store_failed" | "not_found" | string;
  message?: string;
  node?: NodeGeoView;
  geo?: NodeGeo;
}

export interface NodeGeoResolveResponse {
  results: NodeGeoResolveResult[];
}

export interface EnrollTokenResponse {
  node_id: string;
  token: string;
  server_url: string;
  command: string;
  commands?: Record<string, string>;
  agent_launch?: AgentLaunchConfig;
}

export interface TaskView {
  id: string;
  actor_id?: string;
  token_id?: string;
  approval_id?: string;
  targets: string[];
  interpreter: string;
  script_sha256?: string;
  script_size_bytes?: number;
  timeout_sec?: number;
  output_limit?: number;
  // "expired" is derived by the server: the queue deadline passed, so the
  // task was withdrawn and will not be handed to its agent. Distinct from
  // "failed" on purpose - an offline node is not a script that went wrong.
  status: "queued" | "leased" | "finished" | "failed" | "cancelled" | "expired" | "stalled";
  leased_by?: string;
  rerun_of_task_id?: string;
  rerun_of_node_id?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  // Lease progress, sent only for leased tasks by servers that count
  // attempts. The three scalars summarise a single-target task; target_states
  // carries the same per node for a fan-out. All optional so an older server
  // renders exactly as before.
  attempts?: number;
  max_attempts?: number;
  lease_age_seconds?: number;
  stalled_reason?: string;
  target_states?: Record<string, TaskTargetStateView>;
}

export interface TaskTargetStateView {
  status: "queued" | "leased" | "finished" | "failed" | "stalled";
  attempts?: number;
  max_attempts?: number;
  lease_age_seconds?: number;
  stalled_reason?: string;
}

export interface TaskScriptRevealResponse {
  ok: boolean;
  id: string;
  interpreter: string;
  script: string;
  script_sha256?: string;
  script_size_bytes?: number;
}

export interface TaskResult {
  /** Present on omit_output rows: the size of the body that was not sent. */
  stdout_bytes?: number;
  stderr_bytes?: number;
  task_id: string;
  lease_id?: string;
  node_id: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;

  /**
   * How the agent was configured when this result was recorded, pinned by the
   * server at that moment. Absent for results predating the pin, and for nodes
   * that had never reported a posture - absence means unknown, not "root".
   */
  exec_context?: {
    sandbox?: string;
    non_root?: boolean;
    root_exec?: boolean;
    exec_disabled?: boolean;
    reported_at?: string;
  };
}

export interface TerminalSession {
  id: string;
  node_id: string;
  actor_id?: string;
  token_id?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  status: "pending" | "open" | "closed" | "failed" | string;
  error?: string;
  bytes_in?: number;
  bytes_out?: number;
  created_at: string;
  opened_at?: string;
  closed_at?: string;
  last_seen?: string;
}

export interface TerminalEvent {
  seq: number;
  kind: "output" | string;
  data?: string;
  created_at: string;
}

export interface TerminalEventsResponse {
  session: TerminalSession;
  events: TerminalEvent[];
}

export type ApprovalStatus = "pending" | "approved" | "applied" | "rejected" | "dismissed" | "failed";

/**
 * Why an approved approval has not applied.
 *
 * The control plane derives this (lattice-server, server_approval_waiting.go)
 * and sends it only on approvals whose status is "approved"; every other
 * status already says what it is. The console cannot work it out for itself:
 * whether an apply task was ever queued is not on this wire at all, the node's
 * contact state lives behind another endpoint, and the capability gate and the
 * fleet kill switch have no client-visible projection. A wrong guess here is
 * worse than no explanation, so the server answers.
 *
 * `code` is an open set. A console that meets a code it does not know still
 * renders `reason`, which is the sentence the server wrote.
 */
export interface ApprovalWaitingView {
  code: string;
  /** One sentence in terms of the world: which machine, since when, which task. */
  reason: string;
  /** False for the two states that clear themselves: queued, and running now. */
  blocked: boolean;
  node_id?: string;
  node_name?: string;
  /** The same word the Nodes page shows for this machine. */
  node_status?: NodeStatus;
  node_status_since?: string;
  node_status_reason?: string;
  task_id?: string;
  task_status?: string;
  superseded_by?: string;
  /** The dismiss endpoint accepts this approval as it stands. */
  dismissible?: boolean;
}

export interface ApprovalView {
  id: string;
  node_id: string;
  plugin: string;
  action: string;
  plan: string;
  status: ApprovalStatus;
  reason?: string;
  stale?: boolean;
  stale_code?: string;
  actor_id?: string;
  approved_by?: string;
  created_at?: string;
  updated_at?: string;
  /** Present only while status is "approved". See ApprovalWaitingView. */
  waiting?: ApprovalWaitingView;
}

/**
 * A lint result from a plan pre-check. `block` refuses the plan unless the
 * operator explicitly accepts the risk, which the server audits.
 *
 * Shared by every surface that commits the node's single lattice_guard input
 * chain: SSH Guard, Network Guard, and Self-host DNS all compose the same
 * default-drop ruleset and so carry the same lockout risk.
 */
export interface GuardLintFinding {
  code: string;
  severity: "block" | "warn" | string;
  message: string;
}

/** @deprecated Use GuardLintFinding; the findings are not SSH-specific. */
export type SSHGuardFinding = GuardLintFinding;

/**
 * Fields the caller omits keep the server's verified defaults, so an ordinary
 * host needs only node_id and ssh_port.
 */
export interface SSHGuardPlanRequest {
  node_id: string;
  ssh_port?: number;
  keep_legacy_port?: boolean;
  mgmt_sources?: string[];
  enable_knock?: boolean;
  out_of_band_fallback?: boolean;
  confirm_window_sec?: number;
  accept_findings?: boolean;
  // Advanced. Each one overrides a verified default on the server rather than
  // merging with it, and each is omitted unless the operator set it.
  gate_ports?: number[];
  knock_ports?: number[];
  /** An nftables timeout literal the server accepts: 15m, 30m, 1h ... 24h. */
  knock_open_for?: string;
  knock_seq_timeout_sec?: number;
  login_grace_time_sec?: number;
  max_auth_tries?: number;
  /** sshd's own "start:rate:full" triple, or a bare "start". */
  max_startups?: string;
  permit_root_login?: string;
}

/**
 * A Self-host DNS plan carries its lint findings alongside the approval, for
 * the same reason SSH Guard does: the plan replaces the node's whole
 * default-drop input chain, so the reviewer has to see what it would cut off.
 */
export interface DNSPlanResponse {
  approval: ApprovalView;
  findings?: GuardLintFinding[];
}

export interface SSHGuardPlanResponse {
  approval: ApprovalView;
  findings?: SSHGuardFinding[];
}

// ── guard reality ───────────────────────────────────────────────────────────
//
// What a node reports about its own firewall and listeners. The agent posts
// it; the server keeps the newest snapshot per node and serves it in two
// shapes: a fleet summary (counts and timestamps, one call) and a per-node
// detail carrying the listeners themselves. SSH Guard reads both: the summary
// says when a node was last observed, the detail says what sshd listens on.

export interface GuardListener {
  /** tcp | udp */
  protocol: string;
  port: number;
  address?: string;
  process?: string;
}

export interface GuardInterface {
  name: string;
  addresses?: string[];
}

export interface GuardNodeReality {
  node_id: string;
  listeners?: GuardListener[];
  interfaces?: GuardInterface[];
  managed_sha?: string;
  foreign_tables?: string[];
  nft_version?: string;
  collected_at: string;
}

/** One row of GET /api/netguard/reality. Timestamps are absent until the node has reported. */
export interface GuardRealitySummary {
  node_id: string;
  node_name?: string;
  /** unknown (never reported) | fresh | stale */
  snapshot_status: "unknown" | "fresh" | "stale" | string;
  /** unknown | in_sync | drift */
  drift_state: string;
  managed: boolean;
  has_binding: boolean;
  collected_at?: string;
  received_at?: string;
  stale_after?: string;
  managed_sha?: string;
  applied_table_sha?: string;
  last_applied_at?: string;
  last_error?: string;
  listener_count?: number;
  interface_count?: number;
  foreign_table_count?: number;
}

export interface GuardRealityListResponse {
  nodes: GuardRealitySummary[];
  next_cursor?: string;
}

/** GET /api/netguard/reality?node_id=: the snapshot itself, or nulls when the node never reported. */
export interface GuardRealityDetail {
  node_id: string;
  snapshot_status: "unknown" | "fresh" | "stale" | string;
  reality: GuardNodeReality | null;
  received_at: string | null;
  stale_after: string | null;
}

export interface GuardRealityDetailResponse {
  node: GuardRealityDetail;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor_id?: string;
  token_id?: string;
  node_id?: string;
  action: string;
  scope?: string;
  decision: "allow" | "deny" | "observe" | string;
  reason?: string;
  correlation_id?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditQueryResponse {
  events: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuditAnchorCheckpoint {
  count: number;
  head: string;
}

export interface AuditVerifyResponse {
  enabled: boolean;
  ok?: boolean;
  count?: number;
  head?: string;
  anchored?: boolean;
  anchor_count?: number;
  anchor_head?: string;
  anchor_pending?: AuditAnchorCheckpoint;
  error?: string;
}

export interface MonitorView {
  id: string;
  name: string;
  type: "tcp" | "http" | string;
  target: string;
  interval_sec: number;
  timeout_sec: number;
  assign_all?: boolean;
  node_ids?: string[];
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface MonitorResult {
  monitor_id: string;
  node_id: string;
  at: string;
  success: boolean;
  latency_ms?: number;
  error?: string;
}

export interface MonitorCreateInput {
  name: string;
  type: "tcp" | "http";
  target: string;
  interval_sec?: number;
  timeout_sec?: number;
  assign_all?: boolean;
  node_ids?: string[];
}

export type RenewalCycle = "" | "monthly" | "quarterly" | "semiannual" | "annual" | "custom_days";

export interface MachineView {
  id?: string;
  node_id: string;
  node_name?: string;
  label?: string;
  online: boolean;
  host_facts?: HostFacts;
  vendor?: string;
  vendor_profile?: MachineVendorView;
  region?: string;
  has_console_url?: boolean;
  has_detail_url?: boolean;
  notes?: string;
  price_cents?: number;
  currency?: string;
  purchased_at?: string;
  renewal_cycle?: RenewalCycle | string;
  cycle_days?: number;
  next_renewal?: string;
  days_until_renewal?: number;
  auto_roll?: boolean;
  remind_days_before?: number[];
  reminders_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface MachineVendorView {
  id: string;
  name: string;
  url?: string;
  logo_url?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export interface MachineProfileInput {
  id?: string;
  node_id: string;
  label?: string;
  vendor?: string;
  console_url?: string;
  detail_url?: string;
  clear_console_url?: boolean;
  clear_detail_url?: boolean;
  region?: string;
  notes?: string;
  price_cents?: number;
  currency?: string;
  purchased_at?: string | null;
  renewal_cycle?: RenewalCycle | string;
  cycle_days?: number;
  next_renewal?: string | null;
  auto_roll?: boolean;
  remind_days_before?: number[];
  reminders_enabled?: boolean;
}

export interface MachineVendorInput {
  id?: string;
  name: string;
  url?: string;
  logo_url?: string;
  description?: string;
}

export interface MachineLinkRevealResponse {
  ok: boolean;
  id: string;
  kind: "console" | "detail";
  url: string;
}

export interface RenewalReminderFire {
  machine_id: string;
  node_id: string;
  node_name?: string;
  offset_days: number;
  next_renewal: string;
}

export interface StepUpResponse {
  ok: boolean;
  grant: string;
  expires_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────────────────────
// Networking: Network Guard (nft), Network Policy (+graph), Self-host DNS,
// Geo-Routing, DDNS, Tunnels, WireGuard. Most mutations go through plan→approve.
// ─────────────────────────────────────────────────────────────────────────────

export type NetRuleAction = "allow" | "deny";
export type NetRuleDirection = "egress" | "ingress";
export type NetRuleProtocol = "tcp" | "udp" | "any";
export type NetEndpointKind = "node" | "cidr" | "domain" | "any" | "group" | "zone";

export interface NetEndpoint {
  kind: NetEndpointKind;
  node_id?: string;
  cidr?: string;
  domain?: string;
  group_id?: string;
  zone_id?: string;
}

export interface NetRule {
  id: string;
  comment?: string;
  action: NetRuleAction;
  direction: NetRuleDirection;
  protocol: NetRuleProtocol;
  ports?: number[];
  remote: NetEndpoint;
  disabled?: boolean;
}

export interface NetPolicyView {
  id: string;
  target_node_id: string;
  target_node_name?: string;
  rules: NetRule[];
  enabled: boolean;
  last_plan_sha?: string;
  last_applied_at?: string;
  last_error?: string;
  updated_at: string;
}

export interface NetPolicyUpsertRequest {
  id?: string;
  target_node_id: string;
  rules: NetRule[];
  enabled: boolean;
}

// --- Grouping (iter-063) ---

export interface GroupSelector {
  match_tags_any?: string[];
  match_roles?: string[];
  match_country?: string[];
  match_continent?: string[];
}

export interface Group {
  id: string;
  name: string;
  slug: string;
  description?: string;
  color: string;
  icon?: string;
  parent_id?: string;
  order: number;
  members?: string[];
  selector?: GroupSelector | null;
  /** Operator-designated leader; must be an explicit member (server-validated). */
  leader_id?: string;
  system?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface GroupRollup {
  total: number;
  online: number;
  offline: number;
  disabled: number;
}

export interface GroupView extends Group {
  resolved_members: string[];
  rollup: GroupRollup;
}

export interface GroupsListResponse {
  groups: GroupView[];
  ungrouped: { resolved_members: string[]; rollup: GroupRollup };
}

export interface GroupUpsertRequest {
  id?: string;
  name: string;
  slug: string;
  description?: string;
  color?: string;
  icon?: string;
  parent_id?: string;
  order?: number;
  members?: string[];
  selector?: GroupSelector | null;
  /** Group leader node id; must be one of `members` (server rejects otherwise). */
  leader_id?: string;
}

export interface GroupNetRule {
  id: string;
  comment?: string;
  action: NetRuleAction;
  direction: NetRuleDirection;
  protocol: NetRuleProtocol;
  ports?: number[];
  remote: NetEndpoint;
  disabled?: boolean;
}

export interface GroupNetPolicy {
  id: string;
  scope_group_id: string;
  rules: GroupNetRule[];
  enabled: boolean;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

export interface GroupPolicyView extends GroupNetPolicy {
  scope_group_name?: string;
  group_rule_count: number;
}

export interface GroupPolicyUpsertRequest {
  id?: string;
  scope_group_id: string;
  rules: GroupNetRule[];
  enabled: boolean;
  priority: number;
}

export interface GroupPolicyPlanResult {
  affected: { node_id: string; approval_id: string; plan_sha: string }[];
  conflicts: { node_id: string; reason: string }[];
  orphaned: string[];
  selector_impacts?: {
    group_id: string;
    group_name: string;
    uses: string[];
    policy_ids: string[];
    selector?: GroupSelector;
    explicit_member_ids: string[];
    selector_member_ids: string[];
    resolved_member_ids: string[];
  }[];
}

export interface MatrixGroup {
  id: string;
  name: string;
  slug: string;
  color: string;
}

export interface MatrixCell {
  from: string;
  to: string;
  action: "allow" | "deny";
  protocols?: string[];
  ports?: number[];
  rule_count: number;
  mixed: boolean;
}

export interface NetPolicyMatrix {
  direction: "egress" | "ingress";
  groups: MatrixGroup[];
  cells: MatrixCell[];
  external: { from: string; rule_count: number }[];
}

export interface NetGraphNode {
  id: string;
  name: string;
  online: boolean;
  geo?: NodeGeo;
}

export interface NetGraphEdge {
  from: string;
  to: string;
  action: string;
  protocol: string;
  ports?: number[];
  direction: string;
  rule_id: string;
}

export interface NetGraphExternal {
  target_node_id: string;
  action: string;
  remote: string;
  protocol: string;
  ports?: number[];
  direction: string;
  rule_id: string;
}

export interface NetPolicyGraph {
  nodes: NetGraphNode[];
  edges: NetGraphEdge[] | null;
  externals: NetGraphExternal[] | null;
}

export type DNSZoneMode = "forward" | "static" | "block";
export type DNSExposure = "mesh" | "public";

export interface DNSRecord {
  name: string;
  type: string;
  value: string;
  ttl?: number;
}

export interface DNSZone {
  suffix: string;
  mode: DNSZoneMode | string;
  upstreams?: string[];
  records?: DNSRecord[];
}

export interface DNSDeploymentView {
  id: string;
  name: string;
  node_id: string;
  node_name?: string;
  engine: string;
  listen_port: number;
  enable_udp: boolean;
  enable_tcp: boolean;
  exposure: DNSExposure | string;
  zones: DNSZone[];
  hostname?: string;
  publish_ipv4: boolean;
  publish_ipv6: boolean;
  record_ttl?: number;
  ddns_profile_id?: string;
  has_credential: boolean;
  status: string;
  engine_version?: string;
  last_ipv4?: string;
  last_ipv6?: string;
  last_applied_at?: string;
  last_error?: string;
  last_published_at?: string;
  last_publish_error?: string;
  disabled?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DNSDeploymentBody {
  id?: string;
  name: string;
  node_id: string;
  engine?: string;
  listen_port?: number;
  enable_udp?: boolean;
  enable_tcp?: boolean;
  exposure?: DNSExposure | string;
  zones: DNSZone[];
  hostname?: string;
  publish_ipv4?: boolean;
  publish_ipv6?: boolean;
  record_ttl?: number;
  cf_api_token?: string;
  ddns_profile_id?: string;
  disabled?: boolean;
}

export interface DNSPublishResponse {
  ok: boolean;
  ipv4: string;
  ipv6: string;
  deployment: DNSDeploymentView;
}

export type GeoRoutingStrategy = "geoip" | "all-healthy";

export interface GeoRouting {
  id: string;
  name: string;
  hostname: string;
  node_ids: string[];
  dns_node_ids: string[];
  ttl?: number;
  strategy: GeoRoutingStrategy | string;
  geoip_db_path?: string;
  publish_ns?: boolean;
  ddns_profile_id?: string;
  last_rendered_sha?: string;
  status?: string;
  last_applied_at?: string;
  last_delegated_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface GeoRoutingUpsertRequest {
  id?: string;
  name: string;
  hostname: string;
  strategy?: GeoRoutingStrategy | string;
  node_ids: string[];
  dns_node_ids: string[];
  ttl?: number;
  geoip_db_path?: string;
  publish_ns?: boolean;
  ddns_profile_id?: string;
}

export interface GeoRoutingPlanView {
  geo_routing_id: string;
  hostname: string;
  strategy: string;
  config: string;
  sha256: string;
  warnings?: string[];
  continent_choice?: Record<string, string>;
}

export type DDNSProvider = "cloudflare" | "webhook";

export interface DDNSView {
  id: string;
  name: string;
  node_id: string;
  provider: DDNSProvider | string;
  domains: string[];
  enable_ipv4: boolean;
  enable_ipv6: boolean;
  max_retries: number;
  ttl: number;
  /** Seconds between attempts for this profile; 0 means the server default. */
  interval_seconds?: number;
  has_credential: boolean;
  webhook_url?: string;
  webhook_method?: string;
  last_ipv4?: string;
  last_ipv6?: string;
  last_run_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface DDNSUpsertRequest {
  /** Present to edit an existing profile; omit to create one. */
  id?: string;
  /** Seconds between attempts; omit for the server default. */
  interval_seconds?: number;
  name: string;
  node_id: string;
  provider: DDNSProvider | string;
  domains: string[];
  enable_ipv4?: boolean;
  enable_ipv6?: boolean;
  max_retries?: number;
  ttl?: number;
  cf_api_token?: string;
  webhook_url?: string;
  webhook_method?: string;
  webhook_body?: string;
  webhook_headers?: string;
}

export interface TunnelIngress {
  hostname: string;
  service: string;
  path?: string;
}

export interface TunnelView {
  id: string;
  name: string;
  node_id: string;
  tunnel_id: string;
  credentials_file?: string;
  ingress: TunnelIngress[];
  created_at: string;
  updated_at: string;
}

export interface TunnelUpsertRequest {
  name: string;
  node_id: string;
  tunnel_id: string;
  credentials_file?: string;
  ingress: TunnelIngress[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform: Plugins, Workers, KV, Static, Logs, Notifications, Agent Updates.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Plugin UI contributions. The host supports generic declarative views and v2
// sandbox bundles; it never imports plugin-specific dashboard components.
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginNavContribution {
  /** Safe section id. "plugins" aliases to the built-in Platform section; unknown ids create plugin sections. */
  section: string;
  /** Optional display label for custom plugin-created sections. */
  section_title?: string;
  title: string;
  /** Route slug; matches ^[a-z0-9][a-z0-9/_-]{0,64}$. */
  route: string;
  /** Allow-listed lucide icon name; "" / unknown ⇒ default / skipped. */
  icon?: string;
  /** Required scopes; empty/undefined ⇒ visible to any authenticated user. */
  scopes?: string[];
}

export interface PluginViewSource {
  /** Interface service id, namespaced by its owning plugin. */
  interface: string;
  method: string;
}

export interface PluginViewColumn {
  key: string;
  label: string;
  /** Allow-listed render hint: "" | "copy-secret" | "bytes" | "relative-time" | "badge" | "code". */
  render?: string;
}

export interface PluginViewFormField {
  key: string;
  label?: string;
  /** Allow-listed field kind: "text" | "int" | "select". */
  kind: string;
  options?: string[];
}

export interface PluginViewAction {
  label: string;
  interface: string;
  method: string;
  form?: PluginViewFormField[];
  scopes?: string[];
}

export interface PluginViewContribution {
  /** Route slug; matches ^[a-z0-9][a-z0-9/_-]{0,64}$. */
  route: string;
  title: string;
  /** Allow-listed view kind: v1 primitives plus v2 "sandbox". */
  kind: string;
  source?: PluginViewSource;
  columns?: PluginViewColumn[];
  actions?: PluginViewAction[];
}

export interface PluginManifestUI {
  nav?: PluginNavContribution[];
  views?: PluginViewContribution[];
}

export interface PluginInterfaceContract {
  service: string;
  methods: Array<string | PluginInterfaceMethod>;
  scopes?: string[];
}

export interface PluginInterfaceMethod {
  name: string;
  effect: "read" | "write" | "plan" | string;
  scopes?: string[];
  operator_target_fields?: string[];
}

export interface PluginUIRuntime {
  mode: "sandbox" | string;
  entry_url: string;
  bridge_version: string;
  asset_digest: string;
}

/**
 * Read-only projection of the server's plugin TrustPolicy (TASK-0012).
 * Names only. Never key material. The server emits this object always, with
 * `non_official: false` in the normal case, so absence means "server too old",
 * never "nothing to report".
 */
export interface PluginTrustView {
  non_official: boolean;
  publishers: string[];
  allow_unsigned_host_risk: boolean;
}

export interface PluginView {
  id: string;
  name: string;
  type: string;
  version?: string;
  publisher?: string;
  capabilities: string[];
  /** Lifecycle status: "verified"|"installed"|"active"|"disabled"|"". */
  status?: string;
  /** Convenience flag mirroring (status === "active"). */
  active?: boolean;
  /** UI contributions. Present ONLY when the plugin is active (server nils it otherwise). */
  ui?: PluginManifestUI;
  interfaces?: PluginInterfaceContract[];
  /** Derived active-only metadata; never includes server filesystem paths. */
  ui_runtime?: PluginUIRuntime;
}

export interface PluginRuntimeStatus {
  plugin_id: string;
  state: "armed" | "stopped" | "failed" | string;
  runner?: string;
  message?: string;
  started_at?: string;
  stopped_at?: string;
  updated_at: string;
}

export type PluginLifecycleStatus = "verified" | "installed" | "active" | "disabled";

export interface PluginInstallationView {
  id: string;
  name: string;
  type: string;
  version?: string;
  entrypoint?: string;
  publisher?: string;
  capabilities: string[];
  artifact_sha256?: string;
  available: boolean;
  status: PluginLifecycleStatus | string;
  runtime?: PluginRuntimeStatus;
  verified_at?: string;
  installed_at?: string;
  activated_at?: string;
  disabled_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
  version?: string;
  entrypoint?: string;
  publisher?: string;
  digest_sha256?: string;
  signature_ed25519?: string;
}

export interface PluginVerifyResponse {
  trusted: boolean;
  manifest: PluginManifest;
  artifact_sha256: string;
  capabilities: { name: string; risk: "read" | "write" | "host" | string }[];
}

export interface KVEntry {
  bucket: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface StaticObject {
  bucket: string;
  path: string;
  content: string;
  content_type: string;
  size: number;
  updated_at: string;
}

export type StorageKind = "kv" | "static";

/**
 * One bucket that actually exists, as opposed to one an operator registered.
 *
 * `StorageBucket` is the registered record. A bucket a plugin wrote into
 * without registering has no such record, which is how a console that listed
 * only registered buckets showed nothing while the store held Sub-Store's
 * whole database. `entries` is what the bucket holds, `registered` says
 * whether a bucket record exists, and `reserved` marks a bucket whose name is
 * visible but whose contents the server refuses to serve.
 */
export interface StorageBucketInventoryEntry {
  name: string;
  kind: StorageKind | string;
  entries: number;
  registered: boolean;
  reserved: boolean;
}
export type StorageAccess = "admin" | "read" | "write";

/**
 * A publishing origin says where a published route's bytes come from. The route
 * itself, the host and path it answers on, is the same shape for all of them.
 */
export type PublishingOrigin = "kv" | "static" | "plugin";

/** One published route: a URL the server answers on, and the rules for reading it. */
export interface PublishingRecord {
  id: string;
  origin: PublishingOrigin | string;
  /** The origin's target: a bucket name for kv and static, a share id for plugin. */
  bucket: string;
  hostname: string;
  /** True when the route answers on every hostname rather than one. */
  any_host: boolean;
  path_prefix?: string;
  enabled: boolean;
  expires_at?: string;
  /** Reserved routes cannot be moved or deleted: something outside this server depends on the URL. */
  reserved: boolean;
  share_id?: string;
  /** The scope that gates editing this route, so a control can be disabled rather than 403. */
  admin_scope: string;
}

export interface PublishingRecordList {
  records: PublishingRecord[];
  /**
   * The origins the caller was allowed to look at. An empty records list with a
   * shorter origins list is a permission boundary, not an empty product.
   */
  origins: string[];
}

export interface StorageBucket {
  id: string;
  kind: StorageKind | string;
  name: string;
  display_name?: string;
  description?: string;
  index_document?: string;
  not_found_document?: string;
  created_at: string;
  updated_at: string;
}

export interface StorageBinding {
  id: string;
  kind: StorageKind | string;
  bucket: string;
  hostname: string;
  path_prefix?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface StorageTokenView {
  id: string;
  name: string;
  kind: StorageKind | string;
  access: StorageAccess | string;
  buckets?: string[];
  revoked_at?: string;
  last_used_at?: string;
  created_at: string;
  updated_at: string;
}

export interface StorageTokenCreateResponse extends StorageTokenView {
  token: string;
}

export interface LogSource {
  id: string;
  name: string;
  node_id: string;
  path: string;
  enabled: boolean;
  max_line_bytes: number;
  max_batch_lines: number;
  created_at: string;
  updated_at: string;
  /** Minted and repaired by the server (agent debug, sing-box); it refuses edits and deletes. */
  managed?: boolean;
}

export interface LogSourceUpsertRequest {
  id?: string;
  name: string;
  node_id: string;
  path: string;
  enabled?: boolean;
  max_line_bytes?: number;
  max_batch_lines?: number;
}

export interface LogLine {
  source_id: string;
  node_id: string;
  path: string;
  seq: number;
  offset: number;
  at: string;
  line: string;
  truncated?: boolean;
}

export interface LogQueryResponse {
  lines: LogLine[];
  truncated: boolean;
  next_before_seq?: number;
}

export interface LogSourceStatsView {
  source_id: string;
  node_id: string;
  name: string;
  path: string;
  enabled: boolean;
  lines: number;
  bytes: number;
  first_at?: string;
  last_at?: string;
  last_ingest_at?: string;
  rot_id?: string;
}

export type NotifyKind = "telegram" | "bark" | "discord" | "webhook";

export interface NotifyChannelView {
  id: string;
  name: string;
  kind: NotifyKind | string;
  config_keys: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotifyChannelUpsertRequest {
  id?: string;
  name: string;
  kind: NotifyKind | string;
  config: Record<string, string>;
  enabled?: boolean;
}

export interface NotifyTestRequest {
  channel: NotifyKind | string;
  config: Record<string, string>;
  title?: string;
  body?: string;
}

export interface NotifyRuleView {
  id: string;
  name: string;
  event_types?: string[];
  channel_ids?: string[];
  title_template?: string;
  body_template?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotifyRuleUpsertRequest {
  id?: string;
  name: string;
  event_types?: string[];
  channel_ids?: string[];
  title_template?: string;
  body_template?: string;
  enabled?: boolean;
}

export interface AgentUpdatePolicy {
  node_id: string;
  enabled: boolean;
  auto_plan: boolean;
  target_version: string;
  binary_url: string;
  sha256: string;
  install_path: string;
  service_name: string;
  last_planned_version?: string;
  last_planned_at?: string;
  last_applied_version?: string;
  last_applied_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentUpdatePolicyUpsertRequest {
  node_id: string;
  enabled: boolean;
  auto_plan: boolean;
  target_version: string;
  /** Empty binary_url + sha256 asks the server to resolve the official GitHub release.
   * Explicit binary_url must be HTTPS with no query string, userinfo, or fragment
   * because it is rendered into the reviewed approval plan.
   */
  binary_url?: string;
  sha256?: string;
  install_path?: string;
  service_name?: string;
}

export interface AgentReleaseInfo {
  repo: string;
  channel?: string;
  latest_tag: string;
  latest_version: string;
  release_url: string;
  artifacts: string[];
  sha256: Record<string, string>;
  candidates?: AgentReleaseCandidate[];
  fetched_at: string;
}

/**
 * One agent binary the control plane holds and can serve to nodes itself, so a
 * node upgrading it does not need egress to the release host. The digest is the
 * same pin the plan carries and the node re-verifies after downloading.
 */
export interface AgentArtifactView {
  version: string;
  os: string;
  arch: string;
  sha256: string;
  size_bytes: number;
  stored_bytes: number;
  updated_at: string;
}

export interface AgentArtifactListing {
  artifacts: AgentArtifactView[];
  stored_bytes: number;
  limit_bytes: number;
  /**
   * False when the server has no plain HTTPS public URL to hand nodes. Stored
   * binaries stay stored and plans quietly keep using the release host, so the
   * console has to say this rather than show a full shelf doing nothing.
   */
  serving_enabled: boolean;
}

export interface AgentArtifactRequest {
  version: string;
  os?: string;
  arch: string;
}

export interface AgentReleaseCandidate {
  tag_name: string;
  version: string;
  channel: "stable" | "alpha" | "beta" | "rc" | "prerelease" | string;
  prerelease: boolean;
  latest_for_channel: boolean;
  release_url: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings: SSO/OIDC providers, Access Tokens (PATs). Secrets write-only;
// PAT plaintext is one-time-revealed on create.
// ─────────────────────────────────────────────────────────────────────────────

export interface OIDCProviderView {
  id: string;
  display_name: string;
  issuer: string;
  client_id: string;
  has_secret: boolean;
  scopes?: string[];
  allowed_domains?: string[];
  enabled: boolean;
}

export interface OIDCProviderUpsertRequest {
  id?: string;
  display_name?: string;
  issuer: string;
  client_id: string;
  client_secret?: string;
  scopes?: string[];
  allowed_domains?: string[];
  enabled?: boolean;
}

// Result of the "test connection" discovery probe for an OIDC issuer.
export interface OIDCProviderTestResult {
  ok: boolean;
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  error?: string;
}

// Operator user (secret-free projection; the server never returns the password
// hash). username is the login id and. For SSO. Must equal the operator's
// verified IdP email.
export interface UserView {
  id: string;
  username: string;
  scopes: string[];
  /** Nodes this account may reach. Empty means every node. */
  server_allowlist?: string[];
  totp_enabled: boolean;
  has_password: boolean;
  created_at: string;
}

export interface UserCreateRequest {
  username: string;
  scopes: string[];
  server_allowlist?: string[]; // omit or empty for every node
  password?: string; // omit for an SSO-only account (no password login)
}

export interface UserUpdateRequest {
  id: string;
  scopes: string[];
  /**
   * Omit to leave the confinement untouched. Send [] to widen the account back
   * to every node. The server tells the two apart, so a scope edit or password
   * reset that carries no allowlist cannot silently un-confine the account.
   */
  server_allowlist?: string[];
  password?: string; // omit/blank to keep the existing password
}

export interface TokenView {
  id: string;
  name: string;
  actor_id: string;
  scopes: string[];
  server_allowlist: string[];
  created_at: string;
  revoked_at?: string;
}

export interface TokenCreateRequest {
  name: string;
  scopes: string[];
  server_allowlist?: string[];
}

export interface TokenCreateResponse {
  id: string;
  token: string;
  view: TokenView;
}

// ── subscription shares ─────────────────────────────────────────────────────

/**
 * Where a share gets its content. Exactly one of the two shapes is valid and
 * the server refuses the mixed forms, so the UI models it as a discriminated
 * union rather than four optional strings.
 */
export type ShareSource =
  | { kind: "core.proxy_user"; proxy_user_id: string }
  | { kind: "plugin"; plugin_id: string; subscription_id: string };

/**
 * The server returns the token on purpose. The share URL is copied out of the
 * dashboard repeatedly, so hiding it after creation would trade a real
 * workflow for protection the at-rest sealing already provides.
 */
export interface SubscriptionShareView {
  id: string;
  slug: string;
  token: string;
  source: ShareSource;
  default_format?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  rotated_at?: string;
  expires_at?: string;
}

export interface SubscriptionShareCreateRequest {
  slug: string;
  source: ShareSource;
  default_format?: string;
  expires_at?: string;
}

/**
 * Every field is optional and omitting one leaves it alone, which is why
 * clearing an expiry needs its own flag rather than an empty `expires_at`:
 * the server treats "not mentioned" and "remove it" as different requests, and
 * conflating them would make any edit silently un-expire the share.
 */
export interface SubscriptionShareUpdateRequest {
  expires_at?: string;
  clear_expiry?: boolean;
  default_format?: string;
  enabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* sing-box connection trace                                           */
/*                                                                     */
/* Wire shapes for /api/trace/*. Field names mirror the Go json tags in */
/* lattice-sdk/model/trace.go exactly; the Go side uses `omitzero` on   */
/* every time.Time, so an absent timestamp is an absent field rather    */
/* than a year-1 instant, and optional here means "was never known".    */
/* ------------------------------------------------------------------ */

/** Verbosity of a sing-box log subscription. Not the node's own log.level. */
export type TraceLevel = "info" | "debug" | "trace";

/** What a capture session selects. An empty field means no constraint. */
export interface TraceFilter {
  user_ids?: string[];
  line_uuids?: string[];
  node_ids?: string[];
  /** Case-insensitive substrings matched against the destination host. */
  dst_patterns?: string[];
}

/** Per-node collection policy: the always-on floor. */
export interface TracePolicy {
  node_id: string;
  enabled: boolean;
  level: TraceLevel;
  budget_lines_per_sec: number;
  clash_api_addr?: string;
  secret_path?: string;
  updated_at?: string;
}

export interface TraceSession {
  id: string;
  name: string;
  filter: TraceFilter;
  level: TraceLevel;
  started_at: string;
  expires_at: string;
  ended_at?: string;
  state: string;
  started_by: string;
  correlation_id?: string;
  lines: number;
  records: number;
  /** Lines the agent discarded under budget. Displayed, never hidden. */
  dropped: number;
}

/** One sing-box connection as assembled on the node. */
export interface ConnRecord {
  node_id: string;
  line_uuid?: string;
  line_hash_id?: string;
  inbound_tag?: string;
  inbound_type?: string;

  user_name?: string;
  user_id?: string;
  user_kind?: string;

  log_id: number;
  network?: string;
  src_ip?: string;
  src_port?: number;
  dst_host?: string;
  dst_ip?: string;
  dst_port?: number;

  sniffed_protocol?: string;
  sniffed_domain?: string;
  rule_index?: number;
  rule_text?: string;
  outbound_tag?: string;
  outbound_type?: string;
  chain_edge_uuid?: string;

  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  /** True for a snapshot of a connection that is still running. */
  open?: boolean;

  upload?: number;
  download?: number;
  /** False means the counters were never sampled. It does not mean zero. */
  bytes_known?: boolean;

  close_reason?: string;
  close_error?: string;
  stalled_at?: string;

  core_generation?: number;
  session_ids?: string[];
  hop_path_id?: string;
}

/** One raw sing-box log line kept because a session asked for it. */
export interface TraceLine {
  session_id: string;
  node_id: string;
  seq: number;
  at: string;
  level: string;
  log_id?: number;
  tag?: string;
  message: string;
  raw?: string;
}

/** Identifies one ConnRecord. The log id alone is not unique. */
export interface ConnRecordKey {
  node_id: string;
  core_generation: number;
  log_id: number;
}

/** A connection stitched across machines. */
export interface HopPath {
  id: string;
  confidence: string;
  record_keys: ConnRecordKey[];
  /** Populated only when confidence is ambiguous. */
  candidates?: ConnRecordKey[];
}

export interface TraceConnectionsResponse {
  records: ConnRecord[];
  next_cursor?: string;
}

export interface TraceSessionsResponse {
  sessions: TraceSession[];
}

export interface TraceSessionCreateRequest {
  name: string;
  filter: TraceFilter;
  level: TraceLevel;
  ttl_seconds: number;
}

export interface TraceLinesResponse {
  lines: TraceLine[];
  next_seq?: number;
}

export interface TracePolicyResponse {
  policies: TracePolicy[];
}

export interface TracePolicyUpsertRequest {
  node_id: string;
  enabled?: boolean;
  level?: TraceLevel;
  budget_lines_per_sec?: number;
}

export interface TraceHopsResponse {
  path: HopPath;
  records: ConnRecord[];
}
