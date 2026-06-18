<script setup lang="ts">
import { computed } from "vue";
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
import StatCard from "@/components/common/StatCard.vue";
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

function statusVariant(status: string): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "active":
      return "success";
    case "expired":
      return "warning";
    case "over_quota":
      return "destructive";
    case "disabled":
      return "secondary";
    default:
      return "secondary";
  }
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
  const pct = usagePercent(user) ?? 0;
  if (pct >= 100) return "bg-destructive";
  if (pct >= 80) return "bg-warning";
  return "bg-primary";
}

function topUserBarClass(user: ProxyUsageUserView): string {
  if (user.status === "over_quota") return "bg-destructive";
  if (user.status === "expired") return "bg-warning";
  if (user.status === "disabled") return "bg-muted-foreground";
  return "bg-primary";
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.usage.title')"
      :description="$t('proxy.usage.description')"
    >
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
            <div v-if="sortedSnapshots.length" class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('proxy.usage.colNode') }}</th>
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('proxy.usage.colReportedAt') }}</th>
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('proxy.usage.colCoreUptime') }}</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('proxy.usage.colBytesThisSnapshot') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="snap in sortedSnapshots"
                    :key="snap.node_id"
                    class="border-b border-border last:border-b-0 hover:bg-muted/40"
                  >
                    <td class="px-3 py-3">
                      <div class="min-w-0">
                        <p class="truncate font-medium">{{ snap.node_name || snap.node_id }}</p>
                        <p class="font-mono text-xs text-muted-foreground">{{ shortId(snap.node_id, 16) }}</p>
                      </div>
                    </td>
                    <td class="px-3 py-3 text-xs text-muted-foreground">{{ formatDateTime(snap.at) }}</td>
                    <td class="px-3 py-3">{{ formatDuration(snap.core_uptime_sec) }}</td>
                    <td class="px-3 py-3 text-right font-mono tabular text-xs">
                      {{ formatBytes(snapshotTotalBytes(snap)) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="text-sm text-muted-foreground">{{ $t('proxy.usage.noSnapshots') }}</p>
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
            <div v-if="sortedUsers.length" class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('proxy.usage.colName') }}</th>
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('proxy.usage.colStatus') }}</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('proxy.usage.colUsed') }}</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('proxy.usage.colLimit') }}</th>
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('proxy.usage.colQuota') }}</th>
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('proxy.usage.colLastSeen') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="user in sortedUsers"
                    :key="user.id"
                    class="border-b border-border last:border-b-0 hover:bg-muted/40"
                  >
                    <td class="px-3 py-3">
                      <div class="min-w-0">
                        <p class="truncate font-medium">{{ user.name || user.id }}</p>
                        <p class="font-mono text-xs text-muted-foreground">{{ shortId(user.id, 16) }}</p>
                      </div>
                    </td>
                    <td class="px-3 py-3">
                      <Badge :variant="statusVariant(user.status)">{{ $t('common.status.' + (user.status === 'over_quota' ? 'overQuota' : user.status)) }}</Badge>
                    </td>
                    <td class="px-3 py-3 text-right font-mono tabular text-xs">
                      {{ formatBytes(user.used_bytes) }}
                    </td>
                    <td class="px-3 py-3 text-right font-mono tabular text-xs">
                      {{ limitLabel(user.traffic_limit_bytes) }}
                    </td>
                    <td class="px-3 py-3">
                      <div class="flex min-w-[120px] items-center gap-2">
                        <Progress
                          v-if="usagePercent(user) !== undefined"
                          :model-value="usagePercent(user)"
                          :indicator-class="progressIndicatorClass(user)"
                          class="w-20"
                        />
                        <span class="text-xs tabular text-muted-foreground">{{ usagePercentLabel(user) }}</span>
                      </div>
                    </td>
                    <td class="px-3 py-3 text-xs text-muted-foreground">
                      {{ user.last_seen_at ? formatRelativeTime(user.last_seen_at) : $t('common.misc.never') }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="text-sm text-muted-foreground">{{ $t('proxy.usage.noUserUsage') }}</p>
          </CardContent>
        </Card>
      </div>
    </DataState>
  </div>
</template>
