// Server model views (secret-free) faithful to lattice-server. Expanded
// per-domain as screens are built; this covers identity, fleet, safe-ops.

export interface Principal {
  actor_id: string;
  username?: string;
  token_id?: string;
  scopes: string[];
  csrf_token: string;
  totp_enabled?: boolean;
}

export interface BuildInfo {
  server_version: string;
  server_commit: string;
  server_date: string;
  dashboard_ref?: string;
  dashboard_built?: string;
}

export interface LoginResponse {
  csrf_token?: string;
  actor_id?: string;
  totp_required?: boolean;
  challenge_id?: string;
}

export interface TOTPEnrollResponse {
  secret: string;
  otpauth_uri: string;
  recovery_codes: string[];
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

export interface AgentDebugPolicy {
  enabled: boolean;
  collect: boolean;
  updated_at?: string;
}

export interface Node {
  id: string;
  name: string;
  tags?: string[];
  role?: string;
  wireguard_ip?: string;
  wireguard_endpoint?: string;
  public_ip?: string;
  public_ipv6?: string;
  internal_ip?: string;
  internal_ipv6?: string;
  agent_version?: string;
  online: boolean;
  disabled?: boolean;
  last_seen?: string;
  metrics?: Metrics;
  host_facts?: HostFacts;
  geo?: NodeGeo;
  agent_debug?: AgentDebugPolicy;
  ip_config?: NodeIPConfig | null;
  group_ids?: string[];
}

// NodeIPConfig is the operator-owned, per-node override for how the agent
// determines its public IPs. An empty/absent mode means "no override".
export interface NodeIPConfig {
  mode?: "" | "auto" | "static" | "resolver";
  static_ipv4?: string;
  static_ipv6?: string;
  resolvers?: string[];
  updated_at?: string;
}

export interface NodeGeoView {
  id: string;
  name: string;
  role?: string;
  online: boolean;
  public_ip?: string;
  public_ipv6?: string;
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
  status: "queued" | "leased" | "finished" | "failed" | "cancelled";
  leased_by?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
}

export interface TaskResult {
  task_id: string;
  lease_id?: string;
  node_id: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
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

export type ApprovalStatus = "pending" | "approved" | "applied" | "rejected" | "failed";

export interface ApprovalView {
  id: string;
  node_id: string;
  plugin: string;
  action: string;
  plan: string;
  status: ApprovalStatus;
  actor_id?: string;
  approved_by?: string;
  created_at?: string;
  updated_at?: string;
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
  region?: string;
  has_console_url?: boolean;
  has_detail_url?: boolean;
  notes?: string;
  price_cents?: number;
  currency?: string;
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
  renewal_cycle?: RenewalCycle | string;
  cycle_days?: number;
  next_renewal?: string;
  auto_roll?: boolean;
  remind_days_before?: number[];
  reminders_enabled?: boolean;
}

export interface RenewalReminderFire {
  machine_id: string;
  node_id: string;
  node_name?: string;
  offset_days: number;
  next_renewal: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy (flagship) — VLESS + REALITY inbounds, subscriber users, node profiles.
// Secrets (reality_private_key, uuid, password, sub_token) are write-only; reads
// expose only has_* booleans. Subscription URL is one-time-revealed on rotate.
// ─────────────────────────────────────────────────────────────────────────────

export type ProxyCore = "sing-box" | "xray";
export type ProxyUserStatus = "active" | "expired" | "over_quota" | "disabled" | string;

export interface ProxyInboundView {
  id: string;
  name: string;
  core: ProxyCore | string;
  protocol: string;
  listen?: string;
  port: number;
  transport?: string;
  path?: string;
  host?: string;
  security?: string;
  sni?: string;
  alpn?: string[];
  fingerprint?: string;
  cert_path?: string;
  key_path?: string;
  has_reality_private_key: boolean;
  reality_public_key?: string;
  reality_short_ids?: string[];
  reality_dest?: string;
  ss_method?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProxyInboundUpsertRequest {
  id?: string;
  name: string;
  core?: ProxyCore | string;
  protocol?: string;
  listen?: string;
  port: number;
  transport?: string;
  sni?: string;
  alpn?: string[];
  fingerprint?: string;
  reality_private_key: string;
  reality_public_key?: string;
  reality_short_ids: string[];
  reality_dest: string;
  enabled?: boolean;
}

export interface ProxyUserView {
  id: string;
  name: string;
  enabled: boolean;
  has_uuid: boolean;
  has_password: boolean;
  has_sub_token: boolean;
  inbound_ids?: string[];
  traffic_limit_bytes?: number;
  expires_at?: string;
  used_bytes: number;
  last_seen_at?: string;
  status: ProxyUserStatus;
  created_at: string;
  updated_at: string;
}

export interface ProxyUserUpsertRequest {
  id?: string;
  name: string;
  enabled?: boolean;
  uuid?: string;
  password?: string;
  sub_token?: string;
  inbound_ids?: string[];
  traffic_limit_bytes?: number;
  expires_at?: string;
}

export interface RotateSubTokenResponse {
  user: ProxyUserView;
  subscription_url: string;
  token_sha256: string;
}

export interface ProxyNodeProfileView {
  id: string;
  node_id: string;
  node_name?: string;
  core: ProxyCore | string;
  inbound_ids: string[];
  hostname?: string;
  listen_ip?: string;
  config_path?: string;
  stats_api?: string;
  applied_sha256?: string;
  last_apply_at?: string;
  last_error?: string;
  usage_collector_source?: string;
  usage_collector_status?: string;
  usage_collector_checked_at?: string;
  usage_collector_last_ok_at?: string;
  usage_collector_last_error?: string;
  usage_collector_last_error_at?: string;
  config_stale?: boolean;
  pending_config_sha256?: string;
  ineligible_users?: number;
  drift_reason?: string;
  drift_checked_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ProxyNodeProfileUpsertRequest {
  id?: string;
  node_id: string;
  core?: ProxyCore | string;
  inbound_ids: string[];
  hostname?: string;
  listen_ip?: string;
  config_path?: string;
  stats_api?: string;
}

export interface ProxyUsageSnapshotView {
  node_id: string;
  node_name?: string;
  at: string;
  core_uptime_sec: number;
  user_bytes: Record<string, number>;
}

export interface ProxyUsageUserView {
  id: string;
  name: string;
  enabled: boolean;
  used_bytes: number;
  traffic_limit_bytes?: number;
  last_seen_at?: string;
  status: ProxyUserStatus;
}

export interface ProxyUsageResponse {
  snapshots: ProxyUsageSnapshotView[];
  users: ProxyUsageUserView[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Networking — Network Guard (nft), Network Policy (+graph), Self-host DNS,
// Geo-Routing, DDNS, Tunnels, WireGuard. Most mutations go through plan→approve.
// ─────────────────────────────────────────────────────────────────────────────

export interface NFTPlanBody {
  interface_name?: string;
  wireguard_cidr?: string;
  public_tcp?: number[];
  public_udp?: number[];
  wireguard_tcp?: number[];
  wireguard_udp?: number[];
}

export interface NFTInputsView {
  id: string;
  node_id: string;
  node_name?: string;
  interface_name: string;
  wireguard_cidr: string;
  public_tcp?: number[];
  public_udp?: number[];
  wireguard_tcp?: number[];
  wireguard_udp?: number[];
  updated_at: string;
}

export interface NFTInputsUpsertBody extends NFTPlanBody {
  node_id: string;
}

export type NetRuleAction = "allow" | "deny";
export type NetRuleDirection = "egress" | "ingress";
export type NetRuleProtocol = "tcp" | "udp" | "any";
export type NetEndpointKind = "node" | "cidr" | "domain" | "any" | "group";

export interface NetEndpoint {
  kind: NetEndpointKind;
  node_id?: string;
  cidr?: string;
  domain?: string;
  group_id?: string;
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

export interface WireGuardPlanRequest {
  node_id: string;
  listen_port?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform — Plugins, Workers, KV, Static, Logs, Notifications, Agent Updates.
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginView {
  id: string;
  name: string;
  type: string;
  version?: string;
  publisher?: string;
  capabilities: string[];
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

export interface WorkerScript {
  id: string;
  name: string;
  source: string;
  capabilities: string[];
  public: boolean;
  updated_at: string;
}

export interface WorkerRunResponse {
  status: number;
  body: string;
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
export type StorageAccess = "admin" | "read" | "write";

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
  binary_url: string;
  sha256: string;
  install_path?: string;
  service_name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings — SSO/OIDC providers, Access Tokens (PATs). Secrets write-only;
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
// hash). username is the login id and — for SSO — must equal the operator's
// verified IdP email.
export interface UserView {
  id: string;
  username: string;
  scopes: string[];
  totp_enabled: boolean;
  has_password: boolean;
  created_at: string;
}

export interface UserCreateRequest {
  username: string;
  scopes: string[];
  password?: string; // omit for an SSO-only account (no password login)
}

export interface UserUpdateRequest {
  id: string;
  scopes: string[];
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
