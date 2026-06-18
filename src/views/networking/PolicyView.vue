<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
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
  type NetEndpointKind,
  type NetPolicyGraph,
  type NetPolicyUpsertRequest,
  type NetPolicyView,
  type NetRule,
  type NetRuleAction,
  type NetRuleDirection,
  type NetRuleProtocol,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import DataState from "@/components/common/DataState.vue";
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

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("netpolicy:read"));
const canAdmin = computed(() => auth.can("netpolicy:admin"));

const tab = ref<"policies" | "graph">("policies");

const policiesQuery = useAsyncData(() => api.netpolicy.list().then((r) => unwrap(r, "policies")), {
  pollInterval: 15000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});
const graphQuery = useAsyncData(() => api.netpolicy.graph(), { immediate: false });

const policies = computed(() => policiesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

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
  const next = String(value) as "policies" | "graph";
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

// ── Topology graph (CSP-safe inline SVG, circular layout) ─────────────────
const GRAPH_SIZE = 640;
const GRAPH_CENTER = GRAPH_SIZE / 2;
const GRAPH_RADIUS = 220;
const NODE_RADIUS = 26;

interface PlacedNode {
  id: string;
  name: string;
  online: boolean;
  x: number;
  y: number;
}

const graph = computed<NetPolicyGraph | undefined>(() => graphQuery.data.value);

const placedNodes = computed<PlacedNode[]>(() => {
  const list = graph.value?.nodes ?? [];
  const count = Math.max(1, list.length);
  return list.map((node, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    return {
      id: node.id,
      name: node.name || node.id,
      online: node.online,
      x: GRAPH_CENTER + GRAPH_RADIUS * Math.cos(angle),
      y: GRAPH_CENTER + GRAPH_RADIUS * Math.sin(angle),
    };
  });
});

const nodePosById = computed<Record<string, PlacedNode>>(() => {
  const map: Record<string, PlacedNode> = {};
  for (const node of placedNodes.value) map[node.id] = node;
  return map;
});

interface DrawnEdge {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  allow: boolean;
  label: string;
}

/** Shorten an edge so its endpoint sits on the node ring (so arrows are visible). */
function trimToRing(
  from: PlacedNode,
  to: PlacedNode,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  return {
    x1: from.x + ux * NODE_RADIUS,
    y1: from.y + uy * NODE_RADIUS,
    x2: to.x - ux * (NODE_RADIUS + 6),
    y2: to.y - uy * (NODE_RADIUS + 6),
  };
}

const drawnEdges = computed<DrawnEdge[]>(() => {
  const edges = graph.value?.edges ?? [];
  const out: DrawnEdge[] = [];
  for (const edge of edges) {
    const from = nodePosById.value[edge.from];
    const to = nodePosById.value[edge.to];
    if (!from || !to || from.id === to.id) continue;
    const seg = trimToRing(from, to);
    const portLabel = edge.ports?.length ? `:${edge.ports.join(",")}` : "";
    out.push({
      key: `${edge.rule_id}:${edge.from}->${edge.to}`,
      ...seg,
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
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.policy.newPolicy') }}
        </Button>
      </template>
    </PageHeader>

    <Tabs :model-value="tab" @update:model-value="onTabChange">
      <TabsList>
        <TabsTrigger value="policies">{{ $t('networking.policy.tabPolicies') }}</TabsTrigger>
        <TabsTrigger value="graph">{{ $t('networking.policy.tabGraph') }}</TabsTrigger>
      </TabsList>

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
              <div class="space-y-6">
                <!-- Legend -->
                <div class="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-0.5 w-6 rounded bg-success"></span> {{ $t('networking.policy.legendAllow') }}
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block h-0.5 w-6 rounded bg-destructive"></span> {{ $t('networking.policy.legendDeny') }}
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block size-2 rounded-full bg-success"></span> {{ $t('networking.policy.legendOnline') }}
                  </span>
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block size-2 rounded-full bg-muted-foreground"></span> {{ $t('networking.policy.legendOffline') }}
                  </span>
                </div>

                <!-- Circular node-link diagram -->
                <div class="overflow-x-auto rounded-lg border border-border bg-muted/10 p-2">
                  <svg
                    :viewBox="`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`"
                    class="mx-auto block h-[480px] w-full max-w-[640px]"
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

                    <!-- edges -->
                    <g v-if="hasGraphEdges">
                      <g v-for="edge in drawnEdges" :key="edge.key">
                        <line
                          :x1="edge.x1"
                          :y1="edge.y1"
                          :x2="edge.x2"
                          :y2="edge.y2"
                          :class="edge.allow ? 'stroke-success' : 'stroke-destructive'"
                          stroke-width="1.6"
                          :marker-end="edge.allow ? 'url(#arrow-allow)' : 'url(#arrow-deny)'"
                          :stroke-dasharray="edge.allow ? '0' : '5 4'"
                        />
                        <text
                          :x="(edge.x1 + edge.x2) / 2"
                          :y="(edge.y1 + edge.y2) / 2 - 3"
                          text-anchor="middle"
                          class="fill-muted-foreground text-[9px]"
                        >
                          {{ edge.label }}
                        </text>
                      </g>
                    </g>

                    <!-- nodes -->
                    <g v-for="node in placedNodes" :key="node.id">
                      <circle
                        :cx="node.x"
                        :cy="node.y"
                        :r="NODE_RADIUS"
                        class="fill-card stroke-border"
                        stroke-width="1.5"
                      />
                      <circle
                        :cx="node.x"
                        :cy="node.y - NODE_RADIUS + 6"
                        r="4"
                        :class="node.online ? 'fill-success' : 'fill-muted-foreground'"
                      />
                      <text
                        :x="node.x"
                        :y="node.y + 4"
                        text-anchor="middle"
                        class="fill-foreground text-[10px] font-medium"
                      >
                        {{ node.name.length > 10 ? node.name.slice(0, 9) + "…" : node.name }}
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
  </div>
</template>
