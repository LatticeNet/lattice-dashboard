<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
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
  Map as MapIcon,
  MapPin,
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
  type NodeInventory,
  type ProxyManagedAddRequest,
  type ProxyManagedLineRevealResponse,
  type TaskResult,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

const protocolStats = computed(() => {
  const counts = new Map<string, number>();
  for (const line of allLines.value) {
    const key = (line.type || "unknown").toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((a, b) => b.count - a.count || a.protocol.localeCompare(b.protocol));
});

const relayedLineCount = computed(() =>
  allLines.value.filter((line) => outboundPresentation(line.outbound_ref).relayed || (line.jump_edges?.length ?? 0) > 0).length,
);

const graphGroups = computed(() =>
  prioritizedGroups.value
    .filter((group) => group.lines.length > 0)
    .map((group) => ({
      ...group,
      lines: [...group.lines].sort((a, b) =>
        (a.listen_port || 0) - (b.listen_port || 0) ||
        (a.type || "").localeCompare(b.type || "") ||
        (a.name || "").localeCompare(b.name || ""),
      ),
    })),
);

// ── Node join helpers (geo / inventory come from the fleet nodes list) ───────
const nodesByID = computed(() => new Map(nodes.value.map((node) => [node.id, node])));

function nodeFor(nodeID: string): Node | undefined {
  return nodesByID.value.get(nodeID);
}

function nodeGeoLabel(nodeID: string): string {
  const geo = nodeFor(nodeID)?.geo;
  if (!geo) return "";
  return [geo.city, geo.region, geo.country].filter(Boolean).join(", ");
}

function nodeProviderLabel(nodeID: string): string {
  const geo = nodeFor(nodeID)?.geo;
  return geo?.provider || geo?.as_org || "";
}

function nodeInventory(nodeID: string): NodeInventory | undefined {
  return nodeFor(nodeID)?.inventory ?? undefined;
}

function purityVariant(percent: number): BadgeVariant {
  if (percent >= 95) return "success";
  if (percent >= 80) return "info";
  return "warning";
}

function groupErrorCount(group: LineGroup): number {
  return group.lines.filter((line) => line.status === "error" || line.last_error).length;
}

// ── Topology layout (graph tab) ───────────────────────────────────────────────
// Deterministic, dependency-free SVG layout: node boxes in 1-2 left columns, a
// single Internet sink on the right, and ghost boxes for relay tags whose
// target is not resolvable yet. Only edges the data actually supports are
// drawn — aggregated direct fans, resolvable jump_edges, and dashed stubs —
// so the graph never invents links that don't exist in the runtime.
const TOPO_W = 1000;
const TOPO_NODE_W = 200;
const TOPO_NODE_H = 56;
const TOPO_ROW_GAP = 14;
const TOPO_COL_GAP = 40;

type TopoBox = {
  id: string;
  name: string;
  x: number;
  y: number;
  lines: number;
  errors: number;
  directCount: number;
  relayedCount: number;
  purity?: number;
  quality?: string;
  geo: string;
};

type TopoGhost = { tag: string; x: number; y: number; count: number };

type TopoEdgeShape = {
  key: string;
  path: string;
  kind: "direct" | "relay" | "stub";
  count: number;
  sourceId: string;
  targetId: string;
  title: string;
};

const directLineTotal = computed(
  () => allLines.value.filter((line) => !outboundPresentation(line.outbound_ref).relayed).length,
);

const topo = computed(() => {
  const groupsList = graphGroups.value;
  const cols = groupsList.length > 12 ? 2 : 1;
  const rows = Math.max(1, Math.ceil(groupsList.length / cols));
  const height = Math.max(360, rows * (TOPO_NODE_H + TOPO_ROW_GAP) + 96);

  const boxes: TopoBox[] = groupsList.map((group, i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const inv = nodeInventory(group.node_id);
    const directCount = group.lines.filter(
      (line) => !outboundPresentation(line.outbound_ref).relayed,
    ).length;
    return {
      id: group.node_id,
      name: group.node_name || group.node_id,
      x: 24 + col * (TOPO_NODE_W + TOPO_COL_GAP),
      y: 44 + row * (TOPO_NODE_H + TOPO_ROW_GAP),
      lines: group.lines.length,
      errors: groupErrorCount(group),
      directCount,
      relayedCount: group.lines.length - directCount,
      purity: inv?.purity_percent,
      quality: inv?.quality,
      geo: nodeGeoLabel(group.node_id),
    };
  });
  const boxByID = new Map(boxes.map((box) => [box.id, box]));

  const internet = { x: TOPO_W - 96, y: height / 2, r: 40 };

  // Resolvable relay edges: line → line via jump_edges, lifted to node → node.
  const nodePairs = new Map<string, { from: string; to: string; count: number }>();
  for (const edge of topologyEdges.value) {
    const targetNode = edge.target?.node_id;
    if (!targetNode || !boxByID.has(edge.source.node_id) || !boxByID.has(targetNode)) continue;
    const key = `${edge.source.node_id}→${targetNode}`;
    const pair = nodePairs.get(key) ?? { from: edge.source.node_id, to: targetNode, count: 0 };
    pair.count += 1;
    nodePairs.set(key, pair);
  }

  // Unresolved relays: relayed lines with no resolvable jump target, grouped by
  // outbound tag so each tag becomes one ghost box instead of a fake node link.
  const resolvedSources = new Set(
    topologyEdges.value.filter((edge) => edge.target).map((edge) => edge.source.line_hash_id),
  );
  const stubTags = new Map<string, Map<string, number>>();
  for (const line of allLines.value) {
    if (!outboundPresentation(line.outbound_ref).relayed) continue;
    if (resolvedSources.has(line.line_hash_id)) continue;
    const tag = (line.outbound_ref ?? "").trim();
    if (!tag || !boxByID.has(line.node_id)) continue;
    const perNode = stubTags.get(tag) ?? new Map<string, number>();
    perNode.set(line.node_id, (perNode.get(line.node_id) ?? 0) + 1);
    stubTags.set(tag, perNode);
  }
  const ghostTags = [...stubTags.keys()].sort();
  const ghosts: TopoGhost[] = ghostTags.map((tag, i) => ({
    tag,
    x: TOPO_W - 330,
    y: internet.y + (i - (ghostTags.length - 1) / 2) * 72,
    count: [...(stubTags.get(tag)?.values() ?? [])].reduce((a, b) => a + b, 0),
  }));

  const edges: TopoEdgeShape[] = [];
  for (const box of boxes) {
    if (!box.directCount) continue;
    const x1 = box.x + TOPO_NODE_W;
    const y1 = box.y + TOPO_NODE_H / 2;
    const x2 = internet.x - internet.r;
    const y2 = internet.y;
    const mx = (x1 + x2) / 2;
    edges.push({
      key: `direct:${box.id}`,
      path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
      kind: "direct",
      count: box.directCount,
      sourceId: box.id,
      targetId: "internet",
      title: t("lines.topoDirectEdgeTitle", { node: box.name, count: box.directCount }),
    });
  }
  for (const pair of nodePairs.values()) {
    const a = boxByID.get(pair.from);
    const b = boxByID.get(pair.to);
    if (!a || !b) continue;
    const x1 = a.x + TOPO_NODE_W;
    const y1 = a.y + TOPO_NODE_H / 2;
    const x2 = b.x + TOPO_NODE_W;
    const y2 = b.y + TOPO_NODE_H / 2;
    const cx = Math.max(x1, x2) + 56 + Math.abs(y2 - y1) * 0.08;
    edges.push({
      key: `relay:${pair.from}:${pair.to}`,
      path: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
      kind: "relay",
      count: pair.count,
      sourceId: pair.from,
      targetId: pair.to,
      title: t("lines.topoRelayEdgeTitle", {
        from: a.name,
        to: b.name,
        count: pair.count,
      }),
    });
  }
  for (const [tag, perNode] of stubTags) {
    const ghost = ghosts.find((g) => g.tag === tag);
    if (!ghost) continue;
    for (const [nodeID, count] of perNode) {
      const box = boxByID.get(nodeID);
      if (!box) continue;
      const x1 = box.x + TOPO_NODE_W;
      const y1 = box.y + TOPO_NODE_H / 2;
      const x2 = ghost.x - 76;
      const y2 = ghost.y;
      const mx = (x1 + x2) / 2;
      edges.push({
        key: `stub:${nodeID}:${tag}`,
        path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        kind: "stub",
        count,
        sourceId: nodeID,
        targetId: `tag:${tag}`,
        title: t("lines.topoStubEdgeTitle", { node: box.name, tag, count }),
      });
    }
  }

  return { boxes, ghosts, edges, internet, height };
});

const topoHoverId = ref("");

const topoActiveIds = computed<Set<string> | null>(() => {
  if (!topoHoverId.value) return null;
  const ids = new Set([topoHoverId.value]);
  for (const edge of topo.value.edges) {
    if (edge.sourceId === topoHoverId.value) ids.add(edge.targetId);
    if (edge.targetId === topoHoverId.value) ids.add(edge.sourceId);
  }
  return ids;
});

function topoEdgeActive(edge: TopoEdgeShape): boolean {
  const active = topoActiveIds.value;
  if (!active) return true;
  return active.has(edge.sourceId) && active.has(edge.targetId);
}

function topoEdgeWidth(count: number): number {
  return Math.min(1 + Math.log2(count + 1), 4);
}

function topoTrim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Clicking a topology node jumps back to its full-width row on the Lines tab.
const highlightGroupId = ref("");

function focusNodeGroup(nodeID: string) {
  activeTab.value = "lines";
  if (!visibleGroups.value.some((group) => group.node_id === nodeID)) {
    showAllGroups.value = true;
  }
  highlightGroupId.value = nodeID;
  void nextTick(() => {
    document
      .getElementById(`line-group-${nodeID}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      if (highlightGroupId.value === nodeID) highlightGroupId.value = "";
    }, 2400);
  });
}

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
const activeTab = ref("lines");
const addOpen = ref(false);
const addSaving = ref(false);
const addAttempted = ref(false);
const addAdvancedOpen = ref(false);
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
  runtime_task_id?: string;
  node_id: string;
  protocol: string;
  port: number;
  user_ids: string[];
  status: "pending" | "binding" | "queued" | "failed";
  error?: string;
};

const pendingBinds = ref<PendingBindPlan[]>([]);

function openAdd(nodeId = "") {
  if (!canAdmin.value) return;
  addAttempted.value = false;
  addForm.node_id = nodeId;
  addForm.protocol = "reality";
  addForm.port = "";
  addForm.arg1 = "";
  addForm.arg2 = "";
  addForm.user_ids = [];
  addAdvancedOpen.value = false;
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
    case "queued":
      return t("lines.pendingStatusQueued");
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
      const res = await api.proxy.managed.users({
        node_id: line.node_id,
        line_hash_id: line.line_hash_id,
        bind_user_ids: plan.user_ids,
        unbind_user_ids: [],
      });
      plan.runtime_task_id = res.task_id;
      plan.status = "queued";
      toast.success(t("lines.rosterSyncQueued", { id: res.task_id }));
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

// ── Detail drawer (the app's modal primitive; no separate Sheet exists) ───────
const selected = ref<Line | null>(null);
const detailOpen = ref(false);
function openDetail(line: Line) {
  selected.value = line;
  resetRosterSelection(line);
  revealedLine.value = null;
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
  <div class="flex h-full min-h-0 flex-col gap-6 overflow-hidden p-6">
    <PageHeader class="shrink-0" :title="$t('lines.title')" :description="$t('lines.description')">
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

    <div class="grid shrink-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
      class="flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
    >
      <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div class="space-y-0.5">
        <p class="font-medium text-foreground">{{ $t('lines.manageNoteTitle') }}</p>
        <p>{{ $t('lines.manageNoteBody') }}</p>
      </div>
    </div>

    <Card v-if="pendingBinds.length" class="shrink-0">
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
              <div v-if="plan.runtime_task_id" class="truncate text-muted-foreground">
                {{ $t('lines.pendingRuntimeTask', { task: plan.runtime_task_id }) }}
              </div>
              <div v-if="plan.error" class="mt-1 break-words text-destructive">{{ plan.error }}</div>
            </div>
            <Badge :variant="plan.status === 'failed' ? 'destructive' : plan.status === 'queued' ? 'info' : 'warning'">
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
      class="min-h-0 flex-1"
      @retry="linesQuery.refresh"
    >
      <Tabs v-model="activeTab" class="h-full min-h-0 gap-4">
        <TabsList class="w-full shrink-0 sm:w-auto">
          <TabsTrigger value="lines">{{ $t('lines.tabLines') }}</TabsTrigger>
          <TabsTrigger value="graph">{{ $t('lines.tabGraph') }}</TabsTrigger>
        </TabsList>

        <TabsContent value="lines" class="min-h-0 overflow-hidden">
      <div class="flex h-full min-h-0 flex-col gap-3">
        <!-- Fleet overview strip: protocol mix + relay reach. Relocated from the
             graph-tab aside so the numbers stay visible where the lines live. -->
        <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/25 px-4 py-2.5 text-xs">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="font-medium text-muted-foreground">{{ $t('lines.overviewProtocols') }}</span>
            <Badge
              v-for="stat in protocolStats"
              :key="stat.protocol"
              variant="outline"
              class="gap-1.5"
            >
              <span class="font-mono">{{ stat.protocol }}</span>
              <span class="tabular-nums text-muted-foreground">{{ stat.count }}</span>
            </Badge>
          </div>
          <span class="hidden h-4 w-px bg-border sm:inline-block" aria-hidden="true"></span>
          <div class="flex items-center gap-1.5">
            <span class="font-medium text-muted-foreground">{{ $t('lines.graphRelayEdges') }}</span>
            <Badge :variant="topologyEdges.length ? 'info' : 'secondary'">{{ topologyEdges.length }}</Badge>
            <span class="text-muted-foreground">{{ $t('lines.overviewRelayed', { count: relayedLineCount }) }}</span>
          </div>
        </div>

        <div
          v-if="hiddenGroupCount > 0 || showAllGroups"
          class="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/25 px-4 py-3 text-sm"
        >
          <div class="text-muted-foreground">
            {{ $t('lines.renderSummary', { shown: visibleGroups.length, total: prioritizedGroups.length }) }}
          </div>
          <Button type="button" variant="outline" size="sm" @click="showAllGroups = !showAllGroups">
            {{ showAllGroups ? $t('lines.showLessGroups') : $t('lines.showAllGroups', { count: hiddenGroupCount }) }}
          </Button>
        </div>

        <!-- One full-width row per node: identity rail on the left, line table on
             the right. Plain flow layout — no CSS columns/masonry, so a tall node
             can never stretch row-mates or blow up the page height again. -->
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3 pr-1">
        <div
          v-for="group in visibleGroups"
          :id="`line-group-${group.node_id}`"
          :key="group.node_id"
          class="overflow-hidden rounded-lg border bg-card transition-colors"
          :class="cn(highlightGroupId === group.node_id ? 'border-primary/70 ring-2 ring-primary/25' : 'border-border')"
        >
          <div class="grid lg:grid-cols-[280px_minmax(0,1fr)]">
            <div class="min-w-0 space-y-3 border-b border-border bg-muted/20 p-4 lg:border-b-0 lg:border-r">
              <div class="min-w-0 space-y-1">
                <div class="flex items-center gap-2">
                  <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <RouterLink
                    :to="{ name: 'node-detail', params: { id: group.node_id } }"
                    class="inline-flex min-w-0 items-center gap-1 truncate text-sm font-medium hover:text-primary hover:underline"
                    :title="$t('lines.viewNode')"
                  >
                    <span class="truncate">{{ group.node_name || group.node_id }}</span>
                    <ArrowUpRight class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  </RouterLink>
                </div>
                <div class="truncate font-mono text-xs text-muted-foreground">{{ group.node_id }}</div>
              </div>

              <div class="space-y-1 text-xs text-muted-foreground">
                <div class="flex items-center gap-1.5">
                  <MapPin class="size-3.5 shrink-0" aria-hidden="true" />
                  <span class="truncate">{{ nodeGeoLabel(group.node_id) || $t('lines.nodeGeoUnknown') }}</span>
                </div>
                <div v-if="nodeProviderLabel(group.node_id)" class="truncate pl-5">
                  {{ nodeProviderLabel(group.node_id) }}
                </div>
              </div>

              <div class="flex flex-wrap gap-1.5">
                <Badge variant="secondary">
                  {{ $t('lines.groupLineCount', { count: group.lines.length }, group.lines.length) }}
                </Badge>
                <Badge v-if="groupErrorCount(group)" variant="destructive">
                  {{ $t('lines.groupErrorCount', { count: groupErrorCount(group) }) }}
                </Badge>
                <Badge
                  v-if="nodeInventory(group.node_id)?.purity_percent != null"
                  :variant="purityVariant(nodeInventory(group.node_id)?.purity_percent ?? 0)"
                >
                  {{ $t('lines.purityBadge', { percent: nodeInventory(group.node_id)?.purity_percent }) }}
                </Badge>
                <Badge v-if="nodeInventory(group.node_id)?.quality" variant="outline">
                  {{ nodeInventory(group.node_id)?.quality }}
                </Badge>
              </div>

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

            <div class="min-w-0 overflow-x-auto">
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
          </div>
        </div>
        </div>
      </div>
        </TabsContent>

        <TabsContent value="graph" class="min-h-0 overflow-y-auto pr-1">
          <div class="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,.65fr)]">
            <section class="min-w-0 overflow-hidden rounded-md border border-border">
              <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/25 px-4 py-3">
                <div>
                  <h2 class="text-sm font-semibold">{{ $t('lines.topoTitle') }}</h2>
                  <p class="text-xs text-muted-foreground">
                    {{ $t('lines.graphSummary', { nodes: graphGroups.length, lines: totalLines, relays: relayedLineCount }) }}
                  </p>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <Badge :variant="relayedLineCount ? 'info' : 'secondary'">
                    {{ relayedLineCount ? $t('lines.graphRelayMode') : $t('lines.graphDirectMode') }}
                  </Badge>
                  <Button as-child size="sm" variant="outline">
                    <RouterLink :to="{ name: 'map', query: { layer: 'vpn' } }">
                      <MapIcon class="size-4" aria-hidden="true" />
                      {{ $t('lines.openMapLayer') }}
                    </RouterLink>
                  </Button>
                </div>
              </div>

              <!-- Honest topology: aggregated direct fans into one Internet sink,
                   resolvable jump_edges as node→node links, unresolved relay tags
                   as dashed ghost boxes. No invented links. -->
              <div class="overflow-x-auto">
                <svg
                  :viewBox="`0 0 ${TOPO_W} ${topo.height}`"
                  class="w-full min-w-[760px] select-none"
                  role="img"
                  :aria-label="$t('lines.topoAria')"
                >
                  <g fill="none">
                    <path
                      v-for="edge in topo.edges"
                      :key="edge.key"
                      :d="edge.path"
                      class="stroke-current transition-opacity"
                      :class="cn(
                        edge.kind === 'direct' && 'text-border',
                        edge.kind === 'relay' && 'text-info',
                        edge.kind === 'stub' && 'text-warning/70',
                        topoActiveIds && !topoEdgeActive(edge) && 'opacity-15',
                      )"
                      :stroke-width="topoEdgeWidth(edge.count)"
                      :stroke-dasharray="edge.kind === 'stub' ? '6 4' : undefined"
                      stroke-linecap="round"
                    >
                      <title>{{ edge.title }}</title>
                    </path>
                  </g>

                  <g
                    class="transition-opacity"
                    :class="cn(topoActiveIds && !topoActiveIds.has('internet') && 'opacity-25')"
                  >
                    <circle
                      :cx="topo.internet.x"
                      :cy="topo.internet.y"
                      :r="topo.internet.r"
                      class="fill-info/10 stroke-current text-info/60"
                      stroke-width="1.5"
                    />
                    <text
                      :x="topo.internet.x"
                      :y="topo.internet.y - 2"
                      text-anchor="middle"
                      class="fill-current text-[13px] font-medium text-foreground"
                    >
                      {{ $t('lines.topoInternet') }}
                    </text>
                    <text
                      :x="topo.internet.x"
                      :y="topo.internet.y + 14"
                      text-anchor="middle"
                      class="fill-current text-[10px] text-muted-foreground"
                    >
                      {{ $t('lines.topoDirectLines', { count: directLineTotal }) }}
                    </text>
                  </g>

                  <g
                    v-for="ghost in topo.ghosts"
                    :key="ghost.tag"
                    class="transition-opacity"
                    :class="cn(topoActiveIds && !topoActiveIds.has(`tag:${ghost.tag}`) && 'opacity-25')"
                  >
                    <rect
                      :x="ghost.x - 76"
                      :y="ghost.y - 22"
                      width="152"
                      height="44"
                      rx="8"
                      class="fill-muted/40 stroke-current text-warning/70"
                      stroke-dasharray="5 4"
                      stroke-width="1.2"
                    />
                    <text
                      :x="ghost.x"
                      :y="ghost.y - 3"
                      text-anchor="middle"
                      class="fill-current font-mono text-[11px] text-foreground"
                    >
                      {{ topoTrim(ghost.tag, 20) }}
                    </text>
                    <text
                      :x="ghost.x"
                      :y="ghost.y + 13"
                      text-anchor="middle"
                      class="fill-current text-[9.5px] text-muted-foreground"
                    >
                      {{ $t('lines.topoUnresolved', { count: ghost.count }) }}
                    </text>
                    <title>{{ $t('lines.topoUnresolvedTitle', { tag: ghost.tag, count: ghost.count }) }}</title>
                  </g>

                  <g
                    v-for="box in topo.boxes"
                    :key="box.id"
                    role="button"
                    tabindex="0"
                    class="cursor-pointer outline-none transition-opacity"
                    :class="cn(topoActiveIds && !topoActiveIds.has(box.id) && 'opacity-25')"
                    :aria-label="$t('lines.topoNodeAria', { node: box.name })"
                    @click="focusNodeGroup(box.id)"
                    @keydown.enter.prevent="focusNodeGroup(box.id)"
                    @keydown.space.prevent="focusNodeGroup(box.id)"
                    @mouseenter="topoHoverId = box.id"
                    @mouseleave="topoHoverId = ''"
                    @focus="topoHoverId = box.id"
                    @blur="topoHoverId = ''"
                  >
                    <title>{{ box.name }} · {{ box.geo || $t('lines.nodeGeoUnknown') }}</title>
                    <rect
                      :x="box.x"
                      :y="box.y"
                      :width="TOPO_NODE_W"
                      :height="TOPO_NODE_H"
                      rx="10"
                      class="fill-card stroke-current"
                      :class="box.errors ? 'text-destructive/70' : 'text-border'"
                      stroke-width="1.2"
                    />
                    <circle
                      :cx="box.x + 14"
                      :cy="box.y + 16"
                      r="4"
                      class="fill-current"
                      :class="box.errors ? 'text-destructive' : 'text-success'"
                    />
                    <text
                      :x="box.x + 26"
                      :y="box.y + 20"
                      class="fill-current text-[12px] font-medium text-foreground"
                    >
                      {{ topoTrim(box.name, box.purity != null ? 18 : 23) }}
                    </text>
                    <text
                      v-if="box.purity != null"
                      :x="box.x + TOPO_NODE_W - 10"
                      :y="box.y + 20"
                      text-anchor="end"
                      class="fill-current text-[10px] font-medium text-success"
                    >
                      {{ box.purity }}%
                    </text>
                    <text
                      :x="box.x + 26"
                      :y="box.y + 38"
                      class="fill-current text-[10px] text-muted-foreground"
                    >
                      {{ topoTrim(`${$t('lines.groupLineCount', { count: box.lines }, box.lines)}${box.geo ? ` · ${box.geo}` : ''}`, 30) }}
                    </text>
                  </g>
                </svg>
              </div>

              <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
                <span class="inline-flex items-center gap-1.5">
                  <span class="inline-block h-0.5 w-5 rounded bg-border" aria-hidden="true"></span>
                  {{ $t('lines.topoLegendDirect') }}
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="inline-block h-0.5 w-5 rounded bg-info" aria-hidden="true"></span>
                  {{ $t('lines.topoLegendRelay') }}
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="inline-block w-5 border-t-2 border-dashed border-warning/70" aria-hidden="true"></span>
                  {{ $t('lines.topoLegendStub') }}
                </span>
                <span class="ml-auto">{{ $t('lines.topoHint') }}</span>
              </div>
            </section>

            <aside class="space-y-4">
              <section class="rounded-md border border-border p-4">
                <div class="flex items-center justify-between gap-3">
                  <h2 class="text-sm font-semibold">{{ $t('lines.graphRelayEdges') }}</h2>
                  <Badge :variant="topologyEdges.length ? 'info' : 'secondary'">{{ topologyEdges.length }}</Badge>
                </div>
                <div v-if="topologyEdges.length" class="mt-3 space-y-2">
                  <button
                    v-for="edge in topologyEdges"
                    :key="`${edge.source.line_hash_id}:${edge.targetHash}`"
                    type="button"
                    class="w-full rounded-md border border-border bg-muted/20 px-3 py-2 text-left text-xs hover:bg-muted/40"
                    @click="openDetail(edge.source)"
                  >
                    <div class="flex items-center gap-2">
                      <span class="min-w-0 flex-1 truncate font-medium">{{ shortNodeLabel(edge.source.node_id) }}</span>
                      <ExternalLink class="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                      <span class="min-w-0 flex-1 truncate text-right font-medium">{{ shortNodeLabel(edge.target?.node_id) }}</span>
                    </div>
                    <div class="mt-1 flex items-center gap-2 font-mono text-muted-foreground">
                      <span class="min-w-0 flex-1 truncate">{{ shortLineID(edge.source.line_hash_id) }}</span>
                      <span>&rarr;</span>
                      <span class="min-w-0 flex-1 truncate text-right">{{ shortLineID(edge.targetHash) }}</span>
                    </div>
                  </button>
                </div>
                <p v-else class="mt-3 text-xs text-muted-foreground">
                  {{ $t('lines.graphDirectDescription') }}
                </p>
              </section>

              <section class="rounded-md border border-border p-4">
                <h2 class="text-sm font-semibold">{{ $t('lines.graphProtocolMix') }}</h2>
                <div class="mt-3 flex flex-wrap gap-2">
                  <Badge
                    v-for="stat in protocolStats"
                    :key="stat.protocol"
                    variant="outline"
                    class="gap-1.5"
                  >
                    <span class="font-mono">{{ stat.protocol }}</span>
                    <span class="tabular-nums text-muted-foreground">{{ stat.count }}</span>
                  </Badge>
                </div>
              </section>

              <section class="rounded-md border border-border p-4">
                <h2 class="text-sm font-semibold">{{ $t('lines.graphTopNodes') }}</h2>
                <div class="mt-3 space-y-2">
                  <div
                    v-for="node in topologyNodes"
                    :key="node.id"
                    class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs"
                  >
                    <span class="truncate" :title="node.name">{{ node.name }}</span>
                    <Badge :variant="node.errors ? 'destructive' : 'secondary'">{{ node.lines }}</Badge>
                  </div>
                </div>
              </section>
            </aside>
          </div>
        </TabsContent>
      </Tabs>
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
          <div class="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(150px,.7fr)_minmax(120px,.45fr)]">
            <div class="grid gap-2">
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
                  <SelectValue />
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

          </div>

          <div class="rounded-md border border-border">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm"
              @click="addAdvancedOpen = !addAdvancedOpen"
            >
              <span class="font-medium">{{ $t('lines.advancedOptions') }}</span>
              <Badge variant="secondary">{{ addAdvancedOpen ? $t('lines.advancedHide') : $t('lines.advancedShow') }}</Badge>
            </button>
            <div v-if="addAdvancedOpen" class="grid gap-3 border-t border-border p-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="line-arg1">{{ $t('lines.fieldArg1') }}</Label>
                <Input
                  id="line-arg1"
                  v-model="addForm.arg1"
                  autocomplete="off"
                  :placeholder="$t('lines.fieldArg1Placeholder')"
                />
              </div>
              <div class="grid gap-2">
                <Label for="line-arg2">{{ $t('lines.fieldArg2') }}</Label>
                <Input
                  id="line-arg2"
                  v-model="addForm.arg2"
                  autocomplete="off"
                  :placeholder="$t('lines.fieldArg2Placeholder')"
                />
              </div>
              <p class="text-xs text-muted-foreground sm:col-span-2">{{ $t('lines.argsHint') }}</p>
            </div>
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
