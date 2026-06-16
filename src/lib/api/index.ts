import { http } from "./client";
import type {
  Principal,
  LoginResponse,
  TOTPEnrollResponse,
  SSOProvider,
  Node,
  NodeGeoInput,
  NodeGeoView,
  EnrollTokenResponse,
  TaskView,
  TaskResult,
  ApprovalView,
  AuditQueryResponse,
  MonitorCreateInput,
  MonitorView,
  MonitorResult,
  MachineProfileInput,
  MachineView,
  RenewalReminderFire,
  ProxyInboundView,
  ProxyInboundUpsertRequest,
  ProxyUserView,
  ProxyUserUpsertRequest,
  RotateSubTokenResponse,
  ProxyNodeProfileView,
  ProxyNodeProfileUpsertRequest,
  ProxyUsageResponse,
  NFTInputsView,
  NFTInputsUpsertBody,
  NetPolicyView,
  NetPolicyUpsertRequest,
  NetPolicyGraph,
  DNSDeploymentView,
  DNSDeploymentBody,
  DNSPublishResponse,
  GeoRouting,
  GeoRoutingUpsertRequest,
  GeoRoutingPlanView,
  DDNSView,
  DDNSUpsertRequest,
  TunnelView,
  TunnelUpsertRequest,
  WireGuardPlanRequest,
  PluginView,
  PluginInstallationView,
  PluginLifecycleStatus,
  PluginVerifyResponse,
  WorkerScript,
  WorkerRunResponse,
  KVEntry,
  StaticObject,
  LogSource,
  LogSourceUpsertRequest,
  LogQueryResponse,
  LogSourceStatsView,
  NotifyChannelView,
  NotifyChannelUpsertRequest,
  NotifyTestRequest,
  AgentUpdatePolicy,
  AgentUpdatePolicyUpsertRequest,
  OIDCProviderView,
  OIDCProviderUpsertRequest,
  TokenView,
  TokenCreateRequest,
  TokenCreateResponse,
} from "./types";

export * from "./types";
export { ApiError, setCsrfToken, getCsrfToken } from "./client";

/** Typed surface over the lattice-server JSON API, grouped by feature domain. */
export const api = {
  auth: {
    me: () => http.get<Principal>("/api/me"),
    login: (username: string, password: string) =>
      http.post<LoginResponse>("/api/login", { username, password }),
    loginTotp: (challenge_id: string, code?: string, recovery_code?: string) =>
      http.post<LoginResponse>("/api/login/totp", { challenge_id, code, recovery_code }),
    changePassword: (current_password: string, new_password: string) =>
      http.post<void>("/api/auth/password", { current_password, new_password }),
    totpEnroll: () => http.post<TOTPEnrollResponse>("/api/2fa/totp/enroll", {}),
    totpActivate: (code: string) => http.post<void>("/api/2fa/totp/activate", { code }),
    totpDisable: (code: string) => http.post<void>("/api/2fa/totp/disable", { code }),
    logout: () => http.post<void>("/api/logout"),
    ssoProviders: () => http.get<SSOProvider[]>("/api/auth/oidc"),
  },

  nodes: {
    list: () => http.get<{ nodes: Node[] } | Node[]>("/api/nodes"),
    enrollToken: (input: {
      node_id?: string;
      name: string;
      tags?: string[];
      role?: string;
      wireguard_ip?: string;
    }) => http.post<EnrollTokenResponse>("/api/nodes/enroll-token", input),
    rotateToken: (node_id: string) =>
      http.post<{ node_id: string; token: string }>("/api/nodes/rotate-token", { node_id }),
    disable: (node_id: string, disabled: boolean) =>
      http.post<void>("/api/nodes/disable", { node_id, disabled }),
    geo: () => http.get<{ nodes: NodeGeoView[] } | NodeGeoView[]>("/api/nodes/geo"),
    updateGeo: (node_id: string, geo: NodeGeoInput) =>
      http.post<NodeGeoView>("/api/nodes/geo", { node_id, geo }),
    clearGeo: (node_id: string) =>
      http.post<NodeGeoView>("/api/nodes/geo", { node_id, clear: true }),
  },

  tasks: {
    list: () => http.get<{ tasks: TaskView[] } | TaskView[]>("/api/tasks"),
    results: () => http.get<{ results: TaskResult[] } | TaskResult[]>("/api/task-results"),
    create: (input: {
      targets: string[];
      interpreter: string;
      script: string;
      timeout_sec?: number;
      output_limit?: number;
    }) => http.post<TaskView>("/api/tasks", input),
  },

  approvals: {
    list: () => http.get<{ approvals: ApprovalView[] } | ApprovalView[]>("/api/network/approvals"),
    approve: (approval_id: string, queue_apply: boolean, plan_sha256?: string) =>
      http.post<void>("/api/network/approvals/approve", {
        approval_id,
        queue_apply,
        plan_sha256,
      }),
  },

  monitors: {
    list: () => http.get<{ monitors: MonitorView[] } | MonitorView[]>("/api/monitors"),
    create: (input: MonitorCreateInput) => http.post<MonitorView>("/api/monitors", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/monitors/delete", { id }),
    results: (monitor_id: string) =>
      http.get<{ results: MonitorResult[] } | MonitorResult[]>("/api/monitors/results", {
        monitor_id,
      }),
  },

  machines: {
    list: () => http.get<{ machines: MachineView[] } | MachineView[]>("/api/machines"),
    create: (input: MachineProfileInput) => http.post<MachineView>("/api/machines", input),
    update: (input: MachineProfileInput & { id: string }) =>
      http.post<MachineView>("/api/machines/update", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/machines/delete", { id }),
    renew: (id: string, next_renewal?: string) =>
      http.post<MachineView>("/api/machines/renew", { id, next_renewal }),
    runReminders: (id?: string) =>
      http.post<{ fired: RenewalReminderFire[] }>("/api/machines/reminders/run", id ? { id } : {}),
  },

  audit: {
    query: (params?: {
      action?: string;
      decision?: string;
      node_id?: string;
      actor_id?: string;
      correlation_id?: string;
      limit?: number;
      offset?: number;
    }) => http.get<AuditQueryResponse>("/api/audit", params as Record<string, unknown>),
    verify: () =>
      http.get<{ enabled: boolean; ok: boolean; count: number; head?: string }>("/api/audit/verify"),
  },

  proxy: {
    inbounds: () => http.get<{ inbounds: ProxyInboundView[] }>("/api/proxy/inbounds"),
    upsertInbound: (input: ProxyInboundUpsertRequest) =>
      http.post<ProxyInboundView>("/api/proxy/inbounds", input),
    deleteInbound: (id: string, force?: boolean) =>
      http.post<{ ok: boolean }>("/api/proxy/inbounds/delete", { id, force }),
    users: () => http.get<{ users: ProxyUserView[] }>("/api/proxy/users"),
    upsertUser: (input: ProxyUserUpsertRequest) =>
      http.post<ProxyUserView>("/api/proxy/users", input),
    deleteUser: (id: string) => http.post<{ ok: boolean }>("/api/proxy/users/delete", { id }),
    rotateSubToken: (id: string) =>
      http.post<RotateSubTokenResponse>("/api/proxy/users/rotate-sub-token", { id }),
    profiles: () => http.get<{ profiles: ProxyNodeProfileView[] }>("/api/proxy/profiles"),
    upsertProfile: (input: ProxyNodeProfileUpsertRequest) =>
      http.post<ProxyNodeProfileView>("/api/proxy/profiles", input),
    deleteProfile: (node_id: string) =>
      http.post<{ ok: boolean }>("/api/proxy/profiles/delete", { node_id }),
    planNode: (node_id: string) =>
      http.post<ApprovalView>(`/api/proxy/nodes/${encodeURIComponent(node_id)}/plan`, {}),
    usage: () => http.get<ProxyUsageResponse>("/api/proxy/usage"),
  },

  nft: {
    inputs: () => http.get<{ inputs: NFTInputsView[] }>("/api/network/nft/inputs"),
    upsertInputs: (input: NFTInputsUpsertBody) =>
      http.post<NFTInputsView>("/api/network/nft/inputs", input),
    deleteInputs: (node_id: string) =>
      http.post<{ ok: boolean }>("/api/network/nft/inputs/delete", { node_id }),
    plan: (input: NFTInputsUpsertBody) =>
      http.post<ApprovalView>("/api/network/nft/plan", input),
  },

  netpolicy: {
    list: () => http.get<{ policies: NetPolicyView[] }>("/api/netpolicy"),
    upsert: (input: NetPolicyUpsertRequest) => http.post<NetPolicyView>("/api/netpolicy", input),
    delete: (target_node_id: string) =>
      http.post<{ ok: boolean }>("/api/netpolicy/delete", { target_node_id }),
    plan: (node_id: string) => http.post<ApprovalView>("/api/netpolicy/plan", { node_id }),
    graph: () => http.get<NetPolicyGraph>("/api/netpolicy/graph"),
  },

  dns: {
    deployments: () => http.get<{ deployments: DNSDeploymentView[] }>("/api/dns/deployments"),
    upsert: (input: DNSDeploymentBody) =>
      http.post<DNSDeploymentView>("/api/dns/deployments", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/dns/deployments/delete", { id }),
    plan: (id: string) => http.post<ApprovalView>("/api/dns/plan", { id }),
    publish: (id: string) => http.post<DNSPublishResponse>("/api/dns/publish", { id }),
  },

  geoRouting: {
    list: () => http.get<{ geo_routings: GeoRouting[] }>("/api/geo-routing"),
    upsert: (input: GeoRoutingUpsertRequest) => http.post<GeoRouting>("/api/geo-routing", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/geo-routing/delete", { id }),
    plan: (id: string) => http.post<GeoRoutingPlanView>("/api/geo-routing/plan", { id }),
  },

  ddns: {
    list: () => http.get<DDNSView[]>("/api/ddns"),
    create: (input: DDNSUpsertRequest) => http.post<DDNSView>("/api/ddns", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/ddns/delete", { id }),
    run: (id: string) => http.post<DDNSView>("/api/ddns/run", { id }),
  },

  tunnels: {
    list: () => http.get<TunnelView[]>("/api/tunnels"),
    create: (input: TunnelUpsertRequest) => http.post<TunnelView>("/api/tunnels", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/tunnels/delete", { id }),
    plan: (id: string) => http.post<ApprovalView>("/api/tunnels/plan", { id }),
  },

  wireguard: {
    plan: (input: WireGuardPlanRequest) =>
      http.post<ApprovalView>("/api/network/wireguard/plan", input),
  },

  plugins: {
    list: () => http.get<PluginView[]>("/api/plugins"),
    lifecycle: () => http.get<PluginInstallationView[]>("/api/plugins/lifecycle"),
    setLifecycle: (id: string, status: PluginLifecycleStatus) =>
      http.post<PluginInstallationView>("/api/plugins/lifecycle", { id, status }),
    verify: (manifest: unknown, artifact_base64: string) =>
      http.post<PluginVerifyResponse>("/api/plugins/verify", { manifest, artifact_base64 }),
  },

  workers: {
    list: () => http.get<WorkerScript[]>("/api/workers"),
    deploy: (input: { name: string; source: string; capabilities?: string[]; public?: boolean }) =>
      http.post<WorkerScript>("/api/workers", input),
    run: (worker_id: string, path: string) =>
      http.post<WorkerRunResponse>("/api/workers/run", { worker_id, path }),
  },

  kv: {
    list: (bucket?: string) => http.get<KVEntry[]>("/api/kv", bucket ? { bucket } : undefined),
    put: (input: { bucket?: string; key: string; value: string }) =>
      http.post<KVEntry>("/api/kv", input),
  },

  static: {
    list: (bucket?: string) =>
      http.get<StaticObject[]>("/api/static", bucket ? { bucket } : undefined),
    put: (input: { bucket?: string; path: string; content: string; content_type: string }) =>
      http.post<StaticObject>("/api/static", input),
  },

  logs: {
    sources: () => http.get<{ sources: LogSource[] }>("/api/logs/sources"),
    upsertSource: (input: LogSourceUpsertRequest) =>
      http.post<LogSource>("/api/logs/sources", input),
    deleteSource: (id: string) =>
      http.post<{ ok: boolean }>("/api/logs/sources/delete", { id }),
    query: (params: {
      source_id: string;
      q?: string;
      since?: string;
      until?: string;
      limit?: number;
      before_seq?: number;
    }) => http.get<LogQueryResponse>("/api/logs/query", params as Record<string, unknown>),
    stats: (source_id?: string) =>
      http.get<{ stats: LogSourceStatsView[] }>(
        "/api/logs/stats",
        source_id ? { source_id } : undefined,
      ),
  },

  notify: {
    channels: () => http.get<NotifyChannelView[]>("/api/notify/channels"),
    upsertChannel: (input: NotifyChannelUpsertRequest) =>
      http.post<NotifyChannelView>("/api/notify/channels", input),
    deleteChannel: (id: string) =>
      http.post<{ ok: boolean }>("/api/notify/channels/delete", { id }),
    test: (input: NotifyTestRequest) =>
      http.post<{ ok: boolean; channel: string }>("/api/notify/test", input),
  },

  agentUpdates: {
    list: () => http.get<{ policies: AgentUpdatePolicy[] }>("/api/nodes/agent-updates"),
    upsert: (input: AgentUpdatePolicyUpsertRequest) =>
      http.post<AgentUpdatePolicy>("/api/nodes/agent-updates", input),
    delete: (node_id: string) =>
      http.post<{ ok: boolean }>("/api/nodes/agent-updates/delete", { node_id }),
    plan: (node_id: string, force?: boolean) =>
      http.post<ApprovalView>("/api/nodes/agent-updates/plan", { node_id, force }),
  },

  oidc: {
    providers: () => http.get<{ providers: OIDCProviderView[] }>("/api/auth/oidc/providers"),
    upsertProvider: (input: OIDCProviderUpsertRequest) =>
      http.post<OIDCProviderView>("/api/auth/oidc/providers", input),
    deleteProvider: (id: string) =>
      http.post<{ status: string }>("/api/auth/oidc/providers/delete", { id }),
  },

  tokens: {
    list: () => http.get<TokenView[]>("/api/tokens"),
    create: (input: TokenCreateRequest) => http.post<TokenCreateResponse>("/api/tokens", input),
    revoke: (token_id: string) => http.post<TokenView>("/api/tokens/revoke", { token_id }),
  },

  health: () => http.get<{ status: string }>("/api/health"),
};

/** Normalize list endpoints that may return either a bare array or {key:[]}. */
export function unwrap<T>(res: T[] | Record<string, T[]>, key: string): T[] {
  if (Array.isArray(res)) return res;
  const v = (res as Record<string, T[]>)[key];
  return Array.isArray(v) ? v : [];
}
