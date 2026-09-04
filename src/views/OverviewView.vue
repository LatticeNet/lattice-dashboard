<script setup lang="ts">
import { computed, watch, type Ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CircleDashed,
  Cpu,
  Globe,
  HardDrive,
  MapPin,
  MemoryStick,
  Power,
  RotateCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-vue-next";
import { api, unwrap, isActionablePendingApproval } from "@/lib/api";
import type { Node, ApprovalCounts, ApprovalView, TaskView, AuditEvent } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMetricBuffer } from "@/composables/useMetricBuffer";
import { useAuthStore } from "@/stores/auth";
import { formatBytesPerSec, formatPercent, formatRelativeTime, ratio } from "@/lib/format";
import { fleetTotals } from "@/lib/fleet";
import { compareByAttention, countNodeStatuses, isReporting, needsAttention } from "@/lib/nodeStatus";
import { compareNodeIdentity } from "@/views/fleet/nodesTableModel";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import MetricStrip, { type Metric } from "@/components/common/MetricStrip.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import NodeCard from "@/components/common/NodeCard.vue";
import MetricBar from "@/components/common/MetricBar.vue";
import GettingStarted from "@/components/common/GettingStarted.vue";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Errors, including 403, flow into each section's DataState: a section the
// principal cannot read renders its no-access card instead of silently
// disappearing. Softening 403 to undefined here used to make forbidden and
// absent indistinguishable on the operator's most-viewed screen.
const fleet = useAsyncData<Node[] | undefined>(
  (signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")),
  { pollInterval: 5000 },
);

const AUDIT_PREVIEW = 6;
const APPROVALS_PREVIEW = 5;
/** Rows read for the preview: enough to survive stale rows being filtered out. */
const APPROVALS_PREVIEW_READ = 50;

// The KPI reads the status counts and no rows: the whole listing was 2.6 MB
// and 7.5 s on a fleet with a thousand applied approvals, and this tile said
// "unknown" until all of it had landed. The preview underneath needs rows, so
// it reads exactly the pending ones, without plan text.
const approvalCounts = useAsyncData<ApprovalCounts | undefined>(
  (signal) => api.approvals.counts(undefined, { signal }),
  { pollInterval: 10000 },
);
const approvals = useAsyncData<ApprovalView[] | undefined>(
  (signal) => api.approvals.list({ status: "pending", limit: APPROVALS_PREVIEW_READ }, { signal }).then((r) => unwrap(r, "approvals")),
  { pollInterval: 10000 },
);

const tasks = useAsyncData<TaskView[] | undefined>(
  (signal) => api.tasks.list({ signal }).then((r) => unwrap(r, "tasks")),
  { pollInterval: 10000 },
);

const audit = useAsyncData<AuditEvent[] | undefined>(
  (signal) => api.audit.query({ limit: AUDIT_PREVIEW }, { signal }).then((r) => r.events ?? []),
  { pollInterval: 15000 },
);

/**
 * KPI numbers must not report 0 when the truth is "could not read". They must
 * not report "none" either: an unread query is unknown, not empty.
 */
function statValue(query: { data: Ref<unknown> }, count: number): string | number {
  return query.data.value === undefined ? t("common.misc.unknown") : count;
}

const auth = useAuthStore();
const router = useRouter();
const { t, locale } = useI18n();

/** Overview is a launchpad: clicking a node opens its full detail page. */
function openNodeDetail(node: Node) {
  router.push({ name: "node-detail", params: { id: node.id } });
}

// Client-side metric ring: feed each poll so NodeCard sparklines have history.
const metricBuffer = useMetricBuffer();
watch(
  () => fleet.data.value,
  (list) => {
    for (const node of list ?? []) metricBuffer.record(node.id, node.metrics);
  },
  { immediate: true },
);

const nodes = computed<Node[]>(() => fleet.data.value ?? []);
/**
 * The six numbers this page prints, from one pass over one array. The KPI
 * band, the fleet health caption, the attention list and its "healthy" count
 * all read this, so they cannot disagree the way "32/33 reporting", "6 needs
 * attention" and "27 healthy" did when each was its own arithmetic.
 */
const statusCounts = computed(() => countNodeStatuses(nodes.value));
const canReadFleet = computed(() => auth.can("node:read"));

/** First-run state: no nodes enrolled yet and the fleet query has settled. */
const isEmptyFleet = computed(
  () =>
    canReadFleet.value &&
    !fleet.loading.value &&
    fleet.data.value !== undefined &&
    nodes.value.length === 0,
);

const pendingApprovals = computed(
  () => (approvals.data.value ?? []).filter(isActionablePendingApproval),
);
/** The server's pending count; the preview list is capped and cannot count. */
const pendingApprovalCount = computed(() => approvalCounts.data.value?.pending ?? 0);
const queuedTasks = computed(
  () => (tasks.data.value ?? []).filter((t) => t.status === "queued").length,
);

/** Fleet-wide aggregate for the health panel (CPU mean, mem/disk sums, BW). */
const totals = computed(() => fleetTotals(nodes.value));
/**
 * Exactly the set `fleetTotals` averages and sums over: reporting (online or
 * degraded) and carrying a metrics object. The health bars used to be
 * labelled with the plain online count, which overstates the contributing
 * set.
 */
const reportingNodes = computed(
  () => nodes.value.filter((n) => isReporting(n) && !!n.metrics).length,
);
const hasFleet = computed(() => nodes.value.length > 0);
const nodesWithRootExec = computed(() =>
  nodes.value.filter((node) => {
    const runtime = node.agent_runtime;
    return !!runtime?.allow_exec && !!runtime.allow_root_exec && !runtime.no_exec;
  }),
);
const nodesWithTerminal = computed(() =>
  nodes.value.filter((node) => {
    const runtime = node.agent_runtime;
    return !!runtime?.allow_terminal && !runtime.no_exec;
  }),
);
const nodesWithoutSourceAllowlist = computed(() =>
  nodes.value.filter((node) => (node.agent_source_allowlist ?? []).length === 0),
);
const nodesWithExec = computed(() =>
  nodes.value.filter((node) => {
    const runtime = node.agent_runtime;
    return !!runtime?.allow_exec && !runtime.no_exec;
  }),
);
const trustPostureRiskCount = computed(
  () =>
    nodesWithRootExec.value.length +
    nodesWithTerminal.value.length +
    nodesWithoutSourceAllowlist.value.length +
    (auth.principal?.totp_enabled ? 0 : 1),
);

/**
 * The fleet band: total and the five status words, one caliber. Each drills
 * through to the Nodes page pre-filtered on that word, so a count that is not
 * zero is one click from being actionable. A zero in an attention column is
 * the good outcome and stays uncoloured.
 */
const fleetMetrics = computed<Metric[]>(() => {
  const c = statusCounts.value;
  return [
    {
      key: "nodes",
      label: t("overview.kpi.nodes"),
      value: statValue(fleet, c.total),
      icon: Server,
      to: { name: "nodes" },
    },
    {
      key: "online",
      label: t("overview.kpi.online"),
      value: statValue(fleet, c.online),
      hint: c.attention === 0 && c.total > 0 ? t("overview.allOnline") : undefined,
      tone: "success",
      icon: Wifi,
      to: { name: "nodes", query: { status: "online" } },
    },
    {
      key: "degraded",
      label: t("overview.kpi.degraded"),
      value: statValue(fleet, c.degraded),
      tone: c.degraded > 0 ? "warning" : "default",
      icon: TriangleAlert,
      to: { name: "nodes", query: { status: "degraded" } },
    },
    {
      key: "offline",
      label: t("overview.kpi.offline"),
      value: statValue(fleet, c.offline),
      tone: c.offline > 0 ? "destructive" : "default",
      icon: WifiOff,
      to: { name: "nodes", query: { status: "offline" } },
    },
    {
      key: "never_reported",
      label: t("overview.kpi.neverReported"),
      value: statValue(fleet, c.never_reported),
      tone: c.never_reported > 0 ? "muted" : "default",
      icon: CircleDashed,
      to: { name: "nodes", query: { status: "never_reported" } },
    },
    {
      key: "disabled",
      label: t("overview.kpi.disabled"),
      value: statValue(fleet, c.disabled),
      tone: c.disabled > 0 ? "muted" : "default",
      icon: Power,
      to: { name: "nodes", query: { status: "disabled" } },
    },
  ];
});

/** The operator's own queue: what waits on a decision, what waits on a node. */
const kpiMetrics = computed<Metric[]>(() => [
  {
    key: "approvals",
    label: t("overview.kpi.approvals"),
    value: statValue(approvalCounts, pendingApprovalCount.value),
    tone: pendingApprovalCount.value > 0 ? "warning" : "default",
    icon: ShieldCheck,
    to: { name: "approvals" },
  },
  {
    key: "tasks",
    label: t("nav.items.tasks"),
    value: statValue(tasks, queuedTasks.value),
    icon: Terminal,
    to: { name: "tasks", query: { status: "queued" } },
  },
]);

/**
 * The fleet section on Overview shows what is wrong, not what exists.
 *
 * It used to render every enrolled node as a card, two per row, inside the
 * two-thirds column: a 33-node fleet meant seventeen rows of cards on a page
 * whose entire promise is "at a glance", and the healthy nodes - which is
 * almost all of them, almost always - pushed the pending approvals, the task
 * queue and the audit trail below the fold. The full inventory has a page, it
 * is one click away, and it is better at being an inventory than this is.
 *
 * "Needs attention" is anything that is not plainly healthy: down, degraded,
 * never finished enrolling, or switched off. Worst first, because the order an
 * operator wants is the order they would triage in.
 */
const attentionNodes = computed<Node[]>(() =>
  nodes.value.filter(needsAttention).sort((a, b) => compareByAttention(a, b) || compareNodeIdentity(a, b)),
);

/**
 * Cards shown before the section defers to the Nodes page. Eight is two full
 * rows: enough that a normal bad day is fully visible here, few enough that a
 * fleet-wide outage does not turn this page back into the card wall it was.
 */
const ATTENTION_LIMIT = 8;
const attentionShown = computed(() => attentionNodes.value.slice(0, ATTENTION_LIMIT));
const attentionOverflow = computed(() => attentionNodes.value.length - attentionShown.value.length);
/** The same number the Online tile prints: attention is everything but online. */
const healthyNodes = computed(() => statusCounts.value.online);

const auditEvents = computed(() => audit.data.value ?? []);

function decisionVariant(d: string): "success" | "destructive" | "secondary" {
  if (d === "allow") return "success";
  if (d === "deny") return "destructive";
  return "secondary";
}

function refreshAll() {
  fleet.refresh();
  approvalCounts.refresh();
  approvals.refresh();
  tasks.refresh();
  audit.refresh();
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('overview.title')" :description="$t('overview.description')">
      <template #status>
        <FreshnessLabel :last-updated="fleet.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="fleet.refreshing.value" @click="refreshAll">
          <RotateCw :class="cn('size-4', fleet.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- First-run onboarding: shown only when no nodes are enrolled yet. -->
    <GettingStarted
      v-if="isEmptyFleet"
      :node-count="0"
      :two-factor-enabled="auth.principal?.totp_enabled"
    />

    <template v-else>
    <!-- Fleet band: total and the five status words, one caliber, then the
         operator's own queue. See MetricStrip for why these are not cards. -->
    <MetricStrip :metrics="fleetMetrics" :columns="6" />
    <MetricStrip :metrics="kpiMetrics" :columns="2" />

    <!-- Fleet health: live aggregate resource + bandwidth roll-up across the
         fleet, so the operator sees overall pressure without scanning cards. -->
    <Card v-if="hasFleet || fleet.error.value">
      <CardContent class="p-4 sm:p-5">
        <DataState
          :loading="false"
          :error="fleet.error.value"
          :has-data="hasFleet"
          @retry="fleet.refresh"
        >
          <div class="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
            <div class="space-y-3">
              <div class="flex items-center gap-2 text-sm font-medium">
                <Activity class="size-4 text-muted-foreground" aria-hidden="true" />
                {{ $t('overview.fleetHealth') }}
                <span class="ml-auto text-xs font-normal text-muted-foreground">
                  {{ $t('overview.acrossLive', { count: reportingNodes }) }}
                </span>
              </div>
              <MetricBar
                :label="$t('overview.metric.cpu')"
                :icon="Cpu"
                tone="cpu"
                :percent="totals.cpuPercent"
                :value-text="formatPercent(totals.cpuPercent)"
              />
              <MetricBar
                :label="$t('overview.metric.memory')"
                :icon="MemoryStick"
                tone="memory"
                :percent="ratio(totals.memUsed, totals.memTotal)"
                :used="totals.memUsed"
                :total="totals.memTotal"
              />
              <MetricBar
                :label="$t('overview.metric.disk')"
                :icon="HardDrive"
                tone="disk"
                :percent="ratio(totals.diskUsed, totals.diskTotal)"
                :used="totals.diskUsed"
                :total="totals.diskTotal"
              />
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="rounded-lg border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('overview.summary.download') }}</p>
                <p class="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular">
                  <ArrowDown class="size-4 text-success" aria-hidden="true" />{{ formatBytesPerSec(totals.netRxSpeed) }}
                </p>
              </div>
              <div class="rounded-lg border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('overview.summary.upload') }}</p>
                <p class="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular">
                  <ArrowUp class="size-4 text-primary" aria-hidden="true" />{{ formatBytesPerSec(totals.netTxSpeed) }}
                </p>
              </div>
              <div class="rounded-lg border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('overview.summary.regions') }}</p>
                <p class="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular">
                  <Globe class="size-4 text-muted-foreground" aria-hidden="true" />{{ totals.regions }}
                </p>
                <p v-if="totals.geoMissing > 0" class="mt-0.5 text-[11px] text-muted-foreground">
                  {{ $t('overview.summary.unlocated', { count: totals.geoMissing }) }}
                </p>
              </div>
              <div class="rounded-lg border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('overview.summary.countries') }}</p>
                <p class="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular">
                  <MapPin class="size-4 text-muted-foreground" aria-hidden="true" />{{ totals.countries }}
                </p>
                <p v-if="totals.geoMissing > 0" class="mt-0.5 text-[11px] text-muted-foreground">
                  {{ $t('overview.summary.unlocated', { count: totals.geoMissing }) }}
                </p>
              </div>
            </div>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <Card v-if="hasFleet || fleet.error.value">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <ShieldAlert class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('overview.trustPosture.title') }}
          <Badge v-if="hasFleet" :variant="trustPostureRiskCount > 0 ? 'warning' : 'success'" class="ms-auto">
            {{ trustPostureRiskCount > 0 ? $t('overview.trustPosture.review') : $t('overview.trustPosture.clean') }}
          </Badge>
        </CardTitle>
        <CardDescription>{{ $t('overview.trustPosture.description') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="false"
          :error="fleet.error.value"
          :has-data="hasFleet"
          @retry="fleet.refresh"
        >
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <RouterLink
              :to="{ name: 'nodes' }"
              class="rounded-md border border-border p-3 transition-colors hover:bg-muted/40"
            >
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('overview.trustPosture.rootExec') }}</p>
              <p :class="cn('mt-2 text-2xl font-semibold tabular', nodesWithRootExec.length > 0 ? 'text-destructive' : 'text-foreground')">
                {{ nodesWithRootExec.length }}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">{{ $t('overview.trustPosture.execEnabled', { count: nodesWithExec.length }) }}</p>
            </RouterLink>
            <RouterLink
              :to="{ name: 'nodes' }"
              class="rounded-md border border-border p-3 transition-colors hover:bg-muted/40"
            >
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('overview.trustPosture.terminal') }}</p>
              <p :class="cn('mt-2 text-2xl font-semibold tabular', nodesWithTerminal.length > 0 ? 'text-warning' : 'text-foreground')">
                {{ nodesWithTerminal.length }}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">{{ $t('overview.trustPosture.terminalHint') }}</p>
            </RouterLink>
            <RouterLink
              :to="{ name: 'nodes' }"
              class="rounded-md border border-border p-3 transition-colors hover:bg-muted/40"
            >
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('overview.trustPosture.sourcePolicy') }}</p>
              <p :class="cn('mt-2 text-2xl font-semibold tabular', nodesWithoutSourceAllowlist.length > 0 ? 'text-warning' : 'text-foreground')">
                {{ nodesWithoutSourceAllowlist.length }}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">{{ $t('overview.trustPosture.sourcePolicyHint') }}</p>
            </RouterLink>
            <RouterLink
              :to="{ name: 'settings-security' }"
              class="rounded-md border border-border p-3 transition-colors hover:bg-muted/40"
            >
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('overview.trustPosture.accountMfa') }}</p>
              <p :class="cn('mt-2 text-2xl font-semibold tabular', auth.principal?.totp_enabled ? 'text-success' : 'text-warning')">
                {{ auth.principal?.totp_enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
              </p>
              <p class="mt-1 text-xs text-muted-foreground">{{ $t('overview.trustPosture.accountMfaHint') }}</p>
            </RouterLink>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <!-- Main grid -->
    <div class="grid gap-6 lg:grid-cols-3">
      <!-- Fleet -->
      <Card class="lg:col-span-2">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Server class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('overview.fleet') }}
            <RouterLink
              :to="{ name: 'nodes' }"
              class="ms-auto text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
            >
              {{ $t('common.actions.viewAll') }}
            </RouterLink>
          </CardTitle>
          <CardDescription>
            {{ $t('overview.fleetOnline', { online: statusCounts.online, total: statusCounts.total }) }}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="fleet.loading.value"
            :error="fleet.error.value"
            :has-data="fleet.data.value !== undefined"
            :is-empty="nodes.length === 0"
            :empty-title="$t('overview.noNodes')"
            :empty-description="$t('overview.noNodesDescription')"
            @retry="fleet.refresh"
          >
            <!-- Nothing wrong. Say so plainly and stop: an all-clear that
                 still prints the whole inventory is not an all-clear. -->
            <div
              v-if="attentionNodes.length === 0"
              class="flex items-center gap-3 rounded-lg border border-success/30 bg-success/5 px-4 py-3"
            >
              <ShieldCheck class="size-5 shrink-0 text-success" aria-hidden="true" />
              <div class="min-w-0">
                <p class="text-sm font-medium">{{ $t('overview.fleetAllHealthy') }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ $t('overview.fleetAllHealthyHint', { count: healthyNodes }) }}
                </p>
              </div>
            </div>

            <div v-else class="space-y-3">
              <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <ShieldAlert class="size-3.5 text-warning" aria-hidden="true" />
                <span class="uppercase tracking-wide">{{ $t('overview.fleetNeedsAttention') }}</span>
                <span class="tabular">{{ attentionNodes.length }}</span>
                <span class="h-px flex-1 bg-border"></span>
                <span class="tabular">{{ $t('overview.fleetHealthyCount', { count: healthyNodes }) }}</span>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <NodeCard
                  v-for="node in attentionShown"
                  :key="node.id"
                  :node="node"
                  compact
                  show-sparkline
                  sparkline-metric="cpu"
                  selectable
                  @select="openNodeDetail"
                  :cpu-label="t('overview.metric.cpu')"
                  :memory-label="t('overview.metric.memory')"
                  :disk-label="t('overview.metric.disk')"
                  :online-label="t('common.nodeStatus.online')"
                  :never-label="t('common.nodeStatus.neverReported')"
                  :offline-label="t('common.nodeStatus.offline')"
                  :degraded-label="t('common.nodeStatus.degraded')"
                  :disabled-label="t('common.nodeStatus.disabled')"
                  :sparkline-label="t('overview.sparklineLabel')"
                />
              </div>
              <RouterLink
                v-if="attentionOverflow > 0"
                :to="{ name: 'nodes', query: { status: 'offline' } }"
                class="inline-block text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {{ $t('overview.fleetMoreNeedAttention', { count: attentionOverflow }) }}
              </RouterLink>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <!-- Right column -->
      <div class="space-y-6">
        <!-- Approvals inbox -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <ShieldCheck class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('overview.approvalsInbox') }}
              <RouterLink
                :to="{ name: 'approvals' }"
                class="ms-auto text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
              >
                {{ $t('common.actions.viewAll') }}
              </RouterLink>
            </CardTitle>
            <CardDescription>{{ $t('overview.approvalsDescription') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="approvals.loading.value"
              :error="approvals.error.value"
              :has-data="approvals.data.value !== undefined"
              :is-empty="pendingApprovals.length === 0"
              :empty-title="$t('overview.noPendingApprovals')"
              :empty-description="$t('overview.everythingUpToDate')"
              :empty-tone="'positive'"
              @retry="approvals.refresh"
            >
              <ul class="divide-y divide-border">
                <li v-for="a in pendingApprovals.slice(0, APPROVALS_PREVIEW)" :key="a.id">
                  <RouterLink
                    :to="{ name: 'approvals' }"
                    class="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                  >
                    <StatusDot status="degraded" pulse />
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm" :title="a.plugin + ' · ' + a.action">
                        <span class="font-medium">{{ a.plugin }}</span>
                        <span class="text-muted-foreground"> · {{ a.action }}</span>
                      </p>
                      <p class="truncate font-mono text-xs text-muted-foreground tabular" :title="a.node_id">
                        {{ a.node_id }}
                      </p>
                    </div>
                    <span class="shrink-0 text-xs text-muted-foreground tabular">
                      {{ formatRelativeTime(a.created_at) }}
                    </span>
                  </RouterLink>
                </li>
              </ul>
              <RouterLink
                v-if="pendingApprovalCount > APPROVALS_PREVIEW"
                :to="{ name: 'approvals' }"
                class="mt-2 block rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {{ $t('operations.approvals.showingOfTotal', { shown: Math.min(APPROVALS_PREVIEW, pendingApprovals.length), total: pendingApprovalCount }) }}
              </RouterLink>
            </DataState>
          </CardContent>
        </Card>

        <!-- Recent activity -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Activity class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('overview.recentActivity') }}
              <RouterLink
                :to="{ name: 'audit' }"
                class="ms-auto text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
              >
                {{ $t('common.actions.viewAll') }}
              </RouterLink>
            </CardTitle>
            <CardDescription>{{ $t('overview.recentActivityDescription') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="audit.loading.value"
              :error="audit.error.value"
              :has-data="audit.data.value !== undefined"
              :is-empty="auditEvents.length === 0"
              :empty-title="$t('overview.noRecentActivity')"
              :empty-description="$t('overview.auditWillAppear')"
              @retry="audit.refresh"
            >
              <ul class="divide-y divide-border">
                <li v-for="ev in auditEvents" :key="ev.id">
                  <RouterLink
                    :to="{ name: 'audit' }"
                    class="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="truncate font-mono text-xs tabular" :title="ev.action">{{ ev.action }}</p>
                      <p v-if="ev.node_id" class="truncate font-mono text-xs text-muted-foreground tabular" :title="ev.node_id">
                        {{ ev.node_id }}
                      </p>
                    </div>
                    <Badge :variant="decisionVariant(ev.decision)">{{ ev.decision }}</Badge>
                    <span class="shrink-0 text-xs text-muted-foreground tabular">
                      {{ formatRelativeTime(ev.at) }}
                    </span>
                  </RouterLink>
                </li>
              </ul>
              <RouterLink
                :to="{ name: 'audit' }"
                class="mt-2 block rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {{ $t('operations.audit.olderEvents') }}
              </RouterLink>
            </DataState>
          </CardContent>
        </Card>
      </div>
    </div>
    </template>
  </div>
</template>
