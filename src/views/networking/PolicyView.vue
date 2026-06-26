<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
  FolderTree,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type GroupPolicyPlanResult,
  type GroupPolicyUpsertRequest,
  type GroupPolicyView,
  type GroupView,
  type MatrixGroup,
  type NetEndpointKind,
  type NetGraphNode,
  type NetPolicyGraph,
  type NetPolicyMatrix,
  type NetPolicyUpsertRequest,
  type NetPolicyView,
  type NetRule,
  type NetRuleAction,
  type NetRuleDirection,
  type NetRuleProtocol,
} from "@/lib/api";
import {
  type Continent,
  continentGlyph,
  continentLabel,
  continentOf,
} from "@/lib/fleet";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PolicyMatrix from "@/components/networking/PolicyMatrix.vue";
import PolicyCellEditor from "@/components/networking/PolicyCellEditor.vue";

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const canRead = computed(() => auth.can("netpolicy:read"));
const canAdmin = computed(() => auth.can("netpolicy:admin"));

const tab = ref<"matrix" | "policies" | "graph">("matrix");

const policiesQuery = useAsyncData(() => api.netpolicy.list().then((r) => unwrap(r, "policies")), {
  pollInterval: 15000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});
const graphQuery = useAsyncData(() => api.netpolicy.graph(), { immediate: false });

const policies = computed(() => policiesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

// ── Reachability matrix (default tab) ─────────────────────────────────────
const matrixDirection = ref<NetRuleDirection>("egress");
const matrixQuery = useAsyncData(() => api.netpolicy.matrix(matrixDirection.value), {
  pollInterval: 0,
});
const groupPoliciesQuery = useAsyncData(
  () => api.groupPolicy.list().then((r) => unwrap(r, "policies")),
  { pollInterval: 0 },
);
const matrix = computed<NetPolicyMatrix | undefined>(() => matrixQuery.data.value);
const groupPolicies = computed<GroupPolicyView[]>(() => groupPoliciesQuery.data.value ?? []);
const matrixGroups = computed<MatrixGroup[]>(() => matrix.value?.groups ?? []);
const hasGroups = computed(() => matrixGroups.value.length > 0);
const hasGroupPolicies = computed(() => groupPolicies.value.length > 0);

function setMatrixDirection(value: NetRuleDirection) {
  matrixDirection.value = value;
  matrixQuery.refresh();
}

function refreshMatrix() {
  matrixQuery.refresh();
  groupPoliciesQuery.refresh();
}

function goToGroups() {
  router.push("/groups");
}

// ── Group-policy cell editor (source group → dest group) ──────────────────
const cellEditorOpen = ref(false);
const cellSource = ref<MatrixGroup | undefined>(undefined);
const cellDest = ref<MatrixGroup | undefined>(undefined);
const savingCell = ref(false);

const cellSourcePolicy = computed<GroupPolicyView | undefined>(() =>
  cellSource.value
    ? groupPolicies.value.find((p) => p.scope_group_id === cellSource.value!.id)
    : undefined,
);

function openCellEditor(source: MatrixGroup, dest: MatrixGroup) {
  if (!canAdmin.value) return;
  cellSource.value = source;
  cellDest.value = dest;
  cellEditorOpen.value = true;
}

function newGroupPolicy() {
  const first = matrixGroups.value[0];
  if (!first) return;
  openCellEditor(first, first);
}

async function saveCell(payload: GroupPolicyUpsertRequest) {
  savingCell.value = true;
  try {
    await api.groupPolicy.upsert(payload);
    toast.success(t("networking.matrix.toastSaved"));
    cellEditorOpen.value = false;
    refreshMatrix();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.matrix.toastSaveFailed"));
  } finally {
    savingCell.value = false;
  }
}

// ── Group-policy plan (expand → per-node approvals) ───────────────────────
const planResult = ref<GroupPolicyPlanResult | undefined>(undefined);
const planResultOpen = ref(false);
const planningGroups = ref(false);

async function planGroupPolicies() {
  if (!canAdmin.value) return;
  planningGroups.value = true;
  try {
    const result = await api.groupPolicy.plan();
    planResult.value = result;
    planResultOpen.value = true;
    toast.success(t("networking.matrix.toastPlanned", { n: result.affected.length }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.shared.toastPlanFailed"));
  } finally {
    planningGroups.value = false;
  }
}

const sortedPolicies = computed(() =>
  [...policies.value].sort((a, b) =>
    (a.target_node_name || a.target_node_id).localeCompare(b.target_node_name || b.target_node_id),
  ),
);

function policyNodeLabel(p: NetPolicyView): string {
  return p.target_node_name || p.target_node_id;
}

function nodeName(id: string): string {
  return nodes.value.find((n) => n.id === id)?.name || shortId(id, 14);
}

function activeRuleCount(p: NetPolicyView): number {
  return p.rules.filter((r) => !r.disabled).length;
}

const policyColumns = computed<DataTableColumn<NetPolicyView>[]>(() => [
  {
    key: "target",
    label: t("networking.policy.colTargetNode"),
    sortable: true,
    searchable: true,
    value: (p) => policyNodeLabel(p),
  },
  { key: "enabled", label: t("networking.policy.colEnabled"), sortable: true, value: (p) => (p.enabled ? 1 : 0) },
  { key: "rules", label: t("networking.policy.colRules"), align: "right", sortable: true, value: (p) => p.rules.length },
  { key: "last_plan", label: t("networking.policy.colLastPlan") },
  { key: "last_applied", label: t("networking.policy.colLastApplied"), sortable: true, value: (p) => p.last_applied_at ?? "" },
  { key: "last_error", label: t("networking.policy.colLastError") },
  { key: "actions", label: t("networking.policy.colActions"), align: "right" },
]);

function loadGraph() {
  if (graphQuery.data.value === undefined && !graphQuery.loading.value) graphQuery.refresh();
}

function onTabChange(value: string | number) {
  const next = String(value) as "matrix" | "policies" | "graph";
  tab.value = next;
  if (next === "graph") loadGraph();
}

// ── Rules editor model ────────────────────────────────────────────────────
interface RuleDraft {
  action: NetRuleAction;
  direction: NetRuleDirection;
  protocol: NetRuleProtocol;
  ports: string;
  remoteKind: NetEndpointKind;
  remoteNodeId: string;
  remoteCidr: string;
  remoteDomain: string;
  comment: string;
  disabled: boolean;
}

function emptyRule(): RuleDraft {
  return {
    action: "allow",
    direction: "egress",
    protocol: "tcp",
    ports: "",
    remoteKind: "any",
    remoteNodeId: "",
    remoteCidr: "",
    remoteDomain: "",
    comment: "",
    disabled: false,
  };
}

function ruleToDraft(rule: NetRule): RuleDraft {
  return {
    action: rule.action,
    direction: rule.direction,
    protocol: rule.protocol,
    ports: (rule.ports ?? []).join(", "),
    remoteKind: rule.remote.kind,
    remoteNodeId: rule.remote.node_id ?? "",
    remoteCidr: rule.remote.cidr ?? "",
    remoteDomain: rule.remote.domain ?? "",
    comment: rule.comment ?? "",
    disabled: !!rule.disabled,
  };
}

function parsePorts(input: string): number[] {
  const set = new Set<number>();
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) set.add(value);
  }
  return [...set].sort((a, b) => a - b);
}

// ── Create / edit dialog ──────────────────────────────────────────────────
const dialogOpen = ref(false);
const editingId = ref<string | undefined>(undefined);
const saving = ref(false);
const form = reactive<{ target_node_id: string; enabled: boolean; rules: RuleDraft[] }>({
  target_node_id: "",
  enabled: true,
  rules: [],
});

// Snapshot of the form at open time — drives the unsaved-changes (dirty) guard.
const formSnapshot = ref("");
function snapshotForm(): string {
  return JSON.stringify({
    target_node_id: form.target_node_id,
    enabled: form.enabled,
    rules: form.rules,
  });
}
const isDirty = computed(() => dialogOpen.value && snapshotForm() !== formSnapshot.value);
// Confirm dialog shown when the operator tries to discard unsaved edits.
const discardConfirmOpen = ref(false);

function openCreate() {
  editingId.value = undefined;
  form.target_node_id = "";
  form.enabled = true;
  form.rules = [emptyRule()];
  formSnapshot.value = snapshotForm();
  dialogOpen.value = true;
}

function openEdit(p: NetPolicyView) {
  editingId.value = p.target_node_id;
  form.target_node_id = p.target_node_id;
  form.enabled = p.enabled;
  form.rules = p.rules.length ? p.rules.map(ruleToDraft) : [emptyRule()];
  formSnapshot.value = snapshotForm();
  dialogOpen.value = true;
}

/** Intercept dialog close: when dirty, ask before discarding. */
function requestCloseDialog() {
  if (isDirty.value) {
    discardConfirmOpen.value = true;
    return;
  }
  dialogOpen.value = false;
}

function onDialogOpenChange(open: boolean) {
  if (open) {
    dialogOpen.value = true;
    return;
  }
  requestCloseDialog();
}

function confirmDiscard() {
  discardConfirmOpen.value = false;
  dialogOpen.value = false;
}

function addRule() {
  form.rules.push(emptyRule());
}

function removeRule(index: number) {
  form.rules.splice(index, 1);
}

/** domain remotes are egress-only; clear protocol ports when protocol=any. */
function ruleError(draft: RuleDraft): string | undefined {
  if (draft.remoteKind === "domain" && draft.direction === "ingress") {
    return t("networking.policy.errDomainEgressOnly");
  }
  if (draft.remoteKind === "node" && !draft.remoteNodeId) return t("networking.policy.errSelectNode");
  if (draft.remoteKind === "cidr" && !draft.remoteCidr.trim()) return t("networking.policy.errEnterCidr");
  if (draft.remoteKind === "domain" && !draft.remoteDomain.trim()) return t("networking.policy.errEnterDomain");
  if (draft.protocol === "any" && parsePorts(draft.ports).length > 0) {
    return t("networking.policy.errAnyNoPorts");
  }
  return undefined;
}

const formErrors = computed(() => form.rules.map(ruleError));
const hasRuleErrors = computed(() => formErrors.value.some((e) => e !== undefined));
const canSubmit = computed(
  () => canAdmin.value && !!form.target_node_id && !hasRuleErrors.value,
);

function draftToRule(draft: RuleDraft, index: number): NetRule {
  return {
    id: `rule_${String(index + 1).padStart(3, "0")}`,
    action: draft.action,
    direction: draft.direction,
    protocol: draft.protocol,
    ports: draft.protocol === "any" ? [] : parsePorts(draft.ports),
    remote: {
      kind: draft.remoteKind,
      ...(draft.remoteKind === "node" ? { node_id: draft.remoteNodeId } : {}),
      ...(draft.remoteKind === "cidr" ? { cidr: draft.remoteCidr.trim() } : {}),
      ...(draft.remoteKind === "domain" ? { domain: draft.remoteDomain.trim() } : {}),
    },
    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
    ...(draft.disabled ? { disabled: true } : {}),
  };
}

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const body: NetPolicyUpsertRequest = {
      target_node_id: form.target_node_id,
      enabled: form.enabled,
      rules: form.rules.map(draftToRule),
    };
    await api.netpolicy.upsert(body);
    toast.success(editingId.value ? t("networking.policy.toastUpdated") : t("networking.policy.toastCreated"));
    dialogOpen.value = false;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.policy.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirm ────────────────────────────────────────────────────────
const deleteTarget = ref<NetPolicyView | undefined>(undefined);
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.netpolicy.delete(deleteTarget.value.target_node_id);
    toast.success(t("networking.policy.toastDeleted"));
    deleteTarget.value = undefined;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.policy.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan dialog ───────────────────────────────────────────────────────────
const planDigest = usePlanDigest();
const planning = ref<string | undefined>(undefined);
const planApproval = ref<ApprovalView | undefined>(undefined);
const planSha = ref("");

async function plan(p: NetPolicyView) {
  if (!canAdmin.value) return;
  planning.value = p.target_node_id;
  try {
    const approval = await api.netpolicy.plan(p.target_node_id);
    planApproval.value = approval;
    planSha.value = await planDigest.digestFor(approval);
    toast.success(t("networking.shared.toastPlanCreated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.shared.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

const planBadges = computed(() => {
  const a = planApproval.value;
  if (!a) return [];
  return [
    { label: a.status, variant: "warning" as const },
    { label: `${a.plugin} · ${a.action}`, variant: "outline" as const },
    { label: t("networking.shared.idLabel", { id: shortId(a.id, 12) }), variant: "secondary" as const },
  ];
});

function closePlan(open: boolean) {
  if (!open) {
    planApproval.value = undefined;
    planSha.value = "";
  }
}

// ── Topology graph (CSP-safe inline SVG: hub-and-spoke + region clusters) ──
//
// The fleet is outbound-only: every node connects to ONE control-plane server.
// The previous flat circle hid both facts — there was no server, and nodes were
// scattered with no sense of where they live. This layout fixes both:
//   • the control-plane SERVER sits at the centre (the hub everything dials);
//   • fleet nodes are CLUSTERED by region (continent) into contiguous arcs, so
//     "asia / us-west / europe" read at a glance, each region tinted + labelled;
//   • faint dashed spokes show the management plane (server → each agent);
//   • policy allow/deny edges curve between nodes on top;
//   • group-leaders (role) get an accent ring + ★.
const GRAPH_W = 860;
const GRAPH_H = 660;
const GCX = GRAPH_W / 2;
const GCY = GRAPH_H / 2;
const RING = 236; // radius of the node ring
const NODE_R = 22;
const LEADER_R = 26;
const HUB_R = 36;
const REGION_ARC_R = RING + 30;
const REGION_LABEL_R = RING + 54;

const serverHost =
  typeof window !== "undefined" && window.location.hostname
    ? window.location.hostname
    : "lattice-server";

const graph = computed<NetPolicyGraph | undefined>(() => graphQuery.data.value);

// The graph API returns a slim node shape (no role/disabled); enrich from the
// full node list so we can flag group-leaders and dim disabled nodes.
const nodeMetaById = computed<Record<string, { role?: string; disabled?: boolean }>>(() => {
  const m: Record<string, { role?: string; disabled?: boolean }> = {};
  for (const n of nodes.value) m[n.id] = { role: n.role, disabled: n.disabled };
  return m;
});

// Legacy role-name heuristic. Slice 4 introduced a real Group.leader_id, so this
// regex is now only a FALLBACK for nodes whose groups declare no leader.
const LEADER_RE = /lead|hub|gateway|relay|master|组长|枢纽/i;
function isLeaderRole(role?: string): boolean {
  return !!role && LEADER_RE.test(role);
}

// Real, operator-assigned group leaders: a node is a leader when it is the
// leader_id of any group. Fetched alongside the graph; degrades to the role
// heuristic if unavailable (e.g. the token lacks group:read).
const fleetGroupsQuery = useAsyncData(() => api.groups.list().then((r) => r.groups), {
  pollInterval: 0,
});
const fleetGroups = computed<GroupView[]>(() => fleetGroupsQuery.data.value ?? []);

const realLeaderIds = computed(() => {
  const s = new Set<string>();
  for (const g of fleetGroups.value) if (g.leader_id) s.add(g.leader_id);
  return s;
});
const groupHasLeader = computed<Record<string, boolean>>(() => {
  const m: Record<string, boolean> = {};
  for (const g of fleetGroups.value) m[g.id] = !!g.leader_id;
  return m;
});
const nodeGroupIds = computed<Record<string, string[]>>(() => {
  const m: Record<string, string[]> = {};
  for (const n of nodes.value) m[n.id] = n.group_ids ?? [];
  return m;
});

/** A node leads when it is a real group leader; else fall back to the role regex
 * ONLY when none of its groups names a leader. */
function isLeaderNode(id: string, role?: string): boolean {
  if (realLeaderIds.value.has(id)) return true;
  const gids = nodeGroupIds.value[id] ?? [];
  if (gids.some((gid) => groupHasLeader.value[gid])) return false;
  return isLeaderRole(role);
}

// Continent → Tailwind colour classes (class-based, no inline styles — CSP-safe).
interface RegionColor {
  dot: string; // SVG fill for node-ring accent + legend
  ring: string; // SVG stroke for leader/sector ring
  text: string; // SVG fill for the region label text
  arc: string; // SVG stroke for the sector arc
  bg: string; // HTML bg for the legend chip dot
}
const REGION_COLORS: Record<Continent, RegionColor> = {
  AS: { dot: "fill-sky-400", ring: "stroke-sky-400", text: "fill-sky-300", arc: "stroke-sky-400/50", bg: "bg-sky-400" },
  EU: { dot: "fill-violet-400", ring: "stroke-violet-400", text: "fill-violet-300", arc: "stroke-violet-400/50", bg: "bg-violet-400" },
  NA: { dot: "fill-emerald-400", ring: "stroke-emerald-400", text: "fill-emerald-300", arc: "stroke-emerald-400/50", bg: "bg-emerald-400" },
  SA: { dot: "fill-amber-400", ring: "stroke-amber-400", text: "fill-amber-300", arc: "stroke-amber-400/50", bg: "bg-amber-400" },
  AF: { dot: "fill-rose-400", ring: "stroke-rose-400", text: "fill-rose-300", arc: "stroke-rose-400/50", bg: "bg-rose-400" },
  OC: { dot: "fill-teal-400", ring: "stroke-teal-400", text: "fill-teal-300", arc: "stroke-teal-400/50", bg: "bg-teal-400" },
  AN: { dot: "fill-cyan-300", ring: "stroke-cyan-300", text: "fill-cyan-200", arc: "stroke-cyan-300/50", bg: "bg-cyan-300" },
  "??": { dot: "fill-slate-400", ring: "stroke-slate-400", text: "fill-slate-300", arc: "stroke-slate-400/50", bg: "bg-slate-400" },
};

const CONTINENT_ORDER: Continent[] = ["AS", "EU", "NA", "SA", "AF", "OC", "AN", "??"];

interface PlacedNode {
  id: string;
  name: string;
  online: boolean;
  disabled: boolean;
  leader: boolean;
  continent: Continent;
  color: RegionColor;
  x: number;
  y: number;
  r: number;
}

interface RegionArc {
  key: string;
  continent: Continent;
  glyph: string;
  color: RegionColor;
  path: string;
  lx: number;
  ly: number;
  total: number;
  online: number;
}

function polar(r: number, angle: number): { x: number; y: number } {
  return { x: GCX + r * Math.cos(angle), y: GCY + r * Math.sin(angle) };
}

function arcPath(r: number, a0: number, a1: number): string {
  const s = polar(r, a0);
  const e = polar(r, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(1)} ${e.y.toFixed(1)}`;
}

interface GraphLayout {
  nodes: PlacedNode[];
  arcs: RegionArc[];
}

const layout = computed<GraphLayout>(() => {
  const list = graph.value?.nodes ?? [];
  if (list.length === 0) return { nodes: [], arcs: [] };

  // Bucket by continent (preserving a stable continent order).
  const buckets = new Map<Continent, NetGraphNode[]>();
  for (const n of list) {
    const c = continentOf(n.geo?.country);
    const arr = buckets.get(c);
    if (arr) arr.push(n);
    else buckets.set(c, [n]);
  }
  const keys = CONTINENT_ORDER.filter((c) => buckets.has(c));

  const total = list.length;
  const gap = keys.length > 1 ? 0.16 : 0; // angular padding between regions
  const usable = Math.PI * 2 - gap * keys.length;
  const per = usable / total;

  const placed: PlacedNode[] = [];
  const arcs: RegionArc[] = [];
  let cursor = -Math.PI / 2; // start at the top, sweep clockwise

  for (const c of keys) {
    const members = buckets.get(c)!;
    const color = REGION_COLORS[c];
    const a0 = cursor;
    for (const gn of members) {
      const meta = nodeMetaById.value[gn.id];
      const leader = isLeaderNode(gn.id, meta?.role);
      const p = polar(RING, cursor + per / 2);
      placed.push({
        id: gn.id,
        name: gn.name || gn.id,
        online: gn.online,
        disabled: !!meta?.disabled,
        leader,
        continent: c,
        color,
        x: p.x,
        y: p.y,
        r: leader ? LEADER_R : NODE_R,
      });
      cursor += per;
    }
    const a1 = cursor;
    const mid = (a0 + a1) / 2;
    const lp = polar(REGION_LABEL_R, mid);
    arcs.push({
      key: `arc:${c}`,
      continent: c,
      glyph: continentGlyph(c),
      color,
      path: arcPath(REGION_ARC_R, a0 + 0.03, a1 - 0.03),
      lx: lp.x,
      ly: lp.y,
      total: members.length,
      online: members.filter((n) => n.online).length,
    });
    cursor += gap;
  }

  return { nodes: placed, arcs };
});

const placedNodes = computed(() => layout.value.nodes);
const regionArcs = computed(() => layout.value.arcs);
const leaderCount = computed(() => placedNodes.value.filter((n) => n.leader).length);

const nodePosById = computed<Record<string, PlacedNode>>(() => {
  const map: Record<string, PlacedNode> = {};
  for (const node of placedNodes.value) map[node.id] = node;
  return map;
});

// Management spokes: every outbound-only agent dials the control plane.
interface Spoke {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  leader: boolean;
}
const spokes = computed<Spoke[]>(() =>
  placedNodes.value.map((n) => {
    const dx = n.x - GCX;
    const dy = n.y - GCY;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    return {
      key: `spoke:${n.id}`,
      x1: GCX + ux * HUB_R,
      y1: GCY + uy * HUB_R,
      x2: n.x - ux * n.r,
      y2: n.y - uy * n.r,
      leader: n.leader,
    };
  }),
);

// Policy edges: node→node allow/deny, bowed outward so they clear the hub.
interface DrawnEdge {
  key: string;
  path: string;
  mx: number;
  my: number;
  allow: boolean;
  label: string;
}
const drawnEdges = computed<DrawnEdge[]>(() => {
  const edges = graph.value?.edges ?? [];
  const out: DrawnEdge[] = [];
  for (const edge of edges) {
    const from = nodePosById.value[edge.from];
    const to = nodePosById.value[edge.to];
    if (!from || !to || from.id === to.id) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const x1 = from.x + ux * from.r;
    const y1 = from.y + uy * from.r;
    const x2 = to.x - ux * (to.r + 6);
    const y2 = to.y - uy * (to.r + 6);
    const mx0 = (x1 + x2) / 2;
    const my0 = (y1 + y2) / 2;
    const outward = Math.hypot(mx0 - GCX, my0 - GCY) || 1;
    const bow = 28;
    const qx = mx0 + ((mx0 - GCX) / outward) * bow;
    const qy = my0 + ((my0 - GCY) / outward) * bow;
    const portLabel = edge.ports?.length ? `:${edge.ports.join(",")}` : "";
    out.push({
      key: `${edge.rule_id}:${edge.from}->${edge.to}`,
      path: `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`,
      mx: qx,
      my: qy,
      allow: edge.action === "allow",
      label: `${edge.protocol}${portLabel}`,
    });
  }
  return out;
});

const externals = computed(() => graph.value?.externals ?? []);
const hasGraphEdges = computed(() => drawnEdges.value.length > 0);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.policy.title')"
      :description="$t('networking.policy.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="policiesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="policiesQuery.refreshing.value"
          @click="policiesQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', policiesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <template v-if="tab === 'matrix' && canAdmin">
          <Button
            variant="outline"
            size="sm"
            :disabled="planningGroups || !hasGroupPolicies"
            @click="planGroupPolicies"
          >
            <RefreshCw v-if="planningGroups" class="size-4 animate-spin" aria-hidden="true" />
            <Play v-else class="size-4" aria-hidden="true" />
            {{ $t('networking.matrix.planAll') }}
          </Button>
          <Button size="sm" :disabled="!hasGroups" @click="newGroupPolicy">
            <Plus class="size-4" aria-hidden="true" />
            {{ $t('networking.matrix.newGroupPolicy') }}
          </Button>
        </template>
        <Button v-else-if="tab === 'policies' && canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.policy.newPolicy') }}
        </Button>
      </template>
    </PageHeader>

    <Tabs :model-value="tab" @update:model-value="onTabChange">
      <TabsList>
        <TabsTrigger value="matrix">{{ $t('networking.matrix.tab') }}</TabsTrigger>
        <TabsTrigger value="policies">{{ $t('networking.policy.tabPolicies') }}</TabsTrigger>
        <TabsTrigger value="graph">{{ $t('networking.policy.tabGraph') }}</TabsTrigger>
      </TabsList>

      <!-- Matrix tab (default): who-can-reach-whom across groups -->
      <TabsContent value="matrix" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Network class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('networking.matrix.title') }}
            </CardTitle>
            <CardDescription>{{ $t('networking.matrix.description') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="matrixQuery.loading.value"
              :error="matrixQuery.error.value"
              :has-data="matrix !== undefined"
              :is-empty="!hasGroups"
              :empty-title="$t('networking.matrix.emptyGroupsTitle')"
              :empty-description="$t('networking.matrix.emptyGroupsDescription')"
              @retry="refreshMatrix"
            >
              <template #empty>
                <EmptyState
                  :icon="FolderTree"
                  :title="$t('networking.matrix.emptyGroupsTitle')"
                  :description="$t('networking.matrix.emptyGroupsDescription')"
                >
                  <Button size="sm" @click="goToGroups">
                    <FolderTree class="size-4" aria-hidden="true" />
                    {{ $t('networking.matrix.goToGroups') }}
                  </Button>
                </EmptyState>
              </template>

              <div class="space-y-4">
                <div
                  v-if="!hasGroupPolicies"
                  class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3 text-sm text-muted-foreground"
                >
                  <span>{{ $t('networking.matrix.noPoliciesHint') }}</span>
                  <Button v-if="canAdmin" size="sm" variant="outline" @click="newGroupPolicy">
                    <Plus class="size-4" aria-hidden="true" />
                    {{ $t('networking.matrix.newGroupPolicy') }}
                  </Button>
                </div>
                <PolicyMatrix
                  v-if="matrix"
                  :matrix="matrix"
                  :direction="matrixDirection"
                  :can-admin="canAdmin"
                  @update:direction="setMatrixDirection"
                  @edit="openCellEditor"
                />
              </div>
            </DataState>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Policies tab -->
      <TabsContent value="policies" class="mt-4">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Network class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('networking.policy.nodePolicies') }}
            </CardTitle>
            <CardDescription>
              {{ $t('networking.policy.nodePoliciesHint') }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              :columns="policyColumns"
              :rows="sortedPolicies"
              :row-key="(p) => p.target_node_id"
              :loading="policiesQuery.loading.value"
              :error="policiesQuery.error.value"
              searchable
              :search-placeholder="$t('common.actions.search')"
              :empty-title="$t('networking.policy.emptyTitle')"
              :empty-description="canRead ? $t('networking.policy.emptyWithRead') : $t('networking.policy.emptyNeedRead')"
              :no-match-title="$t('networking.shared.noMatchTitle')"
              :no-match-description="$t('networking.shared.noMatchDescription')"
              :actions-label="$t('networking.policy.colActions')"
              @retry="policiesQuery.refresh"
            >
              <template #cell-target="{ row: p }">
                <div class="font-medium">{{ policyNodeLabel(p) }}</div>
                <div class="font-mono text-xs text-muted-foreground">{{ shortId(p.target_node_id, 16) }}</div>
              </template>
              <template #cell-enabled="{ row: p }">
                <Badge :variant="p.enabled ? 'success' : 'secondary'">
                  {{ p.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
                </Badge>
              </template>
              <template #cell-rules="{ row: p }">
                <span class="tabular-nums">{{ activeRuleCount(p) }} / {{ p.rules.length }}</span>
              </template>
              <template #cell-last_plan="{ row: p }">
                <span class="font-mono text-xs text-muted-foreground">{{ p.last_plan_sha ? shortId(p.last_plan_sha, 12) : "—" }}</span>
              </template>
              <template #cell-last_applied="{ row: p }">
                <span class="text-xs text-muted-foreground">{{ p.last_applied_at ? formatDateTime(p.last_applied_at) : "—" }}</span>
              </template>
              <template #cell-last_error="{ row: p }">
                <span v-if="p.last_error" class="text-xs text-destructive">{{ p.last_error }}</span>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </template>
              <template #cell-actions="{ row: p }">
                <div class="flex items-center justify-end gap-1">
                  <Button
                    v-if="canAdmin"
                    variant="outline"
                    size="sm"
                    :disabled="planning === p.target_node_id"
                    @click="plan(p)"
                  >
                    <RefreshCw v-if="planning === p.target_node_id" class="size-4 animate-spin" aria-hidden="true" />
                    <Play v-else class="size-4" aria-hidden="true" />
                    {{ $t('networking.shared.plan') }}
                  </Button>
                  <Button
                    v-if="canAdmin"
                    variant="ghost"
                    size="icon-sm"
                    :aria-label="$t('common.actions.edit')"
                    @click="openEdit(p)"
                  >
                    <Pencil class="size-4" />
                  </Button>
                  <Button
                    v-if="canAdmin"
                    variant="ghost"
                    size="icon-sm"
                    :aria-label="$t('common.actions.delete')"
                    @click="deleteTarget = p"
                  >
                    <Trash2 class="size-4 text-destructive" />
                  </Button>
                </div>
              </template>
            </DataTable>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- Topology graph tab -->
      <TabsContent value="graph" class="mt-4">
        <Card>
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle class="flex items-center gap-2">
                  <Network class="size-4 text-muted-foreground" aria-hidden="true" />
                  {{ $t('networking.policy.graphTitle') }}
                </CardTitle>
                <CardDescription>
                  {{ $t('networking.policy.graphHint') }}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                :disabled="graphQuery.refreshing.value"
                @click="graphQuery.refresh"
              >
                <RefreshCw :class="cn('size-4', graphQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
                {{ $t('networking.policy.reloadGraph') }}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="graphQuery.loading.value"
              :error="graphQuery.error.value"
              :has-data="graphQuery.data.value !== undefined"
              :is-empty="(graph?.nodes.length ?? 0) === 0"
              :empty-title="$t('networking.policy.graphEmptyTitle')"
              :empty-description="$t('networking.policy.graphEmptyDescription')"
              @retry="graphQuery.refresh"
            >
              <div class="space-y-4">
                <!-- Legend -->
                <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  <span class="inline-flex items-center gap-1.5">
                    <svg viewBox="0 0 16 16" class="size-3.5"><circle cx="8" cy="8" r="6" class="fill-card stroke-primary" stroke-width="1.5" /></svg>
                    {{ $t('networking.policy.legendServer') }}
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-0 w-6 border-t border-dashed border-muted-foreground"></span> {{ $t('networking.policy.legendMgmt') }}
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-0.5 w-6 rounded bg-success"></span> {{ $t('networking.policy.legendAllow') }}
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-0.5 w-6 rounded bg-destructive"></span> {{ $t('networking.policy.legendDeny') }}
                  </span>
                  <span v-if="leaderCount > 0" class="inline-flex items-center gap-1.5">
                    <span class="text-amber-400">★</span> {{ $t('networking.policy.legendLeader') }}
                  </span>
                </div>

                <!-- Region chips: which clusters are present, with online/total. -->
                <div v-if="regionArcs.length" class="flex flex-wrap gap-2">
                  <span
                    v-for="arc in regionArcs"
                    :key="`chip-${arc.key}`"
                    class="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2.5 py-0.5 text-xs"
                  >
                    <span :class="cn('inline-block size-2 rounded-full', arc.color.bg)"></span>
                    {{ arc.glyph }} {{ $t(`common.regions.${arc.continent === '??' ? 'unknown' : arc.continent}`) }}
                    <span class="font-mono text-muted-foreground">{{ arc.online }}/{{ arc.total }}</span>
                  </span>
                </div>

                <!-- Hub-and-spoke node-link diagram, clustered by region -->
                <div class="overflow-x-auto rounded-lg border border-border bg-muted/10 p-2">
                  <svg
                    :viewBox="`0 0 ${GRAPH_W} ${GRAPH_H}`"
                    class="mx-auto block h-[540px] w-full max-w-[860px]"
                    role="img"
                    :aria-label="$t('networking.policy.graphAriaLabel')"
                  >
                    <defs>
                      <marker
                        id="arrow-allow"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M0,0 L10,5 L0,10 z" class="fill-success" />
                      </marker>
                      <marker
                        id="arrow-deny"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M0,0 L10,5 L0,10 z" class="fill-destructive" />
                      </marker>
                    </defs>

                    <!-- region sector arcs + labels -->
                    <g v-for="arc in regionArcs" :key="arc.key">
                      <path :d="arc.path" fill="none" :class="arc.color.arc" stroke-width="3" stroke-linecap="round" />
                      <text
                        :x="arc.lx"
                        :y="arc.ly"
                        text-anchor="middle"
                        :class="cn('text-[11px] font-semibold', arc.color.text)"
                      >
                        {{ arc.glyph }} {{ $t(`common.regions.${arc.continent === '??' ? 'unknown' : arc.continent}`) }} · {{ arc.online }}/{{ arc.total }}
                      </text>
                    </g>

                    <!-- management spokes (control plane → each agent) -->
                    <line
                      v-for="s in spokes"
                      :key="s.key"
                      :x1="s.x1"
                      :y1="s.y1"
                      :x2="s.x2"
                      :y2="s.y2"
                      :class="s.leader ? 'stroke-primary/45' : 'stroke-border'"
                      :stroke-width="s.leader ? 1.4 : 1"
                      stroke-dasharray="2 4"
                    />

                    <!-- policy edges -->
                    <g v-if="hasGraphEdges">
                      <g v-for="edge in drawnEdges" :key="edge.key">
                        <path
                          :d="edge.path"
                          fill="none"
                          :class="edge.allow ? 'stroke-success' : 'stroke-destructive'"
                          stroke-width="1.8"
                          :marker-end="edge.allow ? 'url(#arrow-allow)' : 'url(#arrow-deny)'"
                          :stroke-dasharray="edge.allow ? '0' : '5 4'"
                        />
                        <text
                          :x="edge.mx"
                          :y="edge.my - 3"
                          text-anchor="middle"
                          class="fill-muted-foreground text-[9px]"
                        >
                          {{ edge.label }}
                        </text>
                      </g>
                    </g>

                    <!-- control-plane hub (the server) -->
                    <g>
                      <circle :cx="GCX" :cy="GCY" :r="HUB_R + 9" class="fill-primary/5" />
                      <circle :cx="GCX" :cy="GCY" :r="HUB_R" class="fill-card stroke-primary" stroke-width="2" />
                      <rect :x="GCX - 9" :y="GCY - 10" width="18" height="7" rx="2" class="fill-primary/80" />
                      <rect :x="GCX - 9" :y="GCY - 1" width="18" height="7" rx="2" class="fill-primary/55" />
                      <circle :cx="GCX - 5" :cy="GCY - 6.5" r="1" class="fill-card" />
                      <circle :cx="GCX - 5" :cy="GCY + 2.5" r="1" class="fill-card" />
                      <text :x="GCX" :y="GCY + HUB_R + 16" text-anchor="middle" class="fill-foreground text-[11px] font-semibold">
                        {{ $t('networking.policy.controlPlane') }}
                      </text>
                      <text :x="GCX" :y="GCY + HUB_R + 30" text-anchor="middle" class="fill-muted-foreground text-[9px]">
                        {{ serverHost }}
                      </text>
                    </g>

                    <!-- nodes -->
                    <g v-for="node in placedNodes" :key="node.id">
                      <circle
                        v-if="node.leader"
                        :cx="node.x"
                        :cy="node.y"
                        :r="node.r + 4"
                        fill="none"
                        :class="node.color.ring"
                        stroke-width="1.5"
                        stroke-dasharray="3 3"
                      />
                      <circle
                        :cx="node.x"
                        :cy="node.y"
                        :r="node.r"
                        :class="cn('fill-card', node.disabled ? 'opacity-50' : '')"
                        class="stroke-border"
                        stroke-width="1.5"
                      />
                      <circle
                        :cx="node.x"
                        :cy="node.y - node.r + 6"
                        r="4"
                        :class="!node.disabled && node.online ? 'fill-success' : 'fill-muted-foreground'"
                      />
                      <text
                        :x="node.x"
                        :y="node.y + 3"
                        text-anchor="middle"
                        class="fill-foreground text-[10px] font-medium"
                      >
                        {{ node.name.length > 9 ? node.name.slice(0, 8) + "…" : node.name }}
                      </text>
                      <text
                        v-if="node.leader"
                        :x="node.x"
                        :y="node.y + node.r + 11"
                        text-anchor="middle"
                        :class="cn('text-[8px] font-semibold', node.color.text)"
                      >
                        ★ {{ $t('networking.policy.leader') }}
                      </text>
                    </g>
                  </svg>
                  <p v-if="!hasGraphEdges" class="pb-2 text-center text-xs text-muted-foreground">
                    {{ $t('networking.policy.noEdges') }}
                  </p>
                </div>

                <!-- Externals adjacency table -->
                <div v-if="externals.length" class="overflow-x-auto rounded-lg border border-border">
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.policy.extTargetNode') }}</th>
                        <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.policy.extDirection') }}</th>
                        <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.policy.extAction') }}</th>
                        <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.policy.extRemote') }}</th>
                        <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.policy.extProtocol') }}</th>
                        <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.policy.extPorts') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="ext in externals"
                        :key="`${ext.rule_id}:${ext.target_node_id}:${ext.remote}`"
                        class="border-b border-border last:border-b-0 hover:bg-muted/40"
                      >
                        <td class="px-3 py-2">{{ nodeName(ext.target_node_id) }}</td>
                        <td class="px-3 py-2 text-xs">{{ ext.direction }}</td>
                        <td class="px-3 py-2">
                          <Badge :variant="ext.action === 'allow' ? 'success' : 'destructive'">{{ ext.action }}</Badge>
                        </td>
                        <td class="px-3 py-2 font-mono text-xs">{{ ext.remote }}</td>
                        <td class="px-3 py-2 text-xs">{{ ext.protocol }}</td>
                        <td class="px-3 py-2 font-mono text-xs">{{ ext.ports?.length ? ext.ports.join(", ") : $t('common.misc.all') }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </DataState>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- Create / edit policy dialog -->
    <Dialog :open="dialogOpen" @update:open="onDialogOpenChange">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('networking.policy.editTitle') : $t('networking.policy.newTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.policy.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submit">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="policy-node">{{ $t('networking.policy.targetNode') }}</Label>
              <Select v-model="form.target_node_id" :disabled="!!editingId">
                <SelectTrigger id="policy-node" class="w-full">
                  <SelectValue :placeholder="$t('networking.policy.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label>{{ $t('networking.policy.policyState') }}</Label>
              <label class="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
                {{ $t('networking.policy.enabled') }}
              </label>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <Label>{{ $t('networking.policy.rules') }}</Label>
              <Button type="button" variant="outline" size="sm" @click="addRule">
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('networking.policy.addRule') }}
              </Button>
            </div>

            <p v-if="form.rules.length === 0" class="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              {{ $t('networking.policy.noRules') }}
            </p>

            <div
              v-for="(rule, index) in form.rules"
              :key="index"
              class="space-y-3 rounded-lg border border-border p-3"
            >
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-muted-foreground">{{ $t('networking.policy.ruleLabel', { index: index + 1 }) }}</span>
                <Button type="button" variant="ghost" size="icon-sm" :aria-label="$t('networking.policy.removeRule')" @click="removeRule(index)">
                  <Trash2 class="size-4 text-destructive" />
                </Button>
              </div>

              <div class="grid gap-3 sm:grid-cols-3">
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.action') }}</Label>
                  <Select v-model="rule.action">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow">allow</SelectItem>
                      <SelectItem value="deny">deny</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.direction') }}</Label>
                  <Select v-model="rule.direction">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="egress">egress</SelectItem>
                      <SelectItem value="ingress">ingress</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.protocol') }}</Label>
                  <Select v-model="rule.protocol">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tcp">tcp</SelectItem>
                      <SelectItem value="udp">udp</SelectItem>
                      <SelectItem value="any">any</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.ports') }}</Label>
                  <Input
                    v-model="rule.ports"
                    :disabled="rule.protocol === 'any'"
                    :placeholder="$t('networking.policy.portsPlaceholder')"
                  />
                </div>
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.remoteKind') }}</Label>
                  <Select v-model="rule.remoteKind">
                    <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="node">node</SelectItem>
                      <SelectItem value="cidr">cidr</SelectItem>
                      <SelectItem value="domain">domain</SelectItem>
                      <SelectItem value="any">any</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div v-if="rule.remoteKind === 'node'" class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.policy.remoteNode') }}</Label>
                <Select v-model="rule.remoteNodeId">
                  <SelectTrigger class="w-full"><SelectValue :placeholder="$t('networking.policy.selectNode')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                      {{ node.name || node.id }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-else-if="rule.remoteKind === 'cidr'" class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.policy.remoteCidr') }}</Label>
                <Input v-model="rule.remoteCidr" placeholder="10.0.0.0/24 or 1.2.3.4" />
              </div>
              <div v-else-if="rule.remoteKind === 'domain'" class="grid gap-1.5">
                <Label class="text-xs">{{ $t('networking.policy.remoteDomain') }}</Label>
                <Input v-model="rule.remoteDomain" placeholder="api.example.com" />
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label class="text-xs">{{ $t('networking.policy.comment') }}</Label>
                  <Input v-model="rule.comment" :placeholder="$t('networking.policy.commentPlaceholder')" />
                </div>
                <label class="flex items-center gap-2 self-end pb-2 text-sm">
                  <input v-model="rule.disabled" type="checkbox" class="size-4 accent-primary" />
                  {{ $t('networking.policy.disabled') }}
                </label>
              </div>

              <p v-if="formErrors[index]" class="text-xs text-destructive">{{ formErrors[index] }}</p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="requestCloseDialog">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ editingId ? $t('common.actions.saveChanges') : $t('networking.policy.createPolicy') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Unsaved-changes (dirty) guard -->
    <ConfirmDialog
      :open="discardConfirmOpen"
      variant="destructive"
      :title="$t('networking.policy.discardTitle')"
      :description="$t('networking.policy.discardDescription')"
      :confirm-label="$t('networking.policy.discardConfirm')"
      :cancel-label="$t('common.actions.cancel')"
      @update:open="(v) => { if (!v) discardConfirmOpen = false; }"
      @confirm="confirmDiscard"
    />

    <!-- Delete confirm dialog -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.policy.deleteTitle')"
      :description="`${$t('networking.policy.deleteDescription')} ${deleteTarget ? policyNodeLabel(deleteTarget) : ''}? ${$t('networking.policy.deleteIrreversible')}`"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Plan review dialog -->
    <PlanReviewDialog
      :open="!!planApproval"
      :plan-text="planApproval?.plan"
      :digest="planSha"
      :badges="planBadges"
      :title="$t('networking.shared.planCreated')"
      :description="$t('networking.shared.planReviewHint')"
      :plan-label="$t('networking.shared.planLabel')"
      :close-label="$t('common.actions.close')"
      :approvals-label="$t('networking.shared.goToApprovals')"
      approvals-to="/approvals"
      @update:open="closePlan"
    />

    <!-- Group-policy cell editor (source group → dest group) -->
    <PolicyCellEditor
      v-if="cellSource && cellDest"
      :open="cellEditorOpen"
      :source="cellSource"
      :dest="cellDest"
      :direction="matrixDirection"
      :existing="cellSourcePolicy"
      :saving="savingCell"
      :can-admin="canAdmin"
      @update:open="(v) => (cellEditorOpen = v)"
      @save="saveCell"
    />

    <!-- Group-policy plan summary -->
    <Dialog :open="planResultOpen" @update:open="(v) => (planResultOpen = v)">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.matrix.planResultTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('networking.matrix.planResultDescription') }}</DialogDescription>
        </DialogHeader>
        <div v-if="planResult" class="space-y-4 text-sm">
          <div class="flex flex-wrap gap-2">
            <Badge variant="success">{{ $t('networking.matrix.planAffected', { n: planResult.affected.length }) }}</Badge>
            <Badge v-if="planResult.conflicts.length" variant="warning">{{ $t('networking.matrix.planConflicts', { n: planResult.conflicts.length }) }}</Badge>
            <Badge v-if="planResult.orphaned.length" variant="secondary">{{ $t('networking.matrix.planOrphaned', { n: planResult.orphaned.length }) }}</Badge>
          </div>
          <div v-if="planResult.affected.length" class="space-y-1">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('networking.matrix.planAffectedNodes') }}</p>
            <ul class="space-y-1">
              <li
                v-for="a in planResult.affected"
                :key="a.approval_id"
                class="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <span class="truncate">{{ nodeName(a.node_id) }}</span>
                <span class="font-mono text-xs text-muted-foreground">{{ shortId(a.plan_sha, 10) }}</span>
              </li>
            </ul>
          </div>
          <div v-if="planResult.conflicts.length" class="space-y-1">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('networking.matrix.planConflictsTitle') }}</p>
            <ul class="space-y-1">
              <li
                v-for="(c, i) in planResult.conflicts"
                :key="i"
                class="rounded-md border border-warning/40 bg-warning/5 px-2 py-1.5 text-xs"
              >
                <span class="font-medium">{{ nodeName(c.node_id) }}</span> — {{ c.reason }}
              </li>
            </ul>
          </div>
          <p v-if="!planResult.affected.length && !planResult.conflicts.length" class="text-muted-foreground">
            {{ $t('networking.matrix.planNoop') }}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="planResultOpen = false">{{ $t('common.actions.close') }}</Button>
          <Button @click="() => { planResultOpen = false; router.push('/approvals'); }">
            {{ $t('networking.shared.goToApprovals') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
