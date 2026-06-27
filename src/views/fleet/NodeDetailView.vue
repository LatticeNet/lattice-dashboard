<script setup lang="ts">
/**
 * NodeDetailView — the deep-linkable, full-page node detail (route
 * `node-detail`, path `/nodes/:id`). Replaces the cramped `?node=` modal that
 * used to live in NodesView: a whole node card now navigates here.
 *
 * The server exposes NO single-node GET, so v1 sources the node by finding it in
 * the polled `api.nodes.list()` (~5s, same cadence as the other fleet views) and
 * synthesizes an in-session sparkline from the shared {@link useMetricBuffer}.
 * Side panels (groups / DDNS / agent-updates / audit) are softened on 403 so a
 * read-only operator sees a quiet section rather than an error wall.
 */
import { computed, watch, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Clock,
  Crown,
  DownloadCloud,
  FolderTree,
  Gauge,
  Globe,
  KeyRound,
  MapPin,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  ScrollText,
  SquareTerminal,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  ApiError,
  type Node,
  type GroupView,
  type DDNSView,
  type AgentUpdatePolicy,
  type AuditEvent,
  type NodeDeletePlanView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMetricBuffer } from "@/composables/useMetricBuffer";
import { useAuthStore } from "@/stores/auth";
import { nodeStatusMeta } from "@/lib/status";
import { groupColor } from "@/lib/groupColors";
import {
  formatBytes,
  formatBytesPerSec,
  formatDateTime,
  formatRelativeTime,
  formatDuration,
  formatPercent,
  ratio,
  shortId,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import MetricBar from "@/components/common/MetricBar.vue";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const nodeId = computed(() => String(route.params.id ?? ""));

const canAdminNodes = computed(() => auth.can("node:admin"));
const canOpenTerminal = computed(() => auth.can("terminal:open"));

/** Treat 403 as "section not visible" rather than a hard error (per OverviewView). */
function soften<T>(fetcher: () => Promise<T>) {
  return async (): Promise<T | undefined> => {
    try {
      return await fetcher();
    } catch (e) {
      if (e instanceof ApiError && e.isForbidden) return undefined;
      throw e;
    }
  };
}

/* ----------------------------------------------------------------- */
/* Data sources — node list is the spine; the rest are softened side  */
/* panels keyed off this node's id.                                    */
/* ----------------------------------------------------------------- */
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
});

const groupsQuery = useAsyncData<GroupView[] | undefined>(
  soften(() => api.groups.list().then((r) => r.groups)),
);

const ddnsQuery = useAsyncData<DDNSView[] | undefined>(soften(() => api.ddns.list()));

const agentUpdatesQuery = useAsyncData<AgentUpdatePolicy[] | undefined>(
  soften(() => api.agentUpdates.list().then((r) => unwrap(r, "policies"))),
);

const auditQuery = useAsyncData<AuditEvent[] | undefined>(
  soften(() => api.audit.query({ node_id: nodeId.value, limit: 20 }).then((r) => r.events ?? [])),
  { pollInterval: 15000 },
);

const node = computed<Node | undefined>(() =>
  (nodesQuery.data.value ?? []).find((n) => n.id === nodeId.value),
);

/** List has loaded but no node carries this id → render a "not found" state. */
const notFound = computed(
  () => nodesQuery.data.value !== undefined && !nodesQuery.loading.value && !node.value,
);

/** A disabled node is operationally down even if the agent last reported online. */
const isLive = computed(() => !!node.value?.online && !node.value?.disabled);
const meta = computed(() => nodeStatusMeta(node.value ?? { online: false }));

const statusBadge = computed(() => {
  if (node.value?.disabled) return { variant: "secondary" as const, label: t("common.status.disabled") };
  return {
    variant: meta.value.badgeVariant,
    label: node.value?.online ? t("common.status.online") : t("common.status.offline"),
  };
});

/* Feed each poll into the shared ring so the sparkline accrues history. */
const metricBuffer = useMetricBuffer();
watch(
  () => nodesQuery.data.value,
  (list) => {
    for (const n of list ?? []) metricBuffer.record(n.id, n.metrics);
  },
  { immediate: true },
);

/* ----------------------------------------------------------------- */
/* In-session CPU sparkline (inline SVG, CSP-safe — same approach as   */
/* NodeCard) from the shared metric buffer.                            */
/* ----------------------------------------------------------------- */
const SPARK_W = 240;
const SPARK_H = 44;
const cpuSeries = computed(() =>
  metricBuffer
    .series(nodeId.value, "cpu")
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
);
const hasSpark = computed(() => cpuSeries.value.length >= 2);
const sparkPoints = computed(() => {
  const vs = cpuSeries.value;
  if (vs.length < 2) return "";
  const pad = 3;
  const usable = SPARK_H - pad * 2;
  const max = Math.max(100, ...vs);
  const min = 0;
  const span = max - min || 1;
  return vs
    .map((v, i) => {
      const x = (i / (vs.length - 1)) * SPARK_W;
      const y = pad + (1 - (v - min) / span) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
});

/* ----------------------------------------------------------------- */
/* Derived side-panel data.                                            */
/* ----------------------------------------------------------------- */
const groupBadges = computed(() => {
  const ids = node.value?.group_ids ?? [];
  const all = groupsQuery.data.value ?? [];
  return ids.map((id) => {
    const g = all.find((x) => x.id === id);
    return { id, name: g?.name ?? id, color: g?.color, leader: !!g && g.leader_id === nodeId.value };
  });
});

/* ----------------------------------------------------------------- */
/* Group membership management (Slice 4). api.groups.members needs    */
/* group:admin server-side, so the editor is gated on that scope.     */
/* ----------------------------------------------------------------- */
const canAdminGroups = computed(() => auth.can("group:admin"));
const allGroups = computed<GroupView[]>(() => groupsQuery.data.value ?? []);
const membershipPending = ref<string | undefined>(undefined);

/** Explicit (canonical) membership — the only thing the members endpoint edits. */
function isExplicitMember(g: GroupView): boolean {
  return (g.members ?? []).includes(nodeId.value);
}

async function toggleGroupMembership(g: GroupView) {
  if (!canAdminGroups.value || membershipPending.value) return;
  const adding = !isExplicitMember(g);
  membershipPending.value = g.id;
  try {
    await api.groups.members(g.id, adding ? [nodeId.value] : [], adding ? [] : [nodeId.value]);
    toast.success(adding ? t("fleet.nodes.detail.groupAdded") : t("fleet.nodes.detail.groupRemoved"));
    await Promise.all([groupsQuery.refresh(), nodesQuery.refresh()]);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.groupUpdateFailed"));
  } finally {
    membershipPending.value = undefined;
  }
}

/** Cross-link a group chip to the Groups page with that group pre-selected. */
function goToGroup(id: string) {
  router.push({ name: "groups", query: { selected: id } });
}

const nodeDdns = computed(() =>
  (ddnsQuery.data.value ?? []).filter((d) => d.node_id === nodeId.value),
);

const updatePolicy = computed(() =>
  (agentUpdatesQuery.data.value ?? []).find((p) => p.node_id === nodeId.value),
);

const auditEvents = computed(() => auditQuery.data.value ?? []);

function decisionVariant(d: string): "success" | "destructive" | "secondary" {
  if (d === "allow") return "success";
  if (d === "deny") return "destructive";
  return "secondary";
}

function geoSourceLabel(source?: string): string {
  if (source === "auto") return t("fleet.nodes.detail.geoSourceAuto");
  if (source === "operator" || !source) return t("fleet.nodes.detail.geoSourceOperator");
  return source;
}

const hasGeo = computed(() => {
  const g = node.value?.geo;
  return !!g && Object.values(g).some((v) => v !== undefined && v !== "" && v !== null);
});

/* ----------------------------------------------------------------- */
/* Navigation + mutations.                                             */
/* ----------------------------------------------------------------- */
function goBack() {
  router.push({ name: "nodes" });
}

function openTerminal() {
  if (!canOpenTerminal.value || !node.value || !node.value.online || node.value.disabled) return;
  router.push({ name: "terminal", query: { node_id: node.value.id, connect: "1" } });
}

function refreshAll() {
  nodesQuery.refresh();
  auditQuery.refresh();
  groupsQuery.refresh();
  ddnsQuery.refresh();
  agentUpdatesQuery.refresh();
}

const pending = ref(false);
const debugPending = ref(false);
const planningUpdate = ref(false);
const resolvingGeo = ref(false);
const rotatedToken = ref<{ node_id: string; token: string } | undefined>();

async function setDisabled(disabled: boolean) {
  if (!node.value) return;
  pending.value = true;
  try {
    await api.nodes.disable(node.value.id, disabled);
    toast.success(disabled ? t("fleet.nodes.toast.nodeDisabled") : t("fleet.nodes.toast.nodeEnabled"));
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.updateFailed"));
  } finally {
    pending.value = false;
  }
}

async function rotateToken() {
  if (!node.value) return;
  pending.value = true;
  rotatedToken.value = undefined;
  try {
    rotatedToken.value = await api.nodes.rotateToken(node.value.id);
    toast.success(t("fleet.nodes.toast.tokenRotated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.rotationFailed"));
  } finally {
    pending.value = false;
  }
}

/* ----------------------------------------------------------------- */
/* Hard delete (irreversible cascade). The flow previews the impact    */
/* via deletePlan, then gates the confirm button behind a type-the-    */
/* name check before calling delete and routing back to the fleet.     */
/* ----------------------------------------------------------------- */
const deleteOpen = ref(false);
const deletePending = ref(false);
const deletePlanning = ref(false);
const deletePlan = ref<NodeDeletePlanView | undefined>();
const deleteNameInput = ref("");

/** Count fields rendered as "label: N" rows, in cascade order. Only nonzero
 *  rows show, so a node with no dependents reads as a clean delete. */
const DELETE_COUNT_FIELDS: { key: string; field: keyof NodeDeletePlanView }[] = [
  { key: "tasksStripped", field: "tasks_stripped" },
  { key: "tasksDeleted", field: "tasks_deleted" },
  { key: "taskResults", field: "task_results" },
  { key: "ddnsProfiles", field: "ddns_profiles" },
  { key: "machineProfiles", field: "machine_profiles" },
  { key: "nftInputs", field: "nft_inputs" },
  { key: "dnsDeployments", field: "dns_deployments" },
  { key: "netPolicies", field: "net_policies" },
  { key: "netPeerRulesStripped", field: "net_peer_rules_stripped" },
  { key: "groupPolicyRulesStripped", field: "group_policy_rules_stripped" },
  { key: "geoRoutingStripped", field: "geo_routing_stripped" },
  { key: "geoRoutingDeleted", field: "geo_routing_deleted" },
  { key: "agentUpdatePolicies", field: "agent_update_policies" },
  { key: "proxyNodeProfiles", field: "proxy_node_profiles" },
  { key: "proxyUsageSnapshots", field: "proxy_usage_snapshots" },
  { key: "monitorsStripped", field: "monitors_stripped" },
  { key: "monitorResults", field: "monitor_results" },
  { key: "logSources", field: "log_sources" },
  { key: "groups", field: "groups" },
  { key: "approvals", field: "approvals" },
  { key: "tunnels", field: "tunnels" },
  { key: "terminalSessions", field: "terminal_sessions" },
  { key: "proxyDriftCleared", field: "proxy_drift_cleared" },
];

const deleteImpactRows = computed(() => {
  const plan = deletePlan.value;
  if (!plan) return [];
  return DELETE_COUNT_FIELDS.map((f) => ({
    key: f.key,
    label: t(`fleet.nodes.detail.deleteCounts.${f.key}`),
    count: Number(plan[f.field] ?? 0),
  })).filter((r) => r.count > 0);
});

/** Confirm is gated until the typed value exactly matches what the prompt asks
 *  for — the node name, or its id when the node has no name (matches the prompt
 *  copy, which falls back to id). */
const deleteNameMatches = computed(
  () =>
    !!node.value &&
    deleteNameInput.value.trim() === (node.value.name || node.value.id),
);

async function openDeleteDialog() {
  if (!node.value || !canAdminNodes.value) return;
  deleteNameInput.value = "";
  deletePlan.value = undefined;
  deleteOpen.value = true;
  deletePlanning.value = true;
  try {
    deletePlan.value = await api.nodes.deletePlan(node.value.id);
  } catch (error) {
    // The dialog still opens; the operator can confirm without the preview.
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.deletePlanFailed"));
  } finally {
    deletePlanning.value = false;
  }
}

async function deleteNode() {
  if (!node.value || !canAdminNodes.value || !deleteNameMatches.value) return;
  deletePending.value = true;
  try {
    await api.nodes.delete(node.value.id);
    toast.success(t("fleet.nodes.toast.nodeDeleted"));
    deleteOpen.value = false;
    goBack();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}

function onDeleteOpenChange(value: boolean) {
  if (deletePending.value) return;
  deleteOpen.value = value;
  if (!value) {
    deleteNameInput.value = "";
    deletePlan.value = undefined;
  }
}

async function setNodeDebug(enabled: boolean, collect?: boolean) {
  if (!node.value || !canAdminNodes.value) return;
  debugPending.value = true;
  try {
    await api.nodes.setDebug(node.value.id, enabled, collect);
    toast.success(t("fleet.nodes.toast.debugUpdated"));
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.debugFailed"));
  } finally {
    debugPending.value = false;
  }
}

// Per-node public-IP discovery override editor. "inherit" maps to the empty
// server mode (clear the override). The form seeds once per node id so a 5s
// poll never clobbers an in-progress edit.
const ipMode = ref<"inherit" | "auto" | "static" | "resolver" | "script">("inherit");
const ipStaticV4 = ref("");
const ipStaticV6 = ref("");
const ipResolvers = ref("");
const ipScript = ref("");
const ipConfigPending = ref(false);
const canSaveIPConfig = computed(() => {
  if (ipMode.value !== "script") return true;
  return !!ipScript.value.trim() || !!node.value?.ip_config?.script_sha256;
});

watch(
  () => node.value?.id,
  () => {
    const c = node.value?.ip_config;
    ipMode.value = c?.mode ? c.mode : "inherit";
    ipStaticV4.value = c?.static_ipv4 ?? "";
    ipStaticV6.value = c?.static_ipv6 ?? "";
    ipResolvers.value = (c?.resolvers ?? []).join("\n");
    ipScript.value = "";
  },
  { immediate: true },
);

async function saveIPConfig() {
  if (!node.value || !canAdminNodes.value) return;
  ipConfigPending.value = true;
  try {
    await api.nodes.ipConfig({
      node_id: node.value.id,
      mode: ipMode.value === "inherit" ? "" : ipMode.value,
      static_ipv4: ipStaticV4.value.trim(),
      static_ipv6: ipStaticV6.value.trim(),
      resolvers: ipResolvers.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      script: ipMode.value === "script" ? ipScript.value : undefined,
    });
    toast.success(t("fleet.nodes.detail.ipConfig.saved"));
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.ipConfig.saveFailed"));
  } finally {
    ipConfigPending.value = false;
  }
}

async function clearIPConfig() {
  ipMode.value = "inherit";
  await saveIPConfig();
}

async function planUpdate() {
  if (!node.value) return;
  planningUpdate.value = true;
  try {
    await api.agentUpdates.plan(node.value.id);
    toast.success(t("fleet.nodes.detail.updatePlanned"));
    await agentUpdatesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.updatePlanFailed"));
  } finally {
    planningUpdate.value = false;
  }
}

async function resolveGeo() {
  if (!node.value || !canAdminNodes.value) return;
  resolvingGeo.value = true;
  try {
    const res = await api.nodes.resolveGeo({ node_id: node.value.id, overwrite: true });
    const results = res.results ?? [];
    if (results.some((r) => r.status === "resolver_disabled")) {
      toast.error(t("fleet.map.toast.resolverDisabled"));
      return;
    }
    const updated = results.filter((r) => r.status === "updated").length;
    if (updated > 0) {
      toast.success(t("fleet.map.toast.resolved", { count: updated }));
      await nodesQuery.refresh();
      return;
    }
    if (results.some((r) => r.status === "no_public_ip")) {
      toast.error(t("fleet.map.toast.resolveNoPublicIp", { count: 1 }));
      return;
    }
    toast.info(t("fleet.map.toast.resolveNoop"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.resolveFailed"));
  } finally {
    resolvingGeo.value = false;
  }
}
</script>

<template>
  <!-- Resolved node: full page with a sticky header over a 2-column body. -->
  <div v-if="node">
    <div class="sticky top-0 z-20 border-b border-border bg-background/85 px-6 py-4 backdrop-blur">
      <PageHeader :title="node.name || node.id" :section="$t('nav.sections.fleet')">
        <template #status>
          <FreshnessLabel :last-updated="nodesQuery.lastUpdated.value" />
        </template>
        <template #actions>
          <Button variant="ghost" size="sm" @click="goBack">
            <ArrowLeft class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.backToNodes') }}
          </Button>
          <Button
            v-if="canOpenTerminal"
            size="sm"
            :disabled="!node.online || node.disabled"
            @click="openTerminal"
          >
            <SquareTerminal class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.list.openTerminal') }}
          </Button>
          <Button variant="outline" size="sm" :disabled="nodesQuery.refreshing.value" @click="refreshAll">
            <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
            {{ $t('common.actions.refresh') }}
          </Button>
        </template>
      </PageHeader>

      <!-- Identity row: live dot, status / role / tags / groups, last-seen. -->
      <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <StatusDot :status="meta.dotStatus" :pulse="isLive" />
        <Badge :variant="statusBadge.variant">{{ statusBadge.label }}</Badge>
        <Badge v-if="node.role" variant="secondary">{{ node.role }}</Badge>
        <Badge v-for="tag in node.tags ?? []" :key="tag" variant="outline">{{ tag }}</Badge>
        <button
          v-for="g in groupBadges"
          :key="g.id"
          type="button"
          :class="cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            groupColor(g.color).border,
            groupColor(g.color).soft,
            groupColor(g.color).text,
          )"
          @click="goToGroup(g.id)"
        >
          <span :class="cn('size-2 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
          {{ g.name }}
          <Crown v-if="g.leader" class="size-3 shrink-0" aria-hidden="true" />
        </button>
        <span class="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground tabular">
          {{ shortId(node.id, 20) }}
          <CopyButton :value="node.id" />
        </span>
        <span class="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground tabular">
          <Clock class="size-3.5" aria-hidden="true" />
          {{ $t('fleet.nodes.list.lastSeen', { time: formatRelativeTime(node.last_seen) }) }}
        </span>
      </div>
    </div>

    <div class="grid gap-6 p-6 lg:grid-cols-3">
      <!-- ── Main column ──────────────────────────────────────────── -->
      <div class="space-y-6 lg:col-span-2">
        <!-- Live status + metrics -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Activity class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.liveStatus') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.liveStatusDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-5">
            <div class="space-y-2.5">
              <MetricBar
                :label="$t('fleet.nodes.metric.cpu')"
                tone="cpu"
                :percent="node.metrics?.cpu_percent ?? 0"
                :value-text="formatPercent(node.metrics?.cpu_percent)"
              />
              <MetricBar
                :label="$t('fleet.nodes.metric.memory')"
                tone="memory"
                :percent="ratio(node.metrics?.memory_used, node.metrics?.memory_total)"
                :used="node.metrics?.memory_used"
                :total="node.metrics?.memory_total"
              />
              <MetricBar
                :label="$t('fleet.nodes.metric.disk')"
                tone="disk"
                :percent="ratio(node.metrics?.disk_used, node.metrics?.disk_total)"
                :used="node.metrics?.disk_used"
                :total="node.metrics?.disk_total"
              />
            </div>

            <!-- In-session CPU trend. -->
            <div>
              <p class="mb-1 text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.sparklineLabel') }}</p>
              <svg
                v-if="hasSpark"
                :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`"
                :style="{ height: SPARK_H + 'px' }"
                class="block w-full"
                preserveAspectRatio="none"
                role="img"
                :aria-label="$t('fleet.nodes.detail.sparklineLabel')"
              >
                <polyline
                  :points="sparkPoints"
                  fill="none"
                  :class="['stroke-current', meta.textClass]"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  vector-effect="non-scaling-stroke"
                />
              </svg>
              <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.sparklinePending') }}</p>
            </div>

            <!-- Secondary stats grid. -->
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.load') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <Gauge class="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {{ node.metrics?.load1?.toFixed(2) ?? '—' }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.uptime') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <Clock class="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {{ formatDuration(node.metrics?.uptime_seconds) }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.sampleTime') }}</p>
                <p class="mt-1 font-mono text-sm tabular">{{ formatRelativeTime(node.metrics?.collected_at) }}</p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.download') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <ArrowDown class="size-3.5 text-success" aria-hidden="true" />
                  {{ formatBytesPerSec(node.metrics?.net_rx_speed) }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.upload') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <ArrowUp class="size-3.5 text-primary" aria-hidden="true" />
                  {{ formatBytesPerSec(node.metrics?.net_tx_speed) }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.transferred') }}</p>
                <p class="mt-1 font-mono text-sm tabular">
                  <span class="text-success">{{ formatBytes(node.metrics?.net_rx_bytes) }}</span>
                  /
                  <span class="text-primary">{{ formatBytes(node.metrics?.net_tx_bytes) }}</span>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Network / IP -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Globe class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.network') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.networkDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.publicIp') }}</p>
                  <p class="mt-1 truncate font-mono text-sm">{{ node.public_ip || '—' }}</p>
                </div>
                <CopyButton v-if="node.public_ip" :value="node.public_ip" />
              </div>
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.publicIpv6') }}</p>
                  <p class="mt-1 truncate font-mono text-sm">{{ node.public_ipv6 || '—' }}</p>
                </div>
                <CopyButton v-if="node.public_ipv6" :value="node.public_ipv6" />
              </div>
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.internalIp') }}</p>
                  <p class="mt-1 truncate font-mono text-sm">{{ node.internal_ip || $t('fleet.nodes.detail.notSet') }}</p>
                </div>
                <CopyButton v-if="node.internal_ip" :value="node.internal_ip" />
              </div>
              <div v-if="node.internal_ipv6" class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.internalIpv6') }}</p>
                  <p class="mt-1 truncate font-mono text-sm">{{ node.internal_ipv6 }}</p>
                </div>
                <CopyButton :value="node.internal_ipv6" />
              </div>
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.wireguardIp') }}</p>
                  <p class="mt-1 truncate font-mono text-sm">{{ node.wireguard_ip || $t('fleet.nodes.detail.notSet') }}</p>
                </div>
                <CopyButton v-if="node.wireguard_ip" :value="node.wireguard_ip" />
              </div>
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.wireguardEndpoint') }}</p>
                  <p class="mt-1 truncate font-mono text-sm">{{ node.wireguard_endpoint || $t('fleet.nodes.detail.notSet') }}</p>
                </div>
                <CopyButton v-if="node.wireguard_endpoint" :value="node.wireguard_endpoint" />
              </div>
            </div>

            <!-- IP discovery override (operator-owned; pushed to the agent) -->
            <div v-if="canAdminNodes" class="space-y-3 rounded-md border border-border p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <Globe class="size-3.5" aria-hidden="true" />
                  {{ $t('fleet.nodes.detail.ipConfig.title') }}
                </p>
                <Badge :variant="node.ip_config?.mode ? 'outline' : 'secondary'">
                  {{ node.ip_config?.mode ? $t('fleet.nodes.detail.ipConfig.overrideActive') : $t('fleet.nodes.detail.ipConfig.inheriting') }}
                </Badge>
              </div>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.ipConfig.hint') }}</p>
              <div class="grid gap-1.5 sm:max-w-xs">
                <Label>{{ $t('fleet.nodes.detail.ipConfig.mode') }}</Label>
                <Select v-model="ipMode">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{{ $t('fleet.nodes.detail.ipConfig.modeInherit') }}</SelectItem>
                    <SelectItem value="auto">{{ $t('fleet.nodes.detail.ipConfig.modeAuto') }}</SelectItem>
                    <SelectItem value="static">{{ $t('fleet.nodes.detail.ipConfig.modeStatic') }}</SelectItem>
                    <SelectItem value="resolver">{{ $t('fleet.nodes.detail.ipConfig.modeResolver') }}</SelectItem>
                    <SelectItem value="script">{{ $t('fleet.nodes.detail.ipConfig.modeScript') }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-if="ipMode === 'static' || ipMode === 'auto'" class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label>{{ $t('fleet.nodes.detail.ipConfig.staticV4') }}</Label>
                  <Input v-model="ipStaticV4" placeholder="203.0.113.10" class="font-mono" />
                </div>
                <div class="grid gap-1.5">
                  <Label>{{ $t('fleet.nodes.detail.ipConfig.staticV6') }}</Label>
                  <Input v-model="ipStaticV6" placeholder="2001:db8::1" class="font-mono" />
                </div>
              </div>
              <div v-if="ipMode === 'resolver' || ipMode === 'auto'" class="grid gap-1.5">
                <Label>{{ $t('fleet.nodes.detail.ipConfig.resolvers') }}</Label>
                <textarea
                  v-model="ipResolvers"
                  rows="2"
                  class="rounded-md border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  placeholder="https://api.ipify.org&#10;https://ifconfig.co/ip"
                />
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.ipConfig.resolversHint') }}</p>
              </div>
              <div v-if="ipMode === 'script'" class="grid gap-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <Label>{{ $t('fleet.nodes.detail.ipConfig.script') }}</Label>
                  <Badge v-if="node.ip_config?.script_sha256" variant="outline" class="font-mono">
                    {{ node.ip_config.script_sha256 }}
                  </Badge>
                </div>
                <textarea
                  v-model="ipScript"
                  rows="5"
                  class="rounded-md border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  placeholder="curl -fsS https://api.ipify.org&#10;# optional: echo an IPv6 on another line"
                />
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.ipConfig.scriptHint') }}</p>
                <p v-if="node.ip_config?.script_sha256 && !ipScript.trim()" class="text-xs text-muted-foreground">
                  {{ $t('fleet.nodes.detail.ipConfig.scriptPreserveHint') }}
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" :disabled="ipConfigPending || !canSaveIPConfig" @click="saveIPConfig">
                  <RefreshCw v-if="ipConfigPending" class="size-3.5 animate-spin" aria-hidden="true" />
                  {{ $t('common.actions.save') }}
                </Button>
                <Button v-if="node.ip_config?.mode" variant="ghost" size="sm" :disabled="ipConfigPending" @click="clearIPConfig">
                  {{ $t('fleet.nodes.detail.ipConfig.clear') }}
                </Button>
              </div>
            </div>

            <!-- Geolocation -->
            <div class="rounded-md border border-border p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <MapPin class="size-3.5" aria-hidden="true" />
                  {{ $t('fleet.nodes.detail.geo') }}
                </p>
                <div class="flex items-center gap-2">
                  <Badge v-if="hasGeo" variant="outline">{{ geoSourceLabel(node.geo?.source) }}</Badge>
                  <Button
                    v-if="canAdminNodes"
                    variant="outline"
                    size="sm"
                    :disabled="resolvingGeo"
                    @click="resolveGeo"
                  >
                    <RefreshCw :class="cn('size-4', resolvingGeo && 'animate-spin')" aria-hidden="true" />
                    {{ $t('fleet.nodes.detail.resolveGeo') }}
                  </Button>
                </div>
              </div>
              <div v-if="hasGeo" class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoCountry') }}</p>
                  <p class="mt-0.5">{{ node.geo?.country || '—' }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoRegion') }}</p>
                  <p class="mt-0.5">{{ node.geo?.region || '—' }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoCity') }}</p>
                  <p class="mt-0.5">{{ node.geo?.city || '—' }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoAsn') }}</p>
                  <p class="mt-0.5 font-mono">{{ node.geo?.asn ?? '—' }}</p>
                </div>
                <div class="col-span-2">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoAsOrg') }}</p>
                  <p class="mt-0.5 truncate">{{ node.geo?.as_org || '—' }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoProvider') }}</p>
                  <p class="mt-0.5">{{ node.geo?.provider || '—' }}</p>
                </div>
                <div v-if="node.geo?.updated_at" class="col-span-2 sm:col-span-3">
                  <p class="text-xs text-muted-foreground">
                    {{ $t('fleet.nodes.detail.geoUpdated', { time: formatDateTime(node.geo.updated_at) }) }}
                  </p>
                </div>
              </div>
              <p v-else class="mt-2 text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.noGeo') }}</p>
            </div>
          </CardContent>
        </Card>

        <!-- Host facts -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Server class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.hostFacts') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.hostFactsDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl v-if="node.host_facts" class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factHostname') }}</dt>
                <dd class="mt-0.5 truncate font-mono text-sm">{{ node.host_facts.hostname || '—' }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factOs') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.os || '—' }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factPlatform') }}</dt>
                <dd class="mt-0.5 text-sm">
                  {{ [node.host_facts.platform, node.host_facts.platform_version].filter(Boolean).join(' ') || '—' }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factKernel') }}</dt>
                <dd class="mt-0.5 truncate font-mono text-sm">{{ node.host_facts.kernel || '—' }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factArch') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.arch || '—' }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factCpu') }}</dt>
                <dd class="mt-0.5 text-sm">
                  {{ node.host_facts.cpu_cores ? $t('fleet.nodes.detail.coresValue', { value: node.host_facts.cpu_cores }) : '—' }}
                </dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factCpuModel') }}</dt>
                <dd class="mt-0.5 truncate text-sm">{{ node.host_facts.cpu_model || '—' }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factMemory') }}</dt>
                <dd class="mt-0.5 font-mono text-sm">{{ formatBytes(node.host_facts.memory_total) }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factSwap') }}</dt>
                <dd class="mt-0.5 font-mono text-sm">{{ formatBytes(node.host_facts.swap_total) }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factVirtualization') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.virtualization || '—' }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factBootTime') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.boot_time ? formatDateTime(node.host_facts.boot_time) : '—' }}</dd>
              </div>
            </dl>
            <p v-else class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.noHostFacts') }}</p>
          </CardContent>
        </Card>
      </div>

      <!-- ── Side column ──────────────────────────────────────────── -->
      <div class="space-y-6">
        <!-- Group membership -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <FolderTree class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.groups') }}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <div v-if="groupBadges.length" class="flex flex-wrap gap-2">
              <button
                v-for="g in groupBadges"
                :key="g.id"
                type="button"
                :class="cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  groupColor(g.color).border,
                  groupColor(g.color).soft,
                  groupColor(g.color).text,
                )"
                @click="goToGroup(g.id)"
              >
                <span :class="cn('size-2 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
                {{ g.name }}
                <Crown v-if="g.leader" class="size-3 shrink-0" aria-hidden="true" />
              </button>
            </div>
            <p v-else class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.ungrouped') }}</p>

            <!-- Membership editor (group:admin): toggle this node in/out of groups. -->
            <div v-if="canAdminGroups && allGroups.length" class="space-y-2 border-t border-border pt-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.nodes.detail.manageGroups') }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.manageGroupsHint') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="g in allGroups"
                  :key="g.id"
                  type="button"
                  :disabled="membershipPending === g.id"
                  :aria-pressed="isExplicitMember(g)"
                  :class="cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors surface-interactive disabled:opacity-50',
                    isExplicitMember(g)
                      ? cn(groupColor(g.color).border, groupColor(g.color).soft, groupColor(g.color).text)
                      : 'border-border text-muted-foreground hover:bg-muted/40',
                  )"
                  @click="toggleGroupMembership(g)"
                >
                  <span :class="cn('size-2 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
                  {{ g.name }}
                  <Check v-if="isExplicitMember(g)" class="size-3 shrink-0" aria-hidden="true" />
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Agent & updates -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <DownloadCloud class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.agentUpdates') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.agentUpdatesDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.agentVersion') }}</span>
              <span class="font-mono">{{ node.agent_version || $t('fleet.nodes.detail.unknown') }}</span>
            </div>
            <template v-if="updatePolicy">
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.targetVersion') }}</span>
                <span class="font-mono">{{ updatePolicy.target_version || '—' }}</span>
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.lastApplied') }}</span>
                <span class="font-mono">{{ updatePolicy.last_applied_version || '—' }}</span>
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.lastPlanned') }}</span>
                <span class="tabular text-xs text-muted-foreground">{{ updatePolicy.last_planned_at ? formatRelativeTime(updatePolicy.last_planned_at) : '—' }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <Badge :variant="updatePolicy.enabled ? 'success' : 'secondary'">
                  {{ updatePolicy.enabled ? $t('fleet.nodes.detail.updatesEnabled') : $t('common.status.disabled') }}
                </Badge>
                <Badge v-if="updatePolicy.auto_plan" variant="info">{{ $t('fleet.nodes.detail.autoPlan') }}</Badge>
              </div>
              <p v-if="updatePolicy.last_error" class="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {{ updatePolicy.last_error }}
              </p>
              <Button
                v-if="canAdminNodes"
                variant="outline"
                size="sm"
                class="w-full"
                :disabled="planningUpdate"
                @click="planUpdate"
              >
                <RefreshCw :class="cn('size-4', planningUpdate && 'animate-spin')" aria-hidden="true" />
                {{ $t('fleet.nodes.detail.planUpdate') }}
              </Button>
            </template>
            <p v-else class="text-muted-foreground">{{ $t('fleet.nodes.detail.noUpdatePolicy') }}</p>
          </CardContent>
        </Card>

        <!-- DDNS bindings -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Globe class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.ddns') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.ddnsDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div
              v-for="d in nodeDdns"
              :key="d.id"
              class="rounded-md border border-border p-3"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium">{{ d.name }}</span>
                <Badge variant="secondary">{{ d.provider }}</Badge>
              </div>
              <p class="mt-1 truncate font-mono text-xs text-muted-foreground">
                {{ d.domains.join(', ') || '—' }}
              </p>
              <p v-if="d.last_run_at" class="mt-1 text-xs text-muted-foreground">
                {{ $t('fleet.nodes.detail.ddnsLastRun', { time: formatRelativeTime(d.last_run_at) }) }}
              </p>
            </div>
            <p v-if="nodeDdns.length === 0" class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.noDdns') }}</p>
          </CardContent>
        </Card>

        <!-- Recent audit-for-node -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <ScrollText class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.activity') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.activityDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="auditQuery.loading.value"
              :error="auditQuery.error.value"
              :has-data="auditQuery.data.value !== undefined"
              :is-empty="auditEvents.length === 0"
              :empty-description="$t('fleet.nodes.detail.noActivity')"
              :skeleton-rows="4"
              @retry="auditQuery.refresh"
            >
              <ul class="divide-y divide-border">
                <li v-for="ev in auditEvents" :key="ev.id" class="flex items-center gap-3 py-2">
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-mono text-xs tabular">{{ ev.action }}</p>
                    <p class="truncate text-xs text-muted-foreground">{{ ev.actor_id || ev.token_id || '—' }}</p>
                  </div>
                  <Badge :variant="decisionVariant(ev.decision)">{{ ev.decision }}</Badge>
                  <span class="shrink-0 text-xs text-muted-foreground tabular">{{ formatRelativeTime(ev.at) }}</span>
                </li>
              </ul>
            </DataState>
          </CardContent>
        </Card>
      </div>

      <!-- ── Admin & danger zone ──────────────────────────────────── -->
      <Card v-if="canAdminNodes" class="border-destructive/40 lg:col-span-3">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Power class="size-4 text-destructive" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.admin') }}
          </CardTitle>
          <CardDescription>{{ $t('fleet.nodes.detail.adminDesc') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-5">
          <div class="flex flex-wrap gap-2">
            <Button
              :variant="node.disabled ? 'outline' : 'destructive'"
              size="sm"
              :disabled="pending"
              @click="setDisabled(!node.disabled)"
            >
              <Power class="size-4" aria-hidden="true" />
              {{ node.disabled ? $t('common.actions.enable') : $t('common.actions.disable') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="pending" @click="rotateToken">
              <KeyRound class="size-4" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.rotateToken') }}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              class="ml-auto"
              :disabled="pending || deletePending"
              @click="openDeleteDialog"
            >
              <Trash2 class="size-4" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.deleteNode') }}
            </Button>
          </div>

          <!-- One-time token reveal (mirrors NodesView). -->
          <div v-if="rotatedToken" class="grid gap-3 rounded-md border border-warning/40 bg-warning/5 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="text-sm font-medium">{{ $t('fleet.nodes.rotated.tokenFor', { id: rotatedToken.node_id }) }}</p>
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.rotated.hint') }}</p>
              </div>
              <CopyButton :value="rotatedToken.token" :label="$t('fleet.nodes.rotated.copyToken')" />
            </div>
            <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">{{ rotatedToken.token }}</code>
          </div>

          <!-- Agent diagnostics / debug -->
          <div class="rounded-md border border-border p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="space-y-1">
                <h3 class="text-sm font-medium">{{ $t('fleet.nodes.detail.diagnostics') }}</h3>
                <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.debugDescription') }}</p>
              </div>
              <Badge :variant="node.agent_debug?.enabled ? 'warning' : 'secondary'">
                {{ node.agent_debug?.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
              </Badge>
            </div>
            <div class="mt-4 grid gap-3">
              <label class="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-primary"
                  :checked="!!node.agent_debug?.enabled"
                  :disabled="debugPending"
                  @change="setNodeDebug(($event.target as HTMLInputElement).checked, node.agent_debug?.collect ?? true)"
                />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('fleet.nodes.detail.debugEnabled') }}</span>
                  <span class="block text-muted-foreground">{{ $t('fleet.nodes.detail.debugLocalHint') }}</span>
                </span>
              </label>
              <label class="flex items-start gap-3 text-sm" :class="!node.agent_debug?.enabled && 'opacity-60'">
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-primary"
                  :checked="!!node.agent_debug?.collect"
                  :disabled="!node.agent_debug?.enabled || debugPending"
                  @change="setNodeDebug(true, ($event.target as HTMLInputElement).checked)"
                />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('fleet.nodes.detail.debugCollect') }}</span>
                  <span class="block text-muted-foreground">{{ $t('fleet.nodes.detail.debugCollectHint', { path: `agent-debug://${node.id}` }) }}</span>
                </span>
              </label>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Hard-delete confirm: previews the cascade impact, then gates the
         destructive confirm behind typing the node name. -->
    <Dialog :open="deleteOpen" @update:open="onDeleteOpenChange">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2 text-destructive">
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.deleteTitle') }}
          </DialogTitle>
          <DialogDescription>
            {{ $t('fleet.nodes.detail.deleteConfirm', { name: node.name || node.id }) }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <!-- Cascade impact preview. -->
          <div class="rounded-md border border-border bg-muted/20 p-3">
            <p v-if="deletePlanning" class="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />
              {{ $t('common.actions.refresh') }}…
            </p>
            <template v-else-if="deleteImpactRows.length">
              <p class="mb-2 text-xs font-medium uppercase text-muted-foreground">
                {{ $t('fleet.nodes.detail.deleteImpact') }}
              </p>
              <ul class="space-y-1 text-sm">
                <li
                  v-for="row in deleteImpactRows"
                  :key="row.key"
                  class="flex items-center justify-between gap-3"
                >
                  <span class="text-muted-foreground">{{ row.label }}</span>
                  <span class="font-mono tabular">{{ row.count }}</span>
                </li>
              </ul>
            </template>
            <p v-else class="text-sm text-muted-foreground">
              {{ $t('fleet.nodes.detail.deleteNoImpact') }}
            </p>
          </div>

          <!-- Type-the-name gate. -->
          <div class="grid gap-1.5">
            <Label for="delete-node-name">
              {{ $t('fleet.nodes.detail.deleteTypeNamePrompt', { name: node.name || node.id }) }}
            </Label>
            <Input
              id="delete-node-name"
              v-model="deleteNameInput"
              :disabled="deletePending"
              autocomplete="off"
              class="font-mono"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            :disabled="deletePending"
            @click="onDeleteOpenChange(false)"
          >
            {{ $t('common.actions.cancel') }}
          </Button>
          <Button
            type="button"
            variant="destructive"
            :disabled="deletePending || !deleteNameMatches"
            @click="deleteNode"
          >
            <RefreshCw v-if="deletePending" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ deletePending ? $t('fleet.nodes.detail.deleteRemoving') : $t('fleet.nodes.detail.deleteNode') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>

  <!-- Loading / error / not-found. -->
  <div v-else class="space-y-4 p-6">
    <Button variant="ghost" size="sm" @click="goBack">
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ $t('fleet.nodes.detail.backToNodes') }}
    </Button>
    <DataState
      :loading="nodesQuery.loading.value"
      :error="nodesQuery.error.value"
      :has-data="nodesQuery.data.value !== undefined"
      :is-empty="notFound"
      :empty-title="$t('fleet.nodes.detail.notFoundTitle')"
      :empty-description="$t('fleet.nodes.detail.notFoundDescription')"
      @retry="nodesQuery.refresh"
    >
      <template #empty>
        <EmptyState
          :icon="Server"
          :title="$t('fleet.nodes.detail.notFoundTitle')"
          :description="$t('fleet.nodes.detail.notFoundDescription')"
        >
          <Button size="sm" @click="goBack">
            <ArrowLeft class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.backToNodes') }}
          </Button>
        </EmptyState>
      </template>
    </DataState>
  </div>
</template>
