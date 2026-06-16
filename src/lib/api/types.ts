// Server model views (secret-free) faithful to lattice-server. Expanded
// per-domain as screens are built; this covers identity, fleet, safe-ops.

export interface Principal {
  actor_id: string;
  token_id?: string;
  scopes: string[];
  csrf_token: string;
  totp_enabled?: boolean;
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
  city?: string;
  lat?: number;
  lon?: number;
  asn?: number;
  as_org?: string;
  provider?: string;
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
  agent_version?: string;
  online: boolean;
  disabled?: boolean;
  last_seen?: string;
  metrics?: Metrics;
  host_facts?: HostFacts;
  geo?: NodeGeo;
}

export interface NodeGeoView {
  id: string;
  name: string;
  role?: string;
  online: boolean;
  geo?: NodeGeo;
}

export interface EnrollTokenResponse {
  node_id: string;
  token: string;
  server_url: string;
  command: string;
}

export interface TaskView {
  id: string;
  approval_id?: string;
  targets: string[];
  interpreter: string;
  script_sha256?: string;
  script_size_bytes?: number;
  status: "queued" | "leased" | "finished" | "failed";
  leased_by?: string;
  created_at?: string;
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
}

export interface MonitorResult {
  monitor_id: string;
  node_id: string;
  at: string;
  success: boolean;
  latency_ms?: number;
  error?: string;
}
