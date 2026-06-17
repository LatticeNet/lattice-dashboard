<script setup lang="ts">
import { computed } from "vue";
import {
  Activity,
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
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Proxy Usage"
      description="Traffic accounting from agent-reported usage snapshots (read-only)"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="usageQuery.refreshing.value"
          @click="usageQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', usageQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Tracked users" :value="totalUsers" :icon="Users" />
      <StatCard label="Total used" :value="formatBytes(totalUsedBytes)" :icon="Database" />
      <StatCard label="Active nodes" :value="activeNodes" :icon="Server" tone="success" />
      <StatCard label="Aggregate uptime" :value="formatDuration(aggregateUptimeSec)" :icon="Activity" />
    </div>

    <DataState
      :loading="usageQuery.loading.value"
      :error="usageQuery.error.value"
      :is-empty="isEmpty"
      empty-title="No usage reported"
      empty-description="Agents will report per-user byte counters after their next collection interval."
      @retry="usageQuery.refresh"
    >
      <div class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Per-node Snapshots</CardTitle>
            <CardDescription>Latest core uptime and reported bytes per node</CardDescription>
          </CardHeader>
          <CardContent>
            <div v-if="sortedSnapshots.length" class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th class="px-3 py-2 font-medium">Node</th>
                    <th class="px-3 py-2 font-medium">Reported at</th>
                    <th class="px-3 py-2 font-medium">Core uptime</th>
                    <th class="px-3 py-2 text-right font-medium">Bytes this snapshot</th>
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
            <p v-else class="text-sm text-muted-foreground">No node snapshots reported yet.</p>
          </CardContent>
        </Card>

        <Card v-if="topUsers.length">
          <CardHeader>
            <CardTitle>Top users by traffic</CardTitle>
            <CardDescription>Highest {{ topUsers.length }} consumers, relative to the heaviest user</CardDescription>
          </CardHeader>
          <CardContent>
            <ul class="space-y-3">
              <li v-for="user in topUsers" :key="user.id" class="space-y-1.5">
                <div class="flex items-baseline justify-between gap-3 text-sm">
                  <span class="min-w-0 truncate font-medium">{{ user.name || user.id }}</span>
                  <span class="shrink-0 font-mono tabular text-xs text-muted-foreground">
                    {{ formatBytes(user.used_bytes) }}
                  </span>
                </div>
                <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full rounded-full bg-primary/70"
                    :style="{ width: trafficBarPercent(user) + '%' }"
                  />
                </div>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Per-user Usage</CardTitle>
            <CardDescription>Sorted by bytes used, descending</CardDescription>
          </CardHeader>
          <CardContent>
            <div v-if="sortedUsers.length" class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th class="px-3 py-2 font-medium">Name</th>
                    <th class="px-3 py-2 font-medium">Status</th>
                    <th class="px-3 py-2 text-right font-medium">Used</th>
                    <th class="px-3 py-2 text-right font-medium">Limit</th>
                    <th class="px-3 py-2 font-medium">Quota</th>
                    <th class="px-3 py-2 font-medium">Last seen</th>
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
                      <Badge :variant="statusVariant(user.status)">{{ user.status }}</Badge>
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
                      {{ user.last_seen_at ? formatRelativeTime(user.last_seen_at) : "never" }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="text-sm text-muted-foreground">No user usage reported yet.</p>
          </CardContent>
        </Card>
      </div>
    </DataState>
  </div>
</template>
