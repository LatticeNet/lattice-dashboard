import { http } from "./client";
import type {
  Principal,
  LoginResponse,
  BuildInfo,
  TOTPEnrollResponse,
  SSOProvider,
  Node,
  NodeDeletePlanView,
  NodeGeoInput,
  NodeGeoResolveResponse,
  NodeGeoView,
  AgentLaunchConfig,
  EnrollTokenResponse,
  TaskView,
  TaskResult,
  TerminalEventsResponse,
  TerminalSession,
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
  SingBoxInventory,
  ProxyManagedAddRequest,
  ProxyManagedDeleteRequest,
  ProxyManagedProbeRequest,
  ProxyManagedTaskResponse,
  SubStoreImportRequest,
  SubStoreImportResponse,
  SubStoreStatusResponse,
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
  StorageAccess,
  StorageBinding,
  StorageBucket,
  StorageKind,
  StorageTokenCreateResponse,
  StorageTokenView,
  LogSource,
  LogSourceUpsertRequest,
  LogQueryResponse,
  LogSourceStatsView,
  NotifyChannelView,
  NotifyChannelUpsertRequest,
  NotifyRuleUpsertRequest,
  NotifyRuleView,
  NotifyTestRequest,
  AgentUpdatePolicy,
  AgentUpdatePolicyUpsertRequest,
  OIDCProviderView,
  OIDCProviderUpsertRequest,
  OIDCProviderTestResult,
  UserView,
  UserCreateRequest,
  UserUpdateRequest,
  TokenView,
  TokenCreateRequest,
  TokenCreateResponse,
  NetPolicyMatrix,
  GroupsListResponse,
  GroupUpsertRequest,
  GroupView,
  GroupSelector,
  GroupPolicyView,
  GroupPolicyUpsertRequest,
  GroupPolicyPlanResult,
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
    // The server returns {providers:[...]}; unwrap it so the declared
    // SSOProvider[] is true at runtime (the LoginView guards with
    // Array.isArray, so the raw envelope object would silently render no SSO
    // buttons). Tolerates a bare-array fallback too.
    ssoProviders: () =>
      http
        .get<{ providers?: SSOProvider[] } | SSOProvider[]>("/api/auth/oidc")
        .then((r) => (Array.isArray(r) ? r : (r?.providers ?? []))),
  },

  nodes: {
    list: () => http.get<{ nodes: Node[] } | Node[]>("/api/nodes"),
    enrollToken: (input: {
      node_id?: string;
      name: string;
      comment?: string;
      tags?: string[];
      role?: string;
      wireguard_ip?: string;
      group_ids?: string[];
      agent_launch?: AgentLaunchConfig;
    }) => http.post<EnrollTokenResponse>("/api/nodes/enroll-token", input),
    reconfigureCommand: (input: { node_id: string; agent_launch?: AgentLaunchConfig }) =>
      http.post<{
        node_id: string;
        server_url: string;
        command: string;
        commands?: Record<string, string>;
        agent_launch?: AgentLaunchConfig;
      }>("/api/nodes/reconfigure-command", input),
    rotateToken: (node_id: string) =>
      http.post<{ node_id: string; token: string }>("/api/nodes/rotate-token", { node_id }),
    disable: (node_id: string, disabled: boolean) =>
      http.post<void>("/api/nodes/disable", { node_id, disabled }),
    // Edit a node's operator-owned identity (name / role / tags) after enrollment.
    // Mirrors `disable`: POST + CSRF + typed-error handling via `http`. Omitted
    // fields are left unchanged server-side; returns the persisted identity.
    update: (input: { node_id: string; name?: string; role?: string; comment?: string; tags?: string[] }) =>
      http.post<{ ok: boolean; name: string; role: string; comment?: string; tags: string[] }>(
        "/api/nodes/update",
        input,
      ),
    // Suspected duplicate nodes (same machine enrolled twice): clustered by
    // wireguard key / public+internal IP pair / host fingerprint — never public
    // IP alone (NAT hosts share it). Detection only; the operator decides.
    duplicates: () =>
      http.get<{
        groups: Array<{ reason: string; confidence: string; signal: string; node_ids: string[] }>;
      }>("/api/nodes/duplicates"),
    // Dry-run preview of a hard-delete: returns the cascade counts (monitors,
    // ddns, groups, …) without mutating anything (mutated=false).
    deletePlan: (node_id: string) =>
      http.post<NodeDeletePlanView>("/api/nodes/delete/plan", { node_id }),
    // Hard-delete the node and cascade-clean every dependent record. Irreversible;
    // returns the applied cleanup counts (mutated=true).
    delete: (node_id: string) =>
      http.post<NodeDeletePlanView>("/api/nodes/delete", { node_id }),
    setDebug: (node_id: string, enabled: boolean, collect?: boolean) =>
      http.post<Node>("/api/nodes/debug", { node_id, enabled, collect }),
    geo: () => http.get<{ nodes: NodeGeoView[] } | NodeGeoView[]>("/api/nodes/geo"),
    updateGeo: (node_id: string, geo: NodeGeoInput) =>
      http.post<NodeGeoView>("/api/nodes/geo", { node_id, geo }),
    clearGeo: (node_id: string) =>
      http.post<NodeGeoView>("/api/nodes/geo", { node_id, clear: true }),
    resolveGeo: (input: { node_id?: string; all?: boolean; missing_only?: boolean; overwrite?: boolean }) =>
      http.post<NodeGeoResolveResponse>("/api/nodes/geo/resolve", input),
    // Set or clear the per-node public-IP discovery override. An empty mode
    // clears it (the node reverts to its agent's startup flags).
    ipConfig: (input: {
      node_id: string;
      mode: "" | "auto" | "static" | "resolver" | "script";
      static_ipv4?: string;
      static_ipv6?: string;
      resolvers?: string[];
      script?: string;
    }) => http.post<Node>("/api/nodes/ip-config", input),
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
    // Re-queue a stored task by id. The script body stays server-side (task
    // views only expose its SHA), so rerun is a server re-create, not a resubmit.
    rerun: (id: string) => http.post<TaskView>("/api/tasks/rerun", { id }),
    rerunNode: (id: string, node_id: string) => http.post<TaskView>("/api/tasks/rerun-node", { id, node_id }),
    cancel: (id: string) => http.post<TaskView>("/api/tasks/cancel", { id }),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/tasks/delete", { id }),
  },

  terminal: {
    list: () => http.get<{ sessions: TerminalSession[] }>("/api/terminal/sessions"),
    create: (input: { node_id: string; shell?: string; cols?: number; rows?: number }) =>
      http.post<TerminalSession>("/api/terminal/sessions", input),
    events: (session_id: string, cursor = 0) =>
      http.get<TerminalEventsResponse>(`/api/terminal/sessions/${encodeURIComponent(session_id)}/events`, {
        cursor,
      }),
    input: (session_id: string, data: string) =>
      http.post<TerminalSession>(`/api/terminal/sessions/${encodeURIComponent(session_id)}/input`, { data }),
    resize: (session_id: string, cols: number, rows: number) =>
      http.post<TerminalSession>(`/api/terminal/sessions/${encodeURIComponent(session_id)}/resize`, { cols, rows }),
    close: (session_id: string) =>
      http.post<TerminalSession>(`/api/terminal/sessions/${encodeURIComponent(session_id)}/close`, {}),
    // streamURL builds the same-origin WebSocket attach URL. The session cookie
    // rides the WS handshake (same origin). Only usable when the node's agent
    // runs in stream mode; otherwise the server closes with 1013.
    streamURL: (session_id: string) => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/api/terminal/sessions/${encodeURIComponent(session_id)}/attach`;
    },
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
      token_id?: string;
      scope?: string;
      correlation_id?: string;
      q?: string;
      at_from?: string;
      at_to?: string;
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
    // Read-only adoption bridge: sing-box nodes discovered on each machine but
    // managed out-of-band (agents started with -singbox-discover).
    discovered: () =>
      http.get<{ inventories: SingBoxInventory[] }>("/api/proxy/discovered"),
    // Model-B adoption bridge. These endpoints queue async node-agent tasks and
    // return a task_id; probe is read-only and refreshes the discovered inventory
    // when its task-result is accepted, while add/delete surface on the next
    // discovery report. Mutations require proxy:admin/task:run as enforced server-side.
    managed: {
      probe: (input: ProxyManagedProbeRequest) =>
        http.post<ProxyManagedTaskResponse>("/api/proxy/managed/probe", input),
      add: (input: ProxyManagedAddRequest) =>
        http.post<ProxyManagedTaskResponse>("/api/proxy/managed/add", input),
      delete: (input: ProxyManagedDeleteRequest) =>
        http.post<ProxyManagedTaskResponse>("/api/proxy/managed/delete", input),
    },
  },

  // Sub-Store companion (internal-only). `status` probes the operator's Sub-Store
  // backend reachability (proxy:read); `import` pushes the live vpn-core node
  // links into it as a managed local subscription (proxy:admin). No public link
  // is published — these only trigger an internal import + report reachability.
  substore: {
    status: (base_url: string) =>
      http.get<SubStoreStatusResponse>("/api/substore/status", { base_url }),
    import: (input: SubStoreImportRequest) =>
      http.post<SubStoreImportResponse>("/api/substore/import", input),
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
    matrix: (direction: "egress" | "ingress" = "egress") =>
      http.get<NetPolicyMatrix>("/api/netpolicy/matrix", { direction }),
  },

  groups: {
    list: () => http.get<GroupsListResponse>("/api/groups"),
    upsert: (input: GroupUpsertRequest) => http.post<GroupView>("/api/groups", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/groups/delete", { id }),
    reorder: (items: { id: string; parent_id?: string; order: number }[]) =>
      http.post<{ ok: boolean }>("/api/groups/reorder", { items }),
    members: (group_id: string, add: string[], remove: string[]) =>
      http.post<GroupView>("/api/groups/members", { group_id, add, remove }),
    preview: (selector: GroupSelector) =>
      http.post<{ node_ids: string[]; count: number }>("/api/groups/preview", selector),
    seed: () => http.post<{ created: number; skipped: number }>("/api/groups/seed", {}),
  },

  groupPolicy: {
    list: () => http.get<{ policies: GroupPolicyView[] }>("/api/group-policies"),
    upsert: (input: GroupPolicyUpsertRequest) =>
      http.post<GroupPolicyView>("/api/group-policies", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/group-policies/delete", { id }),
    plan: () => http.post<GroupPolicyPlanResult>("/api/group-policies/plan", {}),
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
    contributions: () => http.get<PluginView[]>("/api/plugin-contributions"),
    lifecycle: () => http.get<PluginInstallationView[]>("/api/plugins/lifecycle"),
    setLifecycle: (id: string, status: PluginLifecycleStatus) =>
      http.post<PluginInstallationView>("/api/plugins/lifecycle", { id, status }),
    verify: (manifest: unknown, artifact_base64: string) =>
      http.post<PluginVerifyResponse>("/api/plugins/verify", { manifest, artifact_base64 }),
    // Dashboard→plugin gateway (design-10). Calls a plugin's declared interface
    // method through the capability/scope-gated server endpoint and returns the
    // raw JSON the method produced. The server validates that the plugin is
    // active and declares (service, method) and checks the interface's scopes.
    call: <T = unknown>(id: string, service: string, method: string, payload?: unknown) =>
      http.post<T>("/api/plugins/call", { id, service, method, payload }),
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

  storage: {
    buckets: (kind: StorageKind) =>
      http.get<{ buckets: StorageBucket[] }>("/api/storage/buckets", { kind }),
    upsertBucket: (
      kind: StorageKind,
      input: {
        name: string;
        display_name?: string;
        description?: string;
        index_document?: string;
        not_found_document?: string;
      },
    ) => http.post<StorageBucket>(`/api/storage/buckets?kind=${encodeURIComponent(kind)}`, input),
    bindings: (kind: StorageKind) =>
      http.get<{ bindings: StorageBinding[] }>("/api/storage/bindings", { kind }),
    upsertBinding: (
      kind: StorageKind,
      input: {
        id?: string;
        bucket: string;
        hostname: string;
        path_prefix?: string;
        enabled?: boolean;
      },
    ) => http.post<StorageBinding>(`/api/storage/bindings?kind=${encodeURIComponent(kind)}`, input),
    deleteBinding: (kind: StorageKind, id: string) =>
      http.post<{ ok: boolean }>("/api/storage/bindings/delete", { kind, id }),
    tokens: (kind: StorageKind) =>
      http.get<{ tokens: StorageTokenView[] }>("/api/storage/tokens", { kind }),
    createToken: (
      kind: StorageKind,
      input: { name: string; access: StorageAccess; buckets?: string[] },
    ) =>
      http.post<StorageTokenCreateResponse>(
        `/api/storage/tokens?kind=${encodeURIComponent(kind)}`,
        input,
      ),
    revokeToken: (kind: StorageKind, token_id: string) =>
      http.post<StorageTokenView>("/api/storage/tokens/revoke", { kind, token_id }),
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
    rules: () => http.get<{ rules: NotifyRuleView[] }>("/api/notify/rules"),
    upsertRule: (input: NotifyRuleUpsertRequest) =>
      http.post<NotifyRuleView>("/api/notify/rules", input),
    deleteRule: (id: string) =>
      http.post<{ ok: boolean }>("/api/notify/rules/delete", { id }),
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
    testProvider: (issuer: string) =>
      http.post<OIDCProviderTestResult>("/api/auth/oidc/providers/test", { issuer }),
  },

  users: {
    list: () => http.get<{ users: UserView[] }>("/api/users"),
    create: (input: UserCreateRequest) => http.post<UserView>("/api/users", input),
    update: (input: UserUpdateRequest) => http.post<UserView>("/api/users/update", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/users/delete", { id }),
  },

  tokens: {
    list: () => http.get<TokenView[]>("/api/tokens"),
    create: (input: TokenCreateRequest) => http.post<TokenCreateResponse>("/api/tokens", input),
    revoke: (token_id: string) => http.post<TokenView>("/api/tokens/revoke", { token_id }),
  },

  health: () => http.get<{ status: string }>("/api/health"),
  version: () => http.get<BuildInfo>("/api/version"),
};

/** Normalize list endpoints that may return either a bare array or {key:[]}. */
export function unwrap<T>(res: T[] | Record<string, T[]>, key: string): T[] {
  if (Array.isArray(res)) return res;
  const v = (res as Record<string, T[]>)[key];
  return Array.isArray(v) ? v : [];
}
