<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Activity,
  ArrowUpRight,
  Database,
  RefreshCw,
  Server,
  Users,
} from "lucide-vue-next";
import {
  api,
  type ProxyUsageSnapshotView,
  type ProxyUsageUserView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  shortId,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import StatCard from "@/components/common/StatCard.vue";
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
import { Progress } from "@/components/ui/progress";
import { lifecycleStatusMeta, quotaStatusMeta } from "@/lib/status";

const { t } = useI18n();

// Usage data is read-only accounting; poll modestly.
const usageQuery = useAsyncData(() => api.proxy.usage(), { pollInterval: 15000 });

const snapshots = computed<ProxyUsageSnapshotView[]>(
  () => usageQuery.data.value?.snapshots ?? [],
);
const users = computed<ProxyUsageUserView[]>(() => usageQuery.data.value?.users ?? []);
const isEmpty = computed(() => snapshots.value.length === 0 && users.value.length === 0);

// ── KPI strip ─────────────────────────────────────────────────────────────────
const totalUsers = computed(() => users.value.length);
const totalUsedBytes = computed(() =>
  users.value.reduce((sum, user) => sum + (user.used_bytes || 0), 0),
);
const activeNodes = computed(() => snapshots.value.length);
const aggregateUptimeSec = computed(() =>
  snapshots.value.reduce((sum, snap) => sum + (snap.core_uptime_sec || 0), 0),
);

// ── Snapshots ────────────────────────────────────────────────────────────────
function snapshotTotalBytes(snap: ProxyUsageSnapshotView): number {
  return Object.values(snap.user_bytes ?? {}).reduce((sum, value) => sum + (value || 0), 0);
}

const sortedSnapshots = computed(() =>
  [...snapshots.value].sort((a, b) =>
    (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id),
  ),
);

// ── Users ────────────────────────────────────────────────────────────────────
const sortedUsers = computed(() =>
  [...users.value].sort((a, b) => (b.used_bytes || 0) - (a.used_bytes || 0)),
);

// Top users by traffic — a compact horizontal bar list. Bar width is the share
// of the heaviest user's bytes (so the leader fills the track).
const topUsers = computed(() => sortedUsers.value.slice(0, 8));
const topUsersMaxBytes = computed(() =>
  topUsers.value.reduce((max, user) => Math.max(max, user.used_bytes || 0), 0),
);

function trafficBarPercent(user: ProxyUsageUserView): number {
  const max = topUsersMaxBytes.value;
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, ((user.used_bytes || 0) / max) * 100));
}

function trafficSharePercent(user: ProxyUsageUserView): number {
  const total = totalUsedBytes.value;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, ((user.used_bytes || 0) / total) * 100));
}

const topUserShare = computed(() => (topUsers.value[0] ? trafficSharePercent(topUsers.value[0]) : 0));

function statusVariant(status: string) {
  // over_quota maps to destructive here (heaviest-consumer context); others via status.ts.
  if (status === "over_quota") return "destructive" as const;
  return lifecycleStatusMeta(status).badgeVariant;
}

function limitLabel(limit?: number): string {
  if (!limit || limit <= 0) return "∞";
  return formatBytes(limit);
}

function usagePercent(user: ProxyUsageUserView): number | undefined {
  if (!user.traffic_limit_bytes || user.traffic_limit_bytes <= 0) return undefined;
  return Math.min(100, Math.max(0, (user.used_bytes / user.traffic_limit_bytes) * 100));
}

function usagePercentLabel(user: ProxyUsageUserView): string {
  const pct = usagePercent(user);
  return pct === undefined ? "—" : formatPercent(pct, pct >= 99.95 ? 0 : 1);
}

function progressIndicatorClass(user: ProxyUsageUserView): string {
  const limit = user.traffic_limit_bytes ?? 0;
  if (limit <= 0) return "bg-primary";
  const meta = quotaStatusMeta((user.used_bytes || 0) / limit);
  // quotaStatusMeta returns text-* classes; map to the bg- fill token.
  if (meta.textClass === "text-destructive") return "bg-destructive";
  if (meta.textClass === "text-warning") return "bg-warning";
  return "bg-primary";
}

function topUserBarClass(user: ProxyUsageUserView): string {
  if (user.status === "over_quota") return "bg-destructive";
  if (user.status === "expired") return "bg-warning";
  if (user.status === "disabled") return "bg-muted-foreground";
  return "bg-primary";
}

// ── DataTable column definitions ───────────────────────────────────────────────
const snapshotColumns = computed<DataTableColumn<ProxyUsageSnapshotView>[]>(() => [
  { key: "node", label: t("proxy.usage.colNode"), sortable: true, searchable: true, value: (s) => s.node_name || s.node_id },
  { key: "reportedAt", label: t("proxy.usage.colReportedAt"), sortable: true, value: (s) => s.at },
  { key: "coreUptime", label: t("proxy.usage.colCoreUptime"), sortable: true, value: (s) => s.core_uptime_sec || 0 },
  { key: "bytes", label: t("proxy.usage.colBytesThisSnapshot"), align: "right", sortable: true, value: (s) => snapshotTotalBytes(s) },
]);

const userColumns = computed<DataTableColumn<ProxyUsageUserView>[]>(() => [
  { key: "name", label: t("proxy.usage.colName"), sortable: true, searchable: true, value: (u) => u.name || u.id },
  { key: "status", label: t("proxy.usage.colStatus"), sortable: true, value: (u) => u.status },
  { key: "used", label: t("proxy.usage.colUsed"), align: "right", sortable: true, value: (u) => u.used_bytes || 0 },
  { key: "limit", label: t("proxy.usage.colLimit"), align: "right", sortable: true, value: (u) => u.traffic_limit_bytes || 0 },
  { key: "quota", label: t("proxy.usage.colQuota"), sortable: true, value: (u) => usagePercent(u) ?? -1 },
  { key: "lastSeen", label: t("proxy.usage.colLastSeen"), sortable: true, value: (u) => u.last_seen_at || "" },
]);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.usage.title')"
      :description="$t('proxy.usage.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="usageQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="usageQuery.refreshing.value"
          @click="usageQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', usageQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('proxy.usage.kpiTrackedUsers')" :value="totalUsers" :icon="Users" />
      <StatCard :label="$t('proxy.usage.kpiTotalUsed')" :value="formatBytes(totalUsedBytes)" :icon="Database" />
      <StatCard :label="$t('proxy.usage.kpiActiveNodes')" :value="activeNodes" :icon="Server" tone="success" />
      <StatCard :label="$t('proxy.usage.kpiAggregateUptime')" :value="formatDuration(aggregateUptimeSec)" :icon="Activity" />
    </div>

    <DataState
      :loading="usageQuery.loading.value"
      :error="usageQuery.error.value"
      :has-data="usageQuery.data.value !== undefined"
      :is-empty="isEmpty"
      :empty-title="$t('proxy.usage.emptyTitle')"
      :empty-description="$t('proxy.usage.emptyDescription')"
      @retry="usageQuery.refresh"
    >
      <div class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{{ $t('proxy.usage.snapshotsTitle') }}</CardTitle>
            <CardDescription>{{ $t('proxy.usage.snapshotsDescription') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              :columns="snapshotColumns"
              :rows="sortedSnapshots"
              :row-key="(s) => s.node_id"
              :page-size="10"
              :empty-title="$t('proxy.usage.noSnapshots')"
              :showing-label="$t('proxy.table.showing')"
              :of-label="$t('proxy.table.of')"
              :page-of-label="$t('proxy.table.of')"
              :prev-label="$t('proxy.table.prevPage')"
              :next-label="$t('proxy.table.nextPage')"
            >
              <template #cell-node="{ row }">
                <div class="min-w-0">
                  <p class="truncate font-medium">{{ row.node_name || row.node_id }}</p>
                  <p class="font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 16) }}</p>
                </div>
              </template>
              <template #cell-reportedAt="{ row }">
                <span class="text-xs text-muted-foreground">{{ formatDateTime(row.at) }}</span>
              </template>
              <template #cell-coreUptime="{ row }">
                {{ formatDuration(row.core_uptime_sec) }}
              </template>
              <template #cell-bytes="{ row }">
                <span class="font-mono tabular text-xs">{{ formatBytes(snapshotTotalBytes(row)) }}</span>
              </template>
            </DataTable>
          </CardContent>
        </Card>

        <Card v-if="topUsers.length" class="overflow-hidden">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <ArrowUpRight class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('proxy.usage.topUsersTitle') }}
            </CardTitle>
            <CardDescription>{{ $t('proxy.usage.topUsersDescription', { count: topUsers.length }) }}</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
              <ol class="space-y-2">
                <li
                  v-for="(user, index) in topUsers"
                  :key="user.id"
                  class="rounded-md border border-border bg-background/60 p-3"
                >
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="flex min-w-0 items-start gap-3">
                      <span class="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs text-muted-foreground">
                        {{ index + 1 }}
                      </span>
                      <div class="min-w-0">
                        <p class="truncate font-medium">{{ user.name || user.id }}</p>
                        <p class="truncate font-mono text-xs text-muted-foreground">{{ shortId(user.id, 16) }}</p>
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Badge :variant="statusVariant(user.status)">
                        {{ $t('common.status.' + (user.status === 'over_quota' ? 'overQuota' : user.status)) }}
                      </Badge>
                      <span class="font-mono text-sm tabular">{{ formatBytes(user.used_bytes) }}</span>
                    </div>
                  </div>

                  <div class="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      :class="cn('h-full rounded-full', topUserBarClass(user))"
                      :style="{ width: trafficBarPercent(user) + '%' }"
                    />
                  </div>
                  <div class="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                    <span>{{ $t('proxy.usage.globalShare', { percent: formatPercent(trafficSharePercent(user), 1) }) }}</span>
                    <span>{{ formatBytes(user.used_bytes) }} / {{ limitLabel(user.traffic_limit_bytes) }}</span>
                    <span>{{ user.last_seen_at ? formatRelativeTime(user.last_seen_at) : $t('common.misc.never') }}</span>
                  </div>
                </li>
              </ol>

              <div class="rounded-md border border-border bg-muted/25 p-4">
                <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('proxy.usage.globalOverview') }}</p>
                <p class="mt-3 text-3xl font-semibold tabular">{{ formatBytes(totalUsedBytes) }}</p>
                <p class="mt-1 text-sm text-muted-foreground">{{ $t('proxy.usage.totalAcrossUsers', { count: totalUsers }) }}</p>
                <div class="mt-5 space-y-3">
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <span class="text-muted-foreground">{{ $t('proxy.usage.leaderShare') }}</span>
                    <span class="font-mono tabular">{{ formatPercent(topUserShare, 1) }}</span>
                  </div>
                  <div class="h-2 w-full overflow-hidden rounded-full bg-background">
                    <div class="h-full rounded-full bg-primary" :style="{ width: topUserShare + '%' }" />
                  </div>
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <span class="text-muted-foreground">{{ $t('proxy.usage.reportingNodes') }}</span>
                    <span class="font-mono tabular">{{ activeNodes }}</span>
                  </div>
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <span class="text-muted-foreground">{{ $t('proxy.usage.trackedUsers') }}</span>
                    <span class="font-mono tabular">{{ totalUsers }}</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ $t('proxy.usage.perUserTitle') }}</CardTitle>
            <CardDescription>{{ $t('proxy.usage.perUserDescription') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              :columns="userColumns"
              :rows="sortedUsers"
              :row-key="(u) => u.id"
              :page-size="15"
              searchable
              :search-placeholder="$t('proxy.usage.colName')"
              :empty-title="$t('proxy.usage.noUserUsage')"
              :no-match-title="$t('proxy.table.noMatchTitle')"
              :no-match-description="$t('proxy.table.noMatchDescription')"
              :showing-label="$t('proxy.table.showing')"
              :of-label="$t('proxy.table.of')"
              :page-of-label="$t('proxy.table.of')"
              :prev-label="$t('proxy.table.prevPage')"
              :next-label="$t('proxy.table.nextPage')"
              :clear-search-label="$t('proxy.table.clearSearch')"
            >
              <template #cell-name="{ row }">
                <div class="min-w-0">
                  <p class="truncate font-medium">{{ row.name || row.id }}</p>
                  <p class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</p>
                </div>
              </template>
              <template #cell-status="{ row }">
                <Badge :variant="statusVariant(row.status)">{{ $t('common.status.' + (row.status === 'over_quota' ? 'overQuota' : row.status)) }}</Badge>
              </template>
              <template #cell-used="{ row }">
                <span class="font-mono tabular text-xs">{{ formatBytes(row.used_bytes) }}</span>
              </template>
              <template #cell-limit="{ row }">
                <span class="font-mono tabular text-xs">{{ limitLabel(row.traffic_limit_bytes) }}</span>
              </template>
              <template #cell-quota="{ row }">
                <div class="flex min-w-[120px] items-center justify-end gap-2 md:justify-start">
                  <Progress
                    v-if="usagePercent(row) !== undefined"
                    :model-value="usagePercent(row)"
                    :indicator-class="progressIndicatorClass(row)"
                    class="w-20"
                  />
                  <span class="text-xs tabular text-muted-foreground">{{ usagePercentLabel(row) }}</span>
                </div>
              </template>
              <template #cell-lastSeen="{ row }">
                <span class="text-xs text-muted-foreground">
                  {{ row.last_seen_at ? formatRelativeTime(row.last_seen_at) : $t('common.misc.never') }}
                </span>
              </template>
            </DataTable>
          </CardContent>
        </Card>
      </div>
    </DataState>
  </div>
</template>
