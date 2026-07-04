<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  ExternalLink,
  Info,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Waypoints,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type Line,
  type LineGroup,
  type LinesListResponse,
  type Node,
  type ProxyManagedAddRequest,
  type ProxyManagedLineRevealResponse,
  type TaskResult,
  type VPNCredentialRevealResponse,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const auth = useAuthStore();
const { t } = useI18n();
const canAdmin = computed(() => auth.can("proxy:admin"));
const canRunTask = computed(() => auth.can("task:run"));
const adminReason = computed(() => t("lines.adminReason"));

type VpnUserOption = {
  id: string;
  email: string;
  name?: string;
  enabled: boolean;
  bindings?: {
    line_hash_id: string;
    enabled: boolean;
    flow_override?: string;
  }[];
};

// Real Badge variant tokens (mirrors src/components/ui/badge/badgeVariants.ts).
type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "info";

// The Lines read-model is owned by the vpn-core plugin and reached ONLY through
// the design-10 dashboard→plugin gateway (never a bespoke /api/proxy route).
// A 4xx here (plugin inactive / missing scope) is surfaced gracefully by
// DataState — the page never crashes.
const linesQuery = useAsyncData(
  () =>
    api.plugins.call<LinesListResponse>(
      "latticenet.vpn-core",
      "latticenet.vpn-core/lines",
      "list",
    ),
  { pollInterval: 15000 },
);

const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 30000,
});
const usersQuery = useAsyncData(
  () =>
    api.plugins.call<{ users: VpnUserOption[]; count: number }>(
      "latticenet.vpn-core",
      "latticenet.vpn-core/users",
      "list",
    ),
  { pollInterval: 30000 },
);
const taskResultsQuery = useAsyncData<TaskResult[] | undefined>(
  () => api.tasks.results().then((r) => unwrap(r, "results")),
  { pollInterval: 3000 },
);

const groups = computed<LineGroup[]>(() => linesQuery.data.value?.groups ?? []);
const sortedGroups = computed<LineGroup[]>(() =>
  [...groups.value].sort((a, b) =>
    (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id),
  ),
);
const GROUP_PREVIEW_LIMIT = 8;
const showAllGroups = ref(false);
const prioritizedGroups = computed<LineGroup[]>(() =>
  [...sortedGroups.value].sort((a, b) => {
    const aError = a.lines.some((line) => line.status === "error" || line.last_error);
    const bError = b.lines.some((line) => line.status === "error" || line.last_error);
    if (aError !== bError) return aError ? -1 : 1;
    return (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id);
  }),
);
const visibleGroups = computed<LineGroup[]>(() =>
  showAllGroups.value ? prioritizedGroups.value : prioritizedGroups.value.slice(0, GROUP_PREVIEW_LIMIT),
);
const hiddenGroupCount = computed(() => Math.max(0, prioritizedGroups.value.length - visibleGroups.value.length));
const allLines = computed<Line[]>(() => groups.value.flatMap((g) => g.lines ?? []));
const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);
const selectableNodes = computed<Node[]>(() =>
  [...nodes.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);
const allVpnUsers = computed<VpnUserOption[]>(() => usersQuery.data.value?.users ?? []);
const vpnUsers = computed<VpnUserOption[]>(() => allVpnUsers.value.filter((u) => u.enabled));
const taskResults = computed<TaskResult[]>(() => taskResultsQuery.data.value ?? []);

type TopologyNode = {
  id: string;
  name: string;
  lines: number;
  errors: number;
};

type TopologyGraphNode = TopologyNode & {
  x: number;
  y: number;
};

type TopologyGraphEdge = {
  id: string;
  source: TopologyGraphNode;
  target: TopologyGraphNode;
  label: string;
};

const topologyNodes = computed<TopologyNode[]>(() =>
  prioritizedGroups.value.slice(0, 16).map((group) => ({
    id: group.node_id,
    name: group.node_name || group.node_id,
    lines: group.lines.length,
    errors: group.lines.filter((line) => line.status === "error" || line.last_error).length,
  })),
);

const topologyEdges = computed(() => {
  const linesByHash = new Map(allLines.value.map((line) => [line.line_hash_id, line]));
  return allLines.value.flatMap((line) =>
    (line.jump_edges ?? []).map((targetHash) => ({
      source: line,
      targetHash,
      target: linesByHash.get(targetHash),
    })),
  ).slice(0, 24);
});

const topologyGraphNodes = computed<TopologyGraphNode[]>(() => {
  const items = topologyNodes.value.slice(0, 12);
  if (!items.length) return [];
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(items.length))));
  const rows = Math.ceil(items.length / cols);
  const left = 86;
  const top = 56;
  const width = 788;
  const height = 150;
  return items.map((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      ...node,
      x: cols === 1 ? 480 : left + (width * col) / Math.max(1, cols - 1),
      y: rows === 1 ? 130 : top + (height * row) / Math.max(1, rows - 1),
    };
  });
});

const topologyGraphEdges = computed<TopologyGraphEdge[]>(() => {
  const nodesByID = new Map(topologyGraphNodes.value.map((node) => [node.id, node]));
  return topologyEdges.value.flatMap((edge) => {
    const source = nodesByID.get(edge.source.node_id);
    const target = edge.target?.node_id ? nodesByID.get(edge.target.node_id) : undefined;
    if (!source || !target) return [];
    return [{
      id: `${edge.source.line_hash_id}:${edge.targetHash}`,
      source,
      target,
      label: `${shortLineID(edge.source.line_hash_id)} -> ${shortLineID(edge.targetHash)}`,
    }];
  });
});

function shortLineID(id?: string): string {
  if (!id) return "—";
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

function shortNodeLabel(id?: string): string {
  if (!id) return "—";
  const node = nodes.value.find((n) => n.id === id);
  return node?.name || id;
}

// ── Interactive 2FA step-up ─────────────────────────────────────────────────
const stepUpOpen = ref(false);
const stepUpCode = ref("");
const stepUpError = ref("");
const stepUpPending = ref(false);
const stepUpGrant = ref("");
const stepUpGrantExpiresAt = ref(0);
let stepUpResolve: ((grant: string) => void) | undefined;
let stepUpReject: ((error: Error) => void) | undefined;

function cachedStepUpGrant(): string {
  if (stepUpGrant.value && Date.now() < stepUpGrantExpiresAt.value - 1000) return stepUpGrant.value;
  return "";
}

function requestStepUp(): Promise<string> {
  const cached = cachedStepUpGrant();
  if (cached) return Promise.resolve(cached);
  stepUpCode.value = "";
  stepUpError.value = "";
  stepUpOpen.value = true;
  return new Promise((resolve, reject) => {
    stepUpResolve = resolve;
    stepUpReject = reject;
  });
}

async function submitStepUp() {
  const code = stepUpCode.value.trim();
  if (!code || stepUpPending.value) return;
  stepUpPending.value = true;
  stepUpError.value = "";
  let ok = false;
  try {
    const result = await api.security.stepUp(code);
    stepUpGrant.value = result.grant;
    stepUpGrantExpiresAt.value = Date.parse(result.expires_at);
    stepUpOpen.value = false;
    stepUpResolve?.(result.grant);
    ok = true;
  } catch (error) {
    stepUpError.value = error instanceof Error ? error.message : t("lines.stepUpFailed");
  } finally {
    stepUpPending.value = false;
    if (ok) {
      stepUpResolve = undefined;
      stepUpReject = undefined;
    }
  }
}

function cancelStepUp() {
  stepUpOpen.value = false;
  stepUpReject?.(new Error(t("lines.stepUpRequired")));
  stepUpResolve = undefined;
  stepUpReject = undefined;
}

// ── KPI strip ────────────────────────────────────────────────────────────────
const totalLines = computed(() => linesQuery.data.value?.count ?? allLines.value.length);
const nodeCount = computed(() => groups.value.length);
const managedCount = computed(() => allLines.value.filter((l) => l.source === "managed").length);
const errorCount = computed(() => allLines.value.filter((l) => l.status === "error").length);
const isEmpty = computed(() => allLines.value.length === 0);

// ── Source / status visual treatment ──────────────────────────────────────────
function sourceVariant(source: string): BadgeVariant {
  if (source === "managed") return "default"; // solid / primary
  if (source === "imported") return "secondary";
  return "outline"; // discovered (+ anything unknown) → muted outline
}
function sourceLabel(source: string): string {
  switch (source) {
    case "managed":
      return t("lines.sourceManaged");
    case "discovered":
      return t("lines.sourceDiscovered");
    case "imported":
      return t("lines.sourceImported");
    default:
      return source || "—";
  }
}
function statusVariant(status?: string): BadgeVariant {
  switch (status) {
    case "ok":
      return "success";
    case "pending":
      return "warning";
    case "error":
      return "destructive";
    default:
      return "secondary"; // stale + unknown
  }
}
function statusLabel(status?: string): string {
  switch (status) {
    case "ok":
      return t("lines.statusOk");
    case "pending":
      return t("lines.statusPending");
    case "error":
      return t("lines.statusError");
    case "stale":
      return t("lines.statusStale");
    default:
      return status || t("lines.statusUnknown");
  }
}

type ListenExposure = "public" | "loopback" | "bound" | "unknown";

type ListenPresentation = {
  label: string;
  exposure: ListenExposure;
  exposureLabel: string;
  badgeVariant: BadgeVariant;
};

function endpointLabel(host: string, port?: number): string {
  if (!port) return host;
  const wrapped = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${wrapped}:${port}`;
}

function listenPresentation(line: Pick<Line, "listen_host" | "listen_port">): ListenPresentation {
  const rawHost = (line.listen_host ?? "").trim();
  const port = line.listen_port || undefined;
  if (!rawHost && !port) {
    return {
      label: "—",
      exposure: "unknown",
      exposureLabel: t("lines.listenUnknown"),
      badgeVariant: "secondary",
    };
  }

  const lowerHost = rawHost.toLowerCase();
  if (!rawHost || rawHost === "::" || rawHost === "0.0.0.0" || rawHost === "*") {
    return {
      label: endpointLabel("0.0.0.0", port),
      exposure: "public",
      exposureLabel: t("lines.listenAllInterfaces"),
      badgeVariant: "info",
    };
  }
  if (lowerHost === "127.0.0.1" || lowerHost === "::1" || lowerHost === "localhost") {
    return {
      label: endpointLabel(lowerHost === "::1" ? "::1" : "127.0.0.1", port),
      exposure: "loopback",
      exposureLabel: t("lines.listenLoopback"),
      badgeVariant: "secondary",
    };
  }
  return {
    label: endpointLabel(rawHost, port),
    exposure: "bound",
    exposureLabel: t("lines.listenBound"),
    badgeVariant: "outline",
  };
}

type OutboundPresentation = {
  label: string;
  detail: string;
  relayed: boolean;
};

function outboundPresentation(ref?: string): OutboundPresentation {
  const raw = (ref ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === "direct" || lower.startsWith("public_key_")) {
    return {
      label: t("lines.outboundDirect"),
      detail: raw || "direct",
      relayed: false,
    };
  }
  return {
    label: raw,
    detail: raw,
    relayed: true,
  };
}

const PROTOCOLS: { value: string; label: string }[] = [
  { value: "reality", label: "reality" },
  { value: "vless", label: "vless" },
  { value: "vmess", label: "vmess" },
  { value: "trojan", label: "trojan" },
  { value: "hy2", label: "hysteria2 (hy2)" },
  { value: "ss", label: "shadowsocks (ss)" },
  { value: "tuic", label: "tuic" },
  { value: "anytls", label: "anytls" },
  { value: "socks", label: "socks" },
];

// ── Add / delete management bridge ───────────────────────────────────────────
const addOpen = ref(false);
const addSaving = ref(false);
const addAttempted = ref(false);
const addForm = reactive({
  node_id: "",
  protocol: "",
  port: "",
  arg1: "",
  arg2: "",
  user_ids: [] as string[],
});

type PendingBindPlan = {
  task_id: string;
  node_id: string;
  protocol: string;
  port: number;
  user_ids: string[];
  status: "pending" | "binding" | "bound" | "failed";
  error?: string;
};

const pendingBinds = ref<PendingBindPlan[]>([]);

function openAdd(nodeId = "") {
  if (!canAdmin.value) return;
  addAttempted.value = false;
  addForm.node_id = nodeId;
  addForm.protocol = "";
  addForm.port = "";
  addForm.arg1 = "";
  addForm.arg2 = "";
  addForm.user_ids = [];
  addOpen.value = true;
}

const addNodeValid = computed(() => addForm.node_id.trim().length > 0);
const addProtocolValid = computed(() => addForm.protocol.trim().length > 0);
const addPortNumber = computed(() => Number(addForm.port));
const addPortValid = computed(() =>
  addForm.port.trim().length > 0 &&
  Number.isInteger(addPortNumber.value) &&
  addPortNumber.value >= 1 &&
  addPortNumber.value <= 65535,
);
const addFormValid = computed(() => addNodeValid.value && addProtocolValid.value && addPortValid.value);
const addNodeError = computed(() =>
  addAttempted.value && !addNodeValid.value ? t("lines.errorNodeRequired") : "",
);
const addProtocolError = computed(() =>
  addAttempted.value && !addProtocolValid.value ? t("lines.errorProtocolRequired") : "",
);
const addPortError = computed(() =>
  addAttempted.value && !addPortValid.value ? t("lines.errorPortRequired") : "",
);

function userLabel(id: string): string {
  const u = allVpnUsers.value.find((x) => x.id === id);
  if (!u) return id;
  return u.name ? `${u.email} · ${u.name}` : u.email;
}

function pendingStatusLabel(status: PendingBindPlan["status"]): string {
  switch (status) {
    case "binding":
      return t("lines.pendingStatusBinding");
    case "bound":
      return t("lines.pendingStatusBound");
    case "failed":
      return t("lines.pendingStatusFailed");
    default:
      return t("lines.pendingStatusPending");
  }
}

async function submitAdd() {
  addAttempted.value = true;
  if (!addFormValid.value || addSaving.value) return;

  const input: ProxyManagedAddRequest = {
    node_id: addForm.node_id,
    protocol: addForm.protocol,
    port: addPortNumber.value,
  };
  const args = [addForm.arg1, addForm.arg2].map((a) => a.trim()).filter(Boolean);
  if (args.length) input.args = args;

  addSaving.value = true;
  try {
    const res = await api.proxy.managed.add(input);
    if (addForm.user_ids.length) {
      pendingBinds.value.unshift({
        task_id: res.task_id,
        node_id: addForm.node_id,
        protocol: addForm.protocol,
        port: addPortNumber.value,
        user_ids: [...addForm.user_ids],
        status: "pending",
      });
    }
    toast.success(t("lines.toastAddQueued", { id: res.task_id }));
    addOpen.value = false;
    // Queue a follow-up probe; task ordering on the node keeps this behind the add
    // in normal operation, and the UI still treats discovery as the source of truth.
    try {
      await api.proxy.managed.probe({ node_id: addForm.node_id });
    } catch {
      // Non-blocking. Periodic discovery can still surface the line.
    }
    void linesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("lines.toastAddFailed"));
  } finally {
    addSaving.value = false;
  }
}

async function resolvePendingBinds() {
  for (const plan of pendingBinds.value) {
    if (plan.status !== "pending") continue;
    const line = allLines.value.find(
      (l) =>
        l.node_id === plan.node_id &&
        (l.type || "").toLowerCase() === plan.protocol.toLowerCase() &&
        l.listen_port === plan.port,
    );
    if (!line?.line_hash_id) continue;
    plan.status = "binding";
    try {
      for (const userID of plan.user_ids) {
        await api.plugins.call("latticenet.vpn-core", "latticenet.vpn-core/users-admin", "bind", {
          user_id: userID,
          line_hash_id: line.line_hash_id,
        });
      }
      plan.status = "bound";
      toast.success(t("lines.toastBindComplete", { count: plan.user_ids.length }));
      void usersQuery.refresh();
    } catch (error) {
      plan.status = "failed";
      plan.error = error instanceof Error ? error.message : t("lines.toastBindFailed");
      toast.error(plan.error);
    }
  }
}

watch(allLines, () => {
  void resolvePendingBinds();
});

const deleteOpen = ref(false);
const deleteTarget = ref<Line | null>(null);
const deleting = ref(false);
const conncheckURL = ref("https://www.cloudflare.com/cdn-cgi/trace");
const connchecking = ref(false);
const conncheckTaskID = ref("");
const revealedLine = ref<ProxyManagedLineRevealResponse | null>(null);
const revealingLine = ref(false);
const revealedUsers = ref<Record<string, VPNCredentialRevealResponse>>({});
const revealingUserID = ref("");

function canDeleteLine(line: Line | null): boolean {
  return !!line && line.source === "discovered" && !!(line.name || line.tag);
}

function canConncheckLine(line: Line | null): boolean {
  return !!line && line.source === "discovered" && !!(line.name || line.tag);
}

function askDeleteLine(line: Line | null) {
  if (!canAdmin.value || !canDeleteLine(line)) return;
  deleteTarget.value = line;
  deleteOpen.value = true;
}

async function confirmDeleteLine() {
  const line = deleteTarget.value;
  const name = line?.name || line?.tag || "";
  if (!line || !name || deleting.value) return;
  deleting.value = true;
  try {
    const grant = await requestStepUp();
    const res = await api.proxy.managed.delete({ node_id: line.node_id, name, step_up_grant: grant });
    toast.success(t("lines.toastDeleteQueued", { id: res.task_id }));
    deleteOpen.value = false;
    detailOpen.value = false;
    try {
      await api.proxy.managed.probe({ node_id: line.node_id });
    } catch {
      // Non-blocking; periodic discovery can update the view.
    }
    void linesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("lines.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

async function runConncheck(line: Line | null) {
  const name = line?.name || line?.tag || "";
  if (!line || !name || connchecking.value || !canRunTask.value) return;
  connchecking.value = true;
  try {
    const input = {
      node_id: line.node_id,
      name,
      url: conncheckURL.value.trim() || undefined,
      timeout_sec: 10,
    };
    const res = await api.proxy.managed.conncheck(input);
    conncheckTaskID.value = res.task_id;
    toast.success(t("lines.conncheckQueued", { id: res.task_id }));
    void taskResultsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("lines.conncheckFailed"));
  } finally {
    connchecking.value = false;
  }
}

const conncheckResult = computed(() =>
  conncheckTaskID.value
    ? taskResults.value.find((result) => result.task_id === conncheckTaskID.value && result.node_id === selected.value?.node_id)
    : undefined,
);

const conncheckPayload = computed<Record<string, unknown> | undefined>(() => {
  const stdout = conncheckResult.value?.stdout?.trim();
  if (!stdout) return undefined;
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
});

async function revealLineConnection() {
  const line = selected.value;
  if (!line?.line_hash_id || revealingLine.value || !canAdmin.value) return;
  revealingLine.value = true;
  try {
    const grant = await requestStepUp();
    revealedLine.value = await api.proxy.managed.revealLine({
      node_id: line.node_id,
      line_hash_id: line.line_hash_id,
      step_up_grant: grant,
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("lines.revealFailed"));
  } finally {
    revealingLine.value = false;
  }
}

async function revealUserCredentials(userID: string) {
  if (!userID || revealingUserID.value || !canAdmin.value) return;
  revealingUserID.value = userID;
  try {
    const grant = await requestStepUp();
    revealedUsers.value = {
      ...revealedUsers.value,
      [userID]: await api.proxy.revealUserCredentials(userID, grant),
    };
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("lines.revealFailed"));
  } finally {
    revealingUserID.value = "";
  }
}

function revealedCredentialText(userID: string): string {
  const revealed = revealedUsers.value[userID];
  if (!revealed) return "";
  return JSON.stringify({ credentials: revealed.credentials, sub_id: revealed.sub_id || "" }, null, 2);
}

// ── Detail drawer (the app's modal primitive; no separate Sheet exists) ───────
const selected = ref<Line | null>(null);
const detailOpen = ref(false);
function openDetail(line: Line) {
  selected.value = line;
  resetRosterSelection(line);
  revealedLine.value = null;
  revealedUsers.value = {};
  conncheckTaskID.value = "";
  detailOpen.value = true;
}

const metadataEntries = computed<[string, string][]>(() =>
  selected.value?.metadata ? Object.entries(selected.value.metadata) : [],
);

const rosterSelection = ref<string[]>([]);
const rosterTouched = ref(false);
const rosterSaving = ref(false);
const rosterError = ref("");

function userBoundToLine(user: VpnUserOption, lineHashID: string): boolean {
  return (user.bindings ?? []).some((binding) =>
    binding.line_hash_id === lineHashID && binding.enabled !== false,
  );
}

function currentRosterIDs(lineHashID = selected.value?.line_hash_id ?? ""): string[] {
  if (!lineHashID) return [];
  return allVpnUsers.value
    .filter((user) => userBoundToLine(user, lineHashID))
    .map((user) => user.id)
    .sort();
}

function resetRosterSelection(line = selected.value) {
  rosterSelection.value = currentRosterIDs(line?.line_hash_id ?? "");
  rosterTouched.value = false;
  rosterError.value = "";
}

watch(
  () => [selected.value?.line_hash_id, usersQuery.data.value] as const,
  () => {
    if (!rosterTouched.value) resetRosterSelection();
  },
);

const rosterUsers = computed<VpnUserOption[]>(() => {
  const lineHashID = selected.value?.line_hash_id ?? "";
  const current = new Set(currentRosterIDs(lineHashID));
  return allVpnUsers.value
    .filter((user) => user.enabled || current.has(user.id))
    .sort((a, b) => (a.email || a.id).localeCompare(b.email || b.id));
});

const rosterDirty = computed(() => {
  const current = currentRosterIDs();
  if (current.length !== rosterSelection.value.length) return true;
  const desired = [...rosterSelection.value].sort();
  return current.some((id, idx) => id !== desired[idx]);
});

function rosterChecked(userID: string): boolean {
  return rosterSelection.value.includes(userID);
}

function setRosterChecked(userID: string, checked: boolean) {
  const next = new Set(rosterSelection.value);
  if (checked) next.add(userID);
  else next.delete(userID);
  rosterSelection.value = [...next].sort();
  rosterTouched.value = true;
  rosterError.value = "";
}

function onRosterToggle(userID: string, event: Event) {
  setRosterChecked(userID, (event.target as HTMLInputElement | null)?.checked ?? false);
}

function lineRuntimeUserSyncSupported(line = selected.value): boolean {
  return !!line && line.source === "discovered" && line.core === "sing-box";
}

async function saveRoster(forceRuntimeSync = false) {
  const line = selected.value;
  if (!line?.line_hash_id || rosterSaving.value || !canAdmin.value) return;

  const current = new Set(currentRosterIDs(line.line_hash_id));
  const desired = new Set(rosterSelection.value);
  const runtimeSync = lineRuntimeUserSyncSupported(line);
  const bindIDs = forceRuntimeSync && runtimeSync
    ? [...desired]
    : [...desired].filter((id) => !current.has(id));
  const unbindIDs = forceRuntimeSync && runtimeSync
    ? []
    : [...current].filter((id) => !desired.has(id));
  if (!bindIDs.length && !unbindIDs.length) {
    rosterTouched.value = false;
    return;
  }

  rosterSaving.value = true;
  rosterError.value = "";
  const failures: string[] = [];
  try {
    if (runtimeSync) {
      const res = await api.proxy.managed.users({
        node_id: line.node_id,
        line_hash_id: line.line_hash_id,
        bind_user_ids: bindIDs,
        unbind_user_ids: unbindIDs,
      });
      toast.success(t("lines.rosterSyncQueued", { id: res.task_id }));
      try {
        await api.proxy.managed.probe({ node_id: line.node_id });
      } catch {
        // Non-blocking; periodic discovery can still refresh the runtime user count.
      }
    } else {
      for (const userID of bindIDs) {
        try {
          await api.plugins.call("latticenet.vpn-core", "latticenet.vpn-core/users-admin", "bind", {
            user_id: userID,
            line_hash_id: line.line_hash_id,
          });
        } catch (error) {
          failures.push(`${userLabel(userID)}: ${error instanceof Error ? error.message : t("lines.rosterBindFailed")}`);
        }
      }
      for (const userID of unbindIDs) {
        try {
          await api.plugins.call("latticenet.vpn-core", "latticenet.vpn-core/users-admin", "unbind", {
            user_id: userID,
            line_hash_id: line.line_hash_id,
          });
        } catch (error) {
          failures.push(`${userLabel(userID)}: ${error instanceof Error ? error.message : t("lines.rosterUnbindFailed")}`);
        }
      }
    }
    await usersQuery.refresh();
    await linesQuery.refresh();
    resetRosterSelection(line);
    if (failures.length) {
      rosterError.value = failures.join("\n");
      toast.error(t("lines.rosterPartialFailure", { count: failures.length }));
    } else {
      toast.success(t("lines.rosterSaved"));
    }
  } catch (error) {
    rosterError.value = error instanceof Error ? error.message : t("lines.rosterRuntimeSyncFailed");
    toast.error(rosterError.value);
  } finally {
    rosterSaving.value = false;
  }
}

function syncRosterRuntime() {
  void saveRoster(true);
}

const detailRows = computed<{ label: string; value: string }[]>(() => {
  const l = selected.value;
  if (!l) return [];
  const listen = listenPresentation(l);
  const outbound = outboundPresentation(l.outbound_ref);
  const rows: { label: string; value: string }[] = [
    { label: t("lines.fieldNode"), value: l.node_id },
    { label: t("lines.fieldNodeIdentityUuid"), value: l.node_identity_uuid || "—" },
    { label: t("lines.fieldLineId"), value: l.line_id || "—" },
    { label: t("lines.fieldSource"), value: sourceLabel(l.source) },
    { label: t("lines.fieldCore"), value: l.core || "—" },
    { label: t("lines.fieldName"), value: l.name || "—" },
    { label: t("lines.fieldTag"), value: l.tag || "—" },
    { label: t("lines.fieldType"), value: l.type || "—" },
    { label: t("lines.fieldListen"), value: `${listen.label} · ${listen.exposureLabel}` },
    { label: t("lines.fieldPublic"), value: l.public_host || "—" },
    { label: t("lines.fieldDomain"), value: l.domain || "—" },
    { label: t("lines.fieldOutbound"), value: outbound.relayed ? outbound.label : outbound.detail },
    {
      label: t("lines.fieldUsers"),
      value: l.user_known ? String(l.user_count) : t("lines.usersUnknown"),
    },
    { label: t("lines.fieldStatus"), value: statusLabel(l.status) },
  ];
  if (l.last_error) rows.push({ label: t("lines.fieldLastError"), value: l.last_error });
  return rows;
});
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('lines.title')" :description="$t('lines.description')">
      <template #status>
        <FreshnessLabel :last-updated="linesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="linesQuery.refreshing.value"
          @click="linesQuery.refresh"
        >
          <RefreshCw
            :class="cn('size-4', linesQuery.refreshing.value && 'animate-spin')"
            aria-hidden="true"
          />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="canAdmin"
          size="sm"
          @click="openAdd()"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('lines.addLine') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('lines.kpiLines')" :value="totalLines" :icon="Waypoints" />
      <StatCard :label="$t('lines.kpiNodes')" :value="nodeCount" :icon="Server" />
      <StatCard :label="$t('lines.kpiManaged')" :value="managedCount" :icon="ShieldCheck" tone="success" />
      <StatCard
        :label="$t('lines.kpiErrors')"
        :value="errorCount"
        :icon="TriangleAlert"
        :tone="errorCount > 0 ? 'destructive' : undefined"
      />
    </div>

    <div
      v-if="canAdmin"
      class="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
    >
      <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div class="space-y-0.5">
        <p class="font-medium text-foreground">{{ $t('lines.manageNoteTitle') }}</p>
        <p>{{ $t('lines.manageNoteBody') }}</p>
      </div>
    </div>

    <Card v-if="topologyNodes.length">
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-sm">
          <Waypoints class="size-4 text-primary" aria-hidden="true" />
          {{ $t('lines.topologyTitle') }}
        </CardTitle>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="overflow-x-auto rounded-md border border-border bg-background/60">
          <svg
            viewBox="0 0 960 260"
            role="img"
            :aria-label="$t('lines.topologyTitle')"
            class="block aspect-[48/13] w-full min-w-[720px]"
          >
            <defs>
              <marker id="line-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="var(--primary)" opacity="0.85" />
              </marker>
            </defs>
            <rect width="960" height="260" fill="transparent" />
            <g v-if="topologyGraphEdges.length">
              <line
                v-for="edge in topologyGraphEdges"
                :key="edge.id"
                :x1="edge.source.x"
                :y1="edge.source.y"
                :x2="edge.target.x"
                :y2="edge.target.y"
                stroke="var(--primary)"
                stroke-width="2"
                stroke-opacity="0.65"
                marker-end="url(#line-arrow)"
              />
            </g>
            <g v-else>
              <line
                x1="74"
                y1="226"
                x2="886"
                y2="226"
                stroke="var(--border)"
                stroke-width="1"
                stroke-dasharray="4 6"
              />
              <text x="480" y="232" text-anchor="middle" class="fill-muted-foreground text-[11px]">
                {{ $t('lines.topologyNoEdges') }}
              </text>
            </g>
            <g
              v-for="node in topologyGraphNodes"
              :key="node.id"
              :transform="`translate(${node.x} ${node.y})`"
            >
              <circle
                r="26"
                :fill="node.errors ? 'var(--destructive)' : 'var(--secondary)'"
                :opacity="node.errors ? 0.22 : 0.9"
              />
              <circle
                r="22"
                :stroke="node.errors ? 'var(--destructive)' : 'var(--primary)'"
                stroke-width="1.5"
                fill="var(--card)"
              />
              <text y="-3" text-anchor="middle" class="fill-foreground text-[12px] font-medium">
                {{ node.lines }}
              </text>
              <text y="12" text-anchor="middle" class="fill-muted-foreground text-[9px]">
                {{ $t('lines.topologyNodeLines') }}
              </text>
              <text y="44" text-anchor="middle" class="fill-foreground text-[11px] font-medium">
                {{ shortNodeLabel(node.id) }}
              </text>
              <text y="59" text-anchor="middle" class="fill-muted-foreground text-[9px]">
                {{ shortLineID(node.id) }}
              </text>
            </g>
          </svg>
        </div>
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div
            v-for="node in topologyNodes"
            :key="node.id"
            class="min-w-0 rounded-md border border-border bg-muted/20 px-3 py-2"
          >
            <div class="flex items-center justify-between gap-2">
              <p class="truncate text-sm font-medium" :title="node.name">{{ node.name }}</p>
              <Badge :variant="node.errors ? 'destructive' : 'secondary'">{{ node.lines }}</Badge>
            </div>
            <p class="mt-1 truncate font-mono text-xs text-muted-foreground">{{ node.id }}</p>
          </div>
        </div>
        <div class="rounded-md border border-border bg-background/50 p-3">
          <div v-if="topologyEdges.length" class="space-y-2">
            <div
              v-for="edge in topologyEdges"
              :key="`${edge.source.line_hash_id}:${edge.targetHash}`"
              class="grid gap-2 rounded-md bg-muted/20 px-3 py-2 text-xs md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
            >
              <div class="min-w-0">
                <p class="truncate font-medium">{{ shortNodeLabel(edge.source.node_id) }}</p>
                <p class="truncate font-mono text-muted-foreground">{{ shortLineID(edge.source.line_hash_id) }}</p>
              </div>
              <div class="flex items-center justify-center text-muted-foreground">
                <ExternalLink class="size-4" aria-hidden="true" />
              </div>
              <div class="min-w-0 text-left md:text-right">
                <p class="truncate font-medium">{{ shortNodeLabel(edge.target?.node_id) }}</p>
                <p class="truncate font-mono text-muted-foreground">{{ shortLineID(edge.targetHash) }}</p>
              </div>
            </div>
          </div>
          <p v-else class="text-xs text-muted-foreground">{{ $t('lines.topologyNoEdges') }}</p>
        </div>
      </CardContent>
    </Card>

    <Card v-if="pendingBinds.length">
      <CardHeader>
        <CardTitle class="text-sm">{{ $t('lines.pendingBindingsTitle') }}</CardTitle>
      </CardHeader>
      <CardContent>
        <div class="space-y-2">
          <div
            v-for="plan in pendingBinds"
            :key="plan.task_id"
            class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
          >
            <div class="min-w-0">
              <div class="font-mono">{{ plan.node_id }} · {{ plan.protocol }}:{{ plan.port }}</div>
              <div class="truncate text-muted-foreground">
                {{ $t('lines.pendingBinding', { count: plan.user_ids.length, task: plan.task_id }) }}
              </div>
              <div v-if="plan.error" class="mt-1 break-words text-destructive">{{ plan.error }}</div>
            </div>
            <Badge :variant="plan.status === 'failed' ? 'destructive' : plan.status === 'bound' ? 'success' : 'warning'">
              {{ pendingStatusLabel(plan.status) }}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>

    <DataState
      :loading="linesQuery.loading.value"
      :error="linesQuery.error.value"
      :has-data="linesQuery.data.value !== undefined"
      :is-empty="isEmpty"
      :empty-title="$t('lines.emptyTitle')"
      :empty-description="$t('lines.emptyDescription')"
      @retry="linesQuery.refresh"
    >
      <div class="space-y-3">
        <div
          v-if="hiddenGroupCount > 0 || showAllGroups"
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/25 px-4 py-3 text-sm"
        >
          <div class="text-muted-foreground">
            {{ $t('lines.renderSummary', { shown: visibleGroups.length, total: prioritizedGroups.length }) }}
          </div>
          <Button type="button" variant="outline" size="sm" @click="showAllGroups = !showAllGroups">
            {{ showAllGroups ? $t('lines.showLessGroups') : $t('lines.showAllGroups', { count: hiddenGroupCount }) }}
          </Button>
        </div>

        <div class="columns-1 gap-3 [column-fill:balance] 2xl:columns-2">
        <Card v-for="group in visibleGroups" :key="group.node_id" class="mb-3 break-inside-avoid overflow-hidden">
          <CardHeader class="px-4 py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <CardTitle class="flex items-center gap-2">
                  <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <RouterLink
                    :to="{ name: 'node-detail', params: { id: group.node_id } }"
                    class="inline-flex min-w-0 items-center gap-1 truncate text-sm hover:text-primary hover:underline"
                    :title="$t('lines.viewNode')"
                  >
                    <span class="truncate font-medium">{{ group.node_name || group.node_id }}</span>
                    <ArrowUpRight class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  </RouterLink>
                </CardTitle>
                <div class="font-mono text-xs text-muted-foreground">{{ group.node_id }}</div>
              </div>
              <Badge variant="secondary" class="shrink-0">
                {{ $t('lines.groupLineCount', { count: group.lines.length }, group.lines.length) }}
              </Badge>
              <Button
                v-if="canAdmin"
                size="sm"
                variant="outline"
                @click="openAdd(group.node_id)"
              >
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('lines.addHere') }}
              </Button>
            </div>
          </CardHeader>

          <CardContent class="px-4 pb-4">
            <div class="overflow-x-auto">
              <table class="w-full min-w-[980px] text-sm">
                <thead>
                  <tr class="border-b border-border text-xs text-muted-foreground">
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colSource') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colCore') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colName') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colTag') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colType') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colListen') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colPublic') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colOutbound') }}</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('lines.colUsers') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colStatus') }}</th>
                    <th scope="col" class="px-3 py-2"><span class="sr-only">{{ $t('lines.viewDetail') }}</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="line in group.lines"
                    :key="line.id || line.line_hash_id"
                    role="button"
                    tabindex="0"
                    class="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
                    :aria-label="$t('lines.viewDetail')"
                    @click="openDetail(line)"
                    @keydown.enter.prevent="openDetail(line)"
                    @keydown.space.prevent="openDetail(line)"
                  >
                    <td class="px-3 py-2">
                      <Badge :variant="sourceVariant(line.source)">{{ sourceLabel(line.source) }}</Badge>
                    </td>
                    <td class="px-3 py-2">
                      <Badge v-if="line.core" variant="outline">{{ line.core }}</Badge>
                      <span v-else class="text-muted-foreground">—</span>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-medium">{{ line.name || "—" }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-mono text-xs text-muted-foreground">{{ line.tag || "—" }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-mono text-xs text-muted-foreground">{{ line.type || "—" }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <div class="space-y-1">
                        <span class="block font-mono text-xs">{{ listenPresentation(line).label }}</span>
                        <Badge :variant="listenPresentation(line).badgeVariant" class="text-[10px]">
                          {{ listenPresentation(line).exposureLabel }}
                        </Badge>
                      </div>
                    </td>
                    <td class="px-3 py-2">
                      <div class="font-mono text-xs">{{ line.public_host || "—" }}</div>
                      <div v-if="line.domain" class="font-mono text-xs text-muted-foreground">{{ line.domain }}</div>
                    </td>
                    <td class="px-3 py-2">
                      <div class="max-w-[180px] space-y-1">
                        <Badge :variant="outboundPresentation(line.outbound_ref).relayed ? 'info' : 'secondary'" class="text-[10px]">
                          {{ outboundPresentation(line.outbound_ref).relayed ? $t('lines.outboundRelay') : $t('lines.outboundDirect') }}
                        </Badge>
                        <span
                          v-if="outboundPresentation(line.outbound_ref).relayed"
                          class="block truncate font-mono text-xs text-muted-foreground"
                          :title="outboundPresentation(line.outbound_ref).detail"
                        >
                          {{ outboundPresentation(line.outbound_ref).detail }}
                        </span>
                      </div>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <Tooltip v-if="!line.user_known">
                        <TooltipTrigger as-child>
                          <span class="cursor-help font-mono text-xs text-muted-foreground">
                            {{ $t('lines.usersUnknown') }}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{{ $t('lines.usersUnknownHint') }}</TooltipContent>
                      </Tooltip>
                      <span v-else class="font-mono text-xs tabular">{{ line.user_count }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <Tooltip v-if="line.status === 'error' && line.last_error">
                        <TooltipTrigger as-child>
                          <Badge :variant="statusVariant(line.status)" class="cursor-help">
                            {{ statusLabel(line.status) }}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent class="max-w-xs">{{ line.last_error }}</TooltipContent>
                      </Tooltip>
                      <Badge v-else :variant="statusVariant(line.status)">{{ statusLabel(line.status) }}</Badge>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <ChevronRight class="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>
    </DataState>

    <!-- Line detail drawer -->
    <Dialog v-model:open="detailOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ $t('lines.detailTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('lines.detailDescription', { name: selected?.name || selected?.line_hash_id }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="selected" class="space-y-4">
          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('lines.fieldLineHashId') }}</span>
              <CopyButton :value="selected.line_hash_id" :label="$t('common.actions.copy')" />
            </div>
            <code class="block break-all p-3 font-mono text-xs">{{ selected.line_hash_id }}</code>
          </div>

          <dl class="overflow-hidden rounded-md border border-border">
            <div
              v-for="(row, idx) in detailRows"
              :key="row.label"
              class="flex items-start justify-between gap-4 px-3 py-2.5"
              :class="cn(idx % 2 === 1 && 'bg-muted/30', idx > 0 && 'border-t border-border')"
            >
              <dt class="shrink-0 text-xs font-medium text-muted-foreground">{{ row.label }}</dt>
              <dd class="min-w-0 break-words text-right font-mono text-xs">{{ row.value }}</dd>
            </div>
          </dl>

          <div v-if="canAdmin && selected.source === 'discovered'" class="space-y-3 rounded-md border border-border p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <Lock class="size-4 text-primary" aria-hidden="true" />
                <p class="text-sm font-medium">{{ $t('lines.secretRevealTitle') }}</p>
              </div>
              <Badge variant="warning">{{ $t('lines.stepUpBadge') }}</Badge>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              :disabled="revealingLine"
              @click="revealLineConnection"
            >
              <RefreshCw v-if="revealingLine" class="size-4 animate-spin" aria-hidden="true" />
              <KeyRound v-else class="size-4" aria-hidden="true" />
              {{ $t('lines.revealConnection') }}
            </Button>
            <div v-if="revealedLine?.share_url" class="rounded-md border border-border bg-muted/20">
              <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <span class="text-xs font-medium text-muted-foreground">{{ $t('lines.connectionLink') }}</span>
                <CopyButton :value="revealedLine.share_url" />
              </div>
              <code class="block max-h-32 overflow-auto break-all p-3 font-mono text-xs">{{ revealedLine.share_url }}</code>
            </div>
            <p v-else-if="revealedLine" class="text-xs text-muted-foreground">{{ $t('lines.noConnectionLink') }}</p>
          </div>

          <div v-if="canConncheckLine(selected)" class="space-y-3 rounded-md border border-border p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <Activity class="size-4 text-primary" aria-hidden="true" />
                <p class="text-sm font-medium">{{ $t('lines.conncheckTitle') }}</p>
              </div>
              <Badge variant="secondary">{{ $t('lines.conncheckBadge') }}</Badge>
            </div>
            <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div class="grid min-w-0 gap-2">
                <Label for="line-conncheck-url">{{ $t('lines.conncheckURL') }}</Label>
                <Input
                  id="line-conncheck-url"
                  v-model="conncheckURL"
                  type="url"
                  autocomplete="off"
                  placeholder="https://www.cloudflare.com/cdn-cgi/trace"
                />
              </div>
              <Button
                type="button"
                class="self-end"
                :disabled="connchecking || !canRunTask"
                :title="!canRunTask ? $t('lines.taskRunRequired') : $t('lines.conncheckRun')"
                @click="runConncheck(selected)"
              >
                <RefreshCw v-if="connchecking" class="size-4 animate-spin" aria-hidden="true" />
                <Activity v-else class="size-4" aria-hidden="true" />
                {{ $t('lines.conncheckRun') }}
              </Button>
            </div>
            <div v-if="conncheckTaskID" class="rounded-md border border-border bg-muted/20 p-3 text-xs">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="font-mono">{{ conncheckTaskID }}</span>
                <Badge :variant="conncheckResult ? (conncheckResult.exit_code === 0 ? 'success' : 'destructive') : 'warning'">
                  {{ conncheckResult ? (conncheckResult.exit_code === 0 ? $t('lines.conncheckOk') : $t('lines.conncheckError')) : $t('lines.conncheckPending') }}
                </Badge>
              </div>
              <div v-if="conncheckPayload" class="mt-2 grid gap-2 sm:grid-cols-3">
                <div class="rounded bg-background/60 p-2">
                  <p class="text-muted-foreground">{{ $t('lines.conncheckHTTP') }}</p>
                  <p class="font-mono">{{ conncheckPayload.http_code || '—' }}</p>
                </div>
                <div class="rounded bg-background/60 p-2">
                  <p class="text-muted-foreground">{{ $t('lines.conncheckLatency') }}</p>
                  <p class="font-mono">{{ conncheckPayload.latency_ms || '—' }}ms</p>
                </div>
                <div class="rounded bg-background/60 p-2">
                  <p class="text-muted-foreground">{{ $t('lines.conncheckLocalPort') }}</p>
                  <p class="font-mono">{{ conncheckPayload.local_proxy_port || '—' }}</p>
                </div>
              </div>
              <pre v-if="conncheckResult?.stdout" class="mt-2 max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono">{{ conncheckResult.stdout }}</pre>
              <pre v-if="conncheckResult?.stderr" class="mt-2 max-h-40 overflow-auto rounded bg-destructive/10 p-2 font-mono text-destructive">{{ conncheckResult.stderr }}</pre>
              <pre v-if="conncheckResult?.error" class="mt-2 max-h-40 overflow-auto rounded bg-destructive/10 p-2 font-mono text-destructive">{{ conncheckResult.error }}</pre>
            </div>
          </div>

          <div class="space-y-3 rounded-md border border-border p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="text-sm font-medium">{{ $t('lines.rosterTitle') }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ $t('lines.rosterCount', { count: currentRosterIDs().length }) }}
                </p>
              </div>
              <div v-if="canAdmin" class="flex items-center gap-2">
                <Button
                  v-if="lineRuntimeUserSyncSupported(selected)"
                  type="button"
                  size="sm"
                  variant="outline"
                  :disabled="rosterSaving || rosterSelection.length === 0"
                  :title="$t('lines.rosterSyncRuntimeHint')"
                  @click="syncRosterRuntime"
                >
                  <RefreshCw v-if="rosterSaving" class="size-4 animate-spin" aria-hidden="true" />
                  <ArrowUpRight v-else class="size-4" aria-hidden="true" />
                  {{ $t('lines.rosterSyncRuntime') }}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  :disabled="rosterSaving || !rosterDirty"
                  @click="resetRosterSelection()"
                >
                  {{ $t('common.actions.reset') }}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  :disabled="rosterSaving || !rosterDirty"
                  @click="saveRoster"
                >
                  <RefreshCw v-if="rosterSaving" class="size-4 animate-spin" aria-hidden="true" />
                  {{ $t('common.actions.save') }}
                </Button>
              </div>
            </div>
            <div v-if="usersQuery.loading.value" class="text-xs text-muted-foreground">
              {{ $t('common.state.loading') }}
            </div>
            <div v-else-if="!rosterUsers.length" class="text-xs text-muted-foreground">
              {{ $t('lines.noUsers') }}
            </div>
            <div v-else class="grid gap-2 sm:grid-cols-2">
              <div
                v-for="user in rosterUsers"
                :key="user.id"
                class="min-w-0 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm"
                :class="cn(!canAdmin && 'opacity-80')"
              >
                <label class="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    class="mt-0.5 size-4 accent-primary"
                    :checked="rosterChecked(user.id)"
                    :disabled="!canAdmin || rosterSaving"
                    @change="onRosterToggle(user.id, $event)"
                  />
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ user.email || user.id }}</span>
                    <span class="block truncate text-xs text-muted-foreground">
                      {{ user.name || user.id }}
                    </span>
                  </span>
                </label>
                <div v-if="canAdmin && rosterChecked(user.id)" class="mt-2 space-y-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    :disabled="revealingUserID === user.id"
                    @click="revealUserCredentials(user.id)"
                  >
                    <RefreshCw v-if="revealingUserID === user.id" class="size-4 animate-spin" aria-hidden="true" />
                    <KeyRound v-else class="size-4" aria-hidden="true" />
                    {{ $t('lines.revealUserCredential') }}
                  </Button>
                  <div v-if="revealedUsers[user.id]" class="rounded-md border border-border bg-background/60">
                    <div class="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
                      <span class="text-[11px] text-muted-foreground">{{ $t('lines.userCredential') }}</span>
                      <CopyButton :value="revealedCredentialText(user.id)" />
                    </div>
                    <pre class="max-h-36 overflow-auto p-2 font-mono text-[11px]">{{ revealedCredentialText(user.id) }}</pre>
                  </div>
                </div>
              </div>
            </div>
            <p v-if="rosterError" class="whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              {{ rosterError }}
            </p>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('lines.jumpEdgesTitle') }}</p>
            <div v-if="selected.jump_edges && selected.jump_edges.length" class="space-y-1">
              <div
                v-for="edge in selected.jump_edges"
                :key="edge"
                class="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
              >
                <code class="block break-all font-mono text-xs">{{ edge }}</code>
                <CopyButton :value="edge" />
              </div>
            </div>
            <p v-else class="text-xs text-muted-foreground">{{ $t('lines.noJumpEdges') }}</p>
          </div>

          <div v-if="metadataEntries.length" class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('lines.fieldMetadata') }}</p>
            <dl class="overflow-hidden rounded-md border border-border">
              <div
                v-for="([k, v], idx) in metadataEntries"
                :key="k"
                class="flex items-start justify-between gap-4 px-3 py-2"
                :class="cn(idx % 2 === 1 && 'bg-muted/30', idx > 0 && 'border-t border-border')"
              >
                <dt class="shrink-0 font-mono text-xs text-muted-foreground">{{ k }}</dt>
                <dd class="min-w-0 break-words text-right font-mono text-xs">{{ v }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <DialogFooter>
          <Button
            v-if="canAdmin && canDeleteLine(selected)"
            type="button"
            variant="destructive"
            :title="$t('lines.deleteLine')"
            @click="askDeleteLine(selected)"
          >
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('lines.deleteLine') }}
          </Button>
          <Button type="button" variant="outline" @click="detailOpen = false">
            {{ $t('common.actions.close') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <Dialog v-model:open="addOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('lines.addDialogTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('lines.addDialogDescription') }}</DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submitAdd">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="grid gap-2 sm:col-span-3">
              <Label for="line-node">{{ $t('lines.fieldNode') }}</Label>
              <Select v-model="addForm.node_id">
                <SelectTrigger
                  id="line-node"
                  :aria-invalid="!!addNodeError"
                  :class="cn(addNodeError && 'border-destructive')"
                >
                  <SelectValue :placeholder="$t('lines.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in selectableNodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }} · {{ node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="addNodeError" class="text-xs text-destructive">{{ addNodeError }}</p>
            </div>

            <div class="grid gap-2">
              <Label for="line-protocol">{{ $t('lines.fieldProtocol') }}</Label>
              <Select v-model="addForm.protocol">
                <SelectTrigger
                  id="line-protocol"
                  :aria-invalid="!!addProtocolError"
                  :class="cn(addProtocolError && 'border-destructive')"
                >
                  <SelectValue :placeholder="$t('lines.selectProtocol')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="p in PROTOCOLS" :key="p.value" :value="p.value">
                    {{ p.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="addProtocolError" class="text-xs text-destructive">{{ addProtocolError }}</p>
            </div>

            <div class="grid gap-2">
              <Label for="line-port">{{ $t('lines.fieldPort') }}</Label>
              <Input
                id="line-port"
                v-model="addForm.port"
                type="number"
                min="1"
                max="65535"
                :aria-invalid="!!addPortError"
                :class="cn(addPortError && 'border-destructive')"
                :placeholder="$t('lines.fieldPortPlaceholder')"
              />
              <p v-if="addPortError" class="text-xs text-destructive">{{ addPortError }}</p>
            </div>

            <div class="grid gap-2">
              <Label for="line-arg1">{{ $t('lines.fieldArg1') }}</Label>
              <Input
                id="line-arg1"
                v-model="addForm.arg1"
                autocomplete="off"
                :placeholder="$t('lines.fieldArg1Placeholder')"
              />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="line-arg2">{{ $t('lines.fieldArg2') }}</Label>
            <Input
              id="line-arg2"
              v-model="addForm.arg2"
              autocomplete="off"
              :placeholder="$t('lines.fieldArg2Placeholder')"
            />
            <p class="text-xs text-muted-foreground">{{ $t('lines.argsHint') }}</p>
          </div>

          <div class="space-y-2 rounded-md border border-border p-3">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-sm font-medium">{{ $t('lines.fieldBindUsers') }}</p>
                <p class="text-xs text-muted-foreground">{{ $t('lines.bindAfterDiscoveryHint') }}</p>
              </div>
              <Badge variant="secondary">{{ addForm.user_ids.length }}</Badge>
            </div>
            <div v-if="vpnUsers.length" class="grid max-h-52 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              <label
                v-for="user in vpnUsers"
                :key="user.id"
                class="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <input v-model="addForm.user_ids" type="checkbox" :value="user.id" class="size-4" />
                <span class="min-w-0 truncate">{{ userLabel(user.id) }}</span>
              </label>
            </div>
            <p v-else class="text-xs text-muted-foreground">{{ $t('lines.noUsers') }}</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="addOpen = false">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="submit" :disabled="!addFormValid || addSaving">
              <RefreshCw v-if="addSaving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t('lines.addSubmit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <Dialog v-model:open="stepUpOpen">
      <DialogScrollContent class="sm:max-w-md" @escape-key-down.prevent="cancelStepUp">
        <DialogHeader>
          <DialogTitle>{{ $t('lines.stepUpTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('lines.stepUpDescription') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitStepUp">
          <div class="grid gap-2">
            <Label for="line-step-up-code">{{ $t('lines.stepUpCode') }}</Label>
            <Input
              id="line-step-up-code"
              v-model="stepUpCode"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="8"
              placeholder="123456"
            />
            <p v-if="stepUpError" class="text-xs text-destructive">{{ stepUpError }}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="cancelStepUp">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="submit" :disabled="stepUpPending || !stepUpCode.trim()">
              <RefreshCw v-if="stepUpPending" class="size-4 animate-spin" aria-hidden="true" />
              <Lock v-else class="size-4" aria-hidden="true" />
              {{ $t('lines.stepUpSubmit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('lines.deleteTitle')"
      :description="$t('lines.deleteConfirm', { name: deleteTarget?.name || deleteTarget?.tag })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @confirm="confirmDeleteLine"
    />
  </div>
</template>
