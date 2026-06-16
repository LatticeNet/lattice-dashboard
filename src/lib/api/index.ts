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

  health: () => http.get<{ status: string }>("/api/health"),
};

/** Normalize list endpoints that may return either a bare array or {key:[]}. */
export function unwrap<T>(res: T[] | Record<string, T[]>, key: string): T[] {
  if (Array.isArray(res)) return res;
  const v = (res as Record<string, T[]>)[key];
  return Array.isArray(v) ? v : [];
}
