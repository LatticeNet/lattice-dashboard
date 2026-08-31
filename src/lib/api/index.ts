import { ApiError, http, type RequestOptions } from "./client";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@/lib/webauthn";
import type {
  AgentArtifactListing,
  AgentArtifactRequest,
  AgentArtifactView,
  AgentLaunchConfig,
  AgentReleaseInfo,
  AgentUpdatePolicy,
  AgentUpdatePolicyUpsertRequest,
  ApprovalView,
  AuditQueryResponse,
  AuditVerifyResponse,
  BuildInfo,
  DDNSUpsertRequest,
  DDNSView,
  DNSDeploymentBody,
  DNSDeploymentView,
  DNSPublishResponse,
  EnrollTokenResponse,
  GeoRouting,
  GeoRoutingPlanView,
  GeoRoutingUpsertRequest,
  GroupPolicyPlanResult,
  GroupPolicyUpsertRequest,
  GroupPolicyView,
  GroupSelector,
  GroupUpsertRequest,
  GroupView,
  GroupsListResponse,
  KVEntry,
  LogQueryResponse,
  LogSource,
  LogSourceStatsView,
  LogSourceUpsertRequest,
  LoginResponse,
  MachineLinkRevealResponse,
  MachineProfileInput,
  MachineVendorInput,
  MachineVendorView,
  MachineView,
  MonitorCreateInput,
  MonitorResult,
  MonitorView,
  NetPolicyGraph,
  NetPolicyMatrix,
  NetPolicyUpsertRequest,
  NetPolicyView,
  Node,
  KnownCapability,
  NodeCapability,
  CapabilityImpact,
  NodeCapabilityEffective,
  NodeDeletePlanView,
  NodeGeoInput,
  NodeGeoResolveResponse,
  NodeGeoView,
  NodeInventory,
  NotifyChannelUpsertRequest,
  NotifyChannelView,
  NotifyRuleUpsertRequest,
  NotifyRuleView,
  NotifyTestRequest,
  OIDCProviderTestResult,
  OIDCProviderUpsertRequest,
  OIDCProviderView,
  PluginInstallationView,
  PluginLifecycleStatus,
  PluginTrustView,
  PluginVerifyResponse,
  PluginView,
  Principal,
  PublishingRecordList,
  RenewalReminderFire,
  SSHGuardPlanRequest,
  SSHGuardPlanResponse,
  SSOProvider,
  StaticObject,
  StepUpResponse,
  StorageAccess,
  StorageBinding,
  StorageBucket,
  StorageKind,
  StorageTokenCreateResponse,
  StorageTokenView,
  SubscriptionShareCreateRequest,
  SubscriptionShareUpdateRequest,
  SubscriptionShareView,
  TOTPEnrollResponse,
  TaskResult,
  TaskScriptRevealResponse,
  TaskView,
  TerminalEventsResponse,
  TerminalSession,
  TokenCreateRequest,
  TokenCreateResponse,
  TokenView,
  TraceConnectionsResponse,
  TraceHopsResponse,
  TraceLinesResponse,
  TracePolicy,
  TracePolicyResponse,
  TracePolicyUpsertRequest,
  TraceSession,
  TraceSessionCreateRequest,
  TraceSessionsResponse,
  TunnelUpsertRequest,
  TunnelView,
  UserCreateRequest,
  UserUpdateRequest,
  UserView,
  WebAuthnCredentialResponse,
  WebAuthnCredentialsResponse,
  WebAuthnLoginBeginResponse,
  WebAuthnRegisterBeginResponse,
  WorkerRunResponse,
  WorkerScript,
} from "./types";

export * from "./types";
export { ApiError, setCsrfToken, getCsrfToken } from "./client";

export const API_ERROR_APPROVAL_STALE = "approval_stale";
export const API_ERROR_AGENT_UPDATE_NOOP = "agent_update_noop";
export const APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED = "agent_update_policy_changed";

type ApprovalFreshnessFields = Pick<ApprovalView, "plugin" | "status" | "stale" | "stale_code" | "reason">;

export function isStaleAgentUpdateApprovalView(approval?: ApprovalFreshnessFields): boolean {
  if (!approval || approval.plugin !== "agentupdate") return false;
  if (approval.stale || approval.stale_code === APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED) return true;
  const reason = approval.reason?.toLowerCase() ?? "";
  return (
    reason.includes("re-plan") ||
    reason.includes("replan") ||
    (reason.includes("policy changed") && reason.includes("approval"))
  );
}

export function isActionablePendingApproval(approval?: ApprovalFreshnessFields): boolean {
  return approval?.status === "pending" && !isStaleAgentUpdateApprovalView(approval);
}

export function isApprovalStaleError(error: unknown): error is ApiError {
  if (error instanceof ApiError) {
    return (
      error.code === API_ERROR_APPROVAL_STALE ||
      (error.status === 409 && error.message.toLowerCase().includes("re-plan"))
    );
  }
  return error instanceof Error && error.message.toLowerCase().includes("re-plan");
}

export function isAgentUpdateNoopError(error: unknown): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  if (error.code === API_ERROR_AGENT_UPDATE_NOOP) return true;
  // Compatibility with servers released before the stable machine code.
  return (
    error.status === 409 &&
    error.code === "bad_request" &&
    error.message.toLowerCase().includes("target version")
  );
}

/** Typed surface over the lattice-server JSON API, grouped by feature domain. */
export const api = {
  auth: {
    me: () => http.get<Principal>("/api/me"),
    login: (username: string, password: string) =>
      http.post<LoginResponse>("/api/login", { username, password }),
    loginTotp: (challenge_id: string, code?: string, recovery_code?: string) =>
      http.post<LoginResponse>("/api/login/totp", { challenge_id, code, recovery_code }),
    // Usernameless (discoverable) passkey login. begin returns the assertion
    // options; the browser produces a serialized assertion that finish verifies,
    // issuing the same session the password+TOTP path does.
    webauthnLoginBegin: () =>
      http.post<WebAuthnLoginBeginResponse>("/api/auth/webauthn/login/begin", {}),
    webauthnLoginFinish: (challenge_id: string, credential: AuthenticationResponseJSON) =>
      http.post<LoginResponse>("/api/auth/webauthn/login/finish", { challenge_id, credential }),
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

  security: {
    stepUp: (code: string) => http.post<StepUpResponse>("/api/security/step-up", { code }),
    stepUpWebAuthnBegin: () =>
      http.post<WebAuthnLoginBeginResponse>("/api/security/step-up/webauthn/begin", {}),
    stepUpWebAuthnFinish: (challenge_id: string, credential: AuthenticationResponseJSON) =>
      http.post<StepUpResponse>("/api/security/step-up/webauthn/finish", { challenge_id, credential }),
    // Passkey (WebAuthn) management for the current operator. Registering and
    // deleting a login-capable credential require a fresh step-up grant when the
    // account has TOTP enrolled (server-enforced); rename does not.
    webauthn: {
      list: () =>
        http.get<WebAuthnCredentialsResponse>("/api/security/webauthn/credentials"),
      registerBegin: (step_up_grant?: string) =>
        http.post<WebAuthnRegisterBeginResponse>(
          "/api/security/webauthn/register/begin",
          step_up_grant ? { step_up_grant } : {},
        ),
      registerFinish: (input: {
        challenge_id: string;
        name?: string;
        credential: RegistrationResponseJSON;
        step_up_grant?: string;
      }) =>
        http.post<WebAuthnCredentialResponse>("/api/security/webauthn/register/finish", input),
      rename: (id: string, name: string) =>
        http.post<WebAuthnCredentialResponse>("/api/security/webauthn/credentials/rename", {
          id,
          name,
        }),
      delete: (id: string, step_up_grant?: string) =>
        http.post<{ ok: boolean }>(
          "/api/security/webauthn/credentials/delete",
          step_up_grant ? { id, step_up_grant } : { id },
        ),
    },
  },

  // Fleet-wide capability policy: which gates are live, and what turning one
  // on would refuse right now.
  capabilities: {
    list: () => http.get<{ capabilities: CapabilityImpact[] }>("/api/capabilities"),
    setEnforced: (capability: string, enforced: boolean) =>
      http.post<CapabilityImpact>("/api/capabilities", { capability, enforced }),
  },
  nodes: {
    list: () => http.get<{ nodes: Node[] } | Node[]>("/api/nodes"),
    enrollToken: (input: {
      node_id?: string;
      name: string;
      comment?: string;
      tags?: string[];
      role?: string;
      agent_source_allowlist?: string[];
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
    // Edit a node's operator-owned identity and agent source policy after enrollment.
    // Mirrors `disable`: POST + CSRF + typed-error handling via `http`.
    // Omitting agent_source_allowlist preserves the existing source policy;
    // omitting inventory preserves the stored inventory metadata.
    update: (input: {
      node_id: string;
      name?: string;
      role?: string;
      comment?: string;
      tags?: string[];
      agent_source_allowlist?: string[];
      inventory?: NodeInventory;
    }) =>
      http.post<{
        ok: boolean;
        name: string;
        role: string;
        comment?: string;
        tags: string[];
        agent_source_allowlist?: string[] | null;
        inventory?: NodeInventory | null;
      }>(
        "/api/nodes/update",
        input,
      ),
    // Suspected duplicate nodes (same machine enrolled twice): clustered by
    // wireguard key / public+internal IP pair / host fingerprint. Never public
    // IP alone (NAT hosts share it). Detection only; the operator decides.
    // Which capabilities an operator has allowed to act on which nodes.
    // Separate from role/tags/groups (what a node is) and from agent_runtime
    // (what the agent can do right now): a node can be perfectly capable and
    // still be one you have decided to leave alone.
    capabilities: () =>
      http.get<{ capabilities: NodeCapability[]; known: KnownCapability[] }>("/api/nodes/capabilities"),
    // For one node: the effective answer per capability, including the ones
    // allowed by the node's own configuration rather than by an explicit
    // enrolment. That distinction is invisible in the record list above.
    nodeCapabilities: (node_id: string) =>
      http.get<{ node_id: string; effective: NodeCapabilityEffective[] }>(
        `/api/nodes/capabilities?node_id=${encodeURIComponent(node_id)}`,
      ),
    // An empty state clears the record, returning the node to the capability's
    // default. A reason is required to exclude.
    setCapability: (input: {
      node_id: string;
      capability: string;
      state: "enrolled" | "excluded" | "";
      reason?: string;
    }) => http.post<NodeCapability>("/api/nodes/capabilities", input),
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
    // One node's tasks, filtered by the server. The unfiltered list is fine for
    // a fleet-wide screen but grows with the fleet, and a node page only ever
    // wants its own rows.
    listForNode: (node_id: string, limit = 50) =>
      http.get<{ tasks: TaskView[] } | TaskView[]>("/api/tasks", { node_id, limit }),
    results: (params?: { task_id?: string; node_id?: string; limit?: number; offset?: number }) =>
      http.get<{ results: TaskResult[] } | TaskResult[]>("/api/task-results", params as Record<string, unknown>),
    revealScript: (id: string, step_up_grant: string) =>
      http.post<TaskScriptRevealResponse>("/api/tasks/reveal-script", { id, step_up_grant }),
    create: (input: {
      targets: string[];
      interpreter: string;
      script: string;
      timeout_sec?: number;
      output_limit?: number;
      // Confines the task to nodes in scope for this capability. Narrows only:
      // it can never reach a node the operator could not already target.
      capability?: string;
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
    list: (options?: { include_dismissed?: boolean }) =>
      http.get<{ approvals: ApprovalView[] } | ApprovalView[]>("/api/network/approvals", options),
    approve: (approval_id: string, queue_apply: boolean, plan_sha256?: string) =>
      http.post<void>("/api/network/approvals/approve", {
        approval_id,
        queue_apply,
        plan_sha256,
      }),
    reject: (approval_id: string) =>
      http.post<ApprovalView>("/api/network/approvals/reject", {
        approval_id,
      }),
    dismiss: (approval_id: string) =>
      http.post<ApprovalView>("/api/network/approvals/dismiss", {
        approval_id,
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
    revealLink: (id: string, kind: "console" | "detail", step_up_grant: string) =>
      http.post<MachineLinkRevealResponse>("/api/machines/reveal-link", { id, kind, step_up_grant }),
  },

  machineVendors: {
    list: () => http.get<{ vendors: MachineVendorView[] } | MachineVendorView[]>("/api/machine-vendors"),
    upsert: (input: MachineVendorInput) =>
      http.post<{ vendor: MachineVendorView }>("/api/machine-vendors", input),
    delete: (id: string) => http.post<{ ok: boolean }>("/api/machine-vendors/delete", { id }),
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
    verify: () => http.get<AuditVerifyResponse>("/api/audit/verify"),
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

  // SSH Guard is two approvals, not one. `plan` arms the hardening together
  // with an automatic revert; `confirm` cancels that revert and is meant to be
  // pressed only after a fresh connection over the new path has produced a
  // shell. Neither call changes a node on its own: both mint an approval.
  sshGuard: {
    plan: (input: SSHGuardPlanRequest) =>
      http.post<SSHGuardPlanResponse>("/api/sshguard/plan", input as unknown as Record<string, unknown>),
    confirm: (node_id: string) =>
      http.post<{ approval: ApprovalView }>("/api/sshguard/confirm", { node_id }),
  },

  ddns: {
    list: () => http.get<DDNSView[]>("/api/ddns"),
    // One endpoint serves both: an id in the body edits that profile, no id
    // creates one. `create` stays as the explicit no-id spelling.
    save: (input: DDNSUpsertRequest) => http.post<DDNSView>("/api/ddns", input),
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

  plugins: {
    list: () => http.get<PluginView[]>("/api/plugins"),
    contributions: (signal?: AbortSignal) =>
      http.get<PluginView[]>("/api/plugin-contributions", undefined, { signal }),
    trust: (signal?: AbortSignal) =>
      http.get<PluginTrustView>("/api/plugin-trust", undefined, { signal }),
    lifecycle: () => http.get<PluginInstallationView[]>("/api/plugins/lifecycle"),
    setLifecycle: (id: string, status: PluginLifecycleStatus) =>
      http.post<PluginInstallationView>("/api/plugins/lifecycle", { id, status }),
    verify: (manifest: unknown, artifact_base64: string) =>
      http.post<PluginVerifyResponse>("/api/plugins/verify", { manifest, artifact_base64 }),
    // Dashboard→plugin gateway (design-10). Calls a plugin's declared interface
    // method through the capability/scope-gated server endpoint and returns the
    // raw JSON the method produced. The server validates that the plugin is
    // active and declares (service, method) and checks the interface's scopes.
    call: <T = unknown>(
      id: string,
      service: string,
      method: string,
      payload?: unknown,
      signal?: AbortSignal,
    ) => http.post<T>("/api/plugins/call", { id, service, method, payload }, { signal }),
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

  publishing: {
    /**
     * Every published route the caller may see, across origins. The server
     * filters per origin on that origin's own read scope, so this cannot show a
     * route the per-origin API would have refused to list.
     */
    records: () => http.get<PublishingRecordList>("/api/publishing/records"),
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

  // sing-box connection trace. Reads take log:read, writes take log:admin, and
  // every node-scoped endpoint is additionally filtered by the caller's node
  // whitelist on the server.
  //
  // Each read takes an optional AbortSignal, and the live tail must pass one:
  // the client holds a 750ms GET cache keyed on the path, so a 2s poll that
  // omits the signal would be served the same page it already has and a
  // running capture would look frozen.
  trace: {
    connections: (params: Record<string, string | number>, opts?: RequestOptions) =>
      http.get<TraceConnectionsResponse>("/api/trace/connections", params, opts),
    sessions: (opts?: RequestOptions) =>
      http.get<TraceSessionsResponse>("/api/trace/sessions", undefined, opts),
    startSession: (input: TraceSessionCreateRequest) =>
      http.post<TraceSession>("/api/trace/sessions", input),
    stopSession: (id: string) => http.post<TraceSession>("/api/trace/sessions/stop", { id }),
    lines: (
      params: { session_id: string; after_seq?: number; limit?: number },
      opts?: RequestOptions,
    ) => http.get<TraceLinesResponse>("/api/trace/lines", params as Record<string, unknown>, opts),
    policy: (node_id?: string, opts?: RequestOptions) =>
      http.get<TracePolicyResponse>("/api/trace/policy", node_id ? { node_id } : undefined, opts),
    setPolicy: (input: TracePolicyUpsertRequest) =>
      http.post<TracePolicy>("/api/trace/policy", input),
    hops: (
      params: { node_id: string; core_generation: number; log_id: number; started_at?: string },
      opts?: RequestOptions,
    ) => http.get<TraceHopsResponse>("/api/trace/hops", params as Record<string, unknown>, opts),
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
    releases: () => http.get<AgentReleaseInfo>("/api/nodes/agent-updates/releases"),
    upsert: (input: AgentUpdatePolicyUpsertRequest) =>
      http.post<AgentUpdatePolicy>("/api/nodes/agent-updates", input),
    delete: (node_id: string) =>
      http.post<{ ok: boolean }>("/api/nodes/agent-updates/delete", { node_id }),
    plan: (node_id: string, force?: boolean) =>
      http.post<ApprovalView>("/api/nodes/agent-updates/plan", { node_id, force }),
    artifacts: () =>
      http.get<AgentArtifactListing>("/api/nodes/agent-updates/artifacts"),
    importArtifact: (input: AgentArtifactRequest) =>
      http.post<AgentArtifactView>("/api/nodes/agent-updates/artifacts/import", input),
    deleteArtifact: (input: AgentArtifactRequest) =>
      http.post<{ deleted: boolean; sha256: string }>(
        "/api/nodes/agent-updates/artifacts/delete",
        input,
      ),
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
    delete: (token_id: string) => http.post<{ ok: boolean }>("/api/tokens/delete", { token_id }),
  },

  subscriptionShares: {
    list: () => http.get<SubscriptionShareView[]>("/api/subscription-shares"),
    create: (body: SubscriptionShareCreateRequest) =>
      http.post<SubscriptionShareView>("/api/subscription-shares", body),
    // Changes a share without minting a new URL. Expiry used to be settable
    // only at creation, so extending a share meant deleting it and handing out
    // a new link -- the one thing a share exists to avoid. Rotation stays a
    // separate action because it does invalidate the URL.
    update: (id: string, body: SubscriptionShareUpdateRequest) =>
      http.patch<SubscriptionShareView>(
        `/api/subscription-shares/${encodeURIComponent(id)}`,
        body,
      ),
    // Rotation invalidates the old URL immediately and drops the cached output
    // for that share, and returns the share carrying its new token. So the
    // caller replaces the row it has rather than refetching the whole list.
    rotate: (id: string) =>
      http.post<SubscriptionShareView>(
        `/api/subscription-shares/${encodeURIComponent(id)}/rotate`,
        {},
      ),
    refresh: (id: string) =>
      http.post<unknown>(`/api/subscription-shares/${encodeURIComponent(id)}/refresh`, {}),
    remove: (id: string) => http.del<void>(`/api/subscription-shares/${encodeURIComponent(id)}`),
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
