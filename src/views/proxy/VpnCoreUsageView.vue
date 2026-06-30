<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, Database, RefreshCw, Server, Users } from "lucide-vue-next";
import { ApiError, api, type ProxyUsageResponse } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatBytes, formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import StatCard from "@/components/common/StatCard.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface UsageByUser {
  user_id: string;
  email?: string;
  used_bytes: number;
  quota_bytes?: number;
  status?: string;
  last_seen?: string;
}

interface UsageByNode {
  node_id: string;
  node_name?: string;
  used_bytes: number;
  user_count: number;
  at?: string;
}

interface UsageRow {
  node_id: string;
  node_name?: string;
  user_id: string;
  email?: string;
  line_hash_id?: string;
  bytes: number;
}

interface UsageCollector {
  node_id: string;
  node_name?: string;
  source?: string;
  status?: string;
  error?: string;
  checked_at?: string;
}

interface VpnCoreUsageResponse {
  by_user: UsageByUser[];
  by_node: UsageByNode[];
  rows: UsageRow[];
  collectors: UsageCollector[];
  per_line: boolean;
}

function adaptLegacyUsage(legacy: ProxyUsageResponse): VpnCoreUsageResponse {
  const byUser = (legacy.users ?? []).map((u) => ({
    user_id: u.id,
    email: u.name,
    used_bytes: u.used_bytes ?? 0,
    quota_bytes: u.traffic_limit_bytes,
    status: u.status,
    last_seen: u.last_seen_at,
  }));
  const rows: UsageRow[] = [];
  const byNode = (legacy.snapshots ?? []).map((snap) => {
    let used = 0;
    const seenUsers = new Set<string>();
    const represented = new Set<string>();
    const markUser = (userID: string) => {
      if (userID) seenUsers.add(userID);
    };
    for (const [lineHashID, byUser] of Object.entries(snap.line_user_bytes ?? {})) {
      for (const [userID, bytes] of Object.entries(byUser ?? {})) {
        used += bytes || 0;
        represented.add(userID);
        markUser(userID);
        rows.push({
          node_id: snap.node_id,
          node_name: snap.node_name,
          user_id: userID,
          line_hash_id: lineHashID,
          bytes: bytes || 0,
        });
      }
    }
    for (const [userID, bytes] of Object.entries(snap.user_bytes ?? {})) {
      if (represented.has(userID)) continue;
      used += bytes || 0;
      markUser(userID);
      rows.push({
        node_id: snap.node_id,
        node_name: snap.node_name,
        user_id: userID,
        bytes: bytes || 0,
      });
    }
    return {
      node_id: snap.node_id,
      node_name: snap.node_name,
      used_bytes: used,
      user_count: seenUsers.size,
      at: snap.at,
    };
  });
  return { by_user: byUser, by_node: byNode, rows, collectors: [], per_line: rows.some((row) => !!row.line_hash_id) };
}

async function loadUsage(): Promise<VpnCoreUsageResponse> {
  try {
    return await api.plugins.call<VpnCoreUsageResponse>(
      "latticenet.vpn-core",
      "latticenet.vpn-core/usage",
      "query",
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 400 && error.message.includes("plugin does not expose"))) {
      throw error;
    }
    return adaptLegacyUsage(await api.proxy.usage());
  }
}

const usageQuery = useAsyncData(loadUsage, { pollInterval: 15000 });

const byUser = computed(() => usageQuery.data.value?.by_user ?? []);
const byNode = computed(() => usageQuery.data.value?.by_node ?? []);
const rows = computed(() => usageQuery.data.value?.rows ?? []);
const collectors = computed(() => usageQuery.data.value?.collectors ?? []);
const isEmpty = computed(() => byUser.value.length === 0 && byNode.value.length === 0 && rows.value.length === 0);

const totalUsers = computed(() => byUser.value.length);
const totalUsedBytes = computed(() => byUser.value.reduce((sum, user) => sum + (user.used_bytes || 0), 0));
const reportingNodes = computed(() => byNode.value.length);
const collectorErrors = computed(() => collectors.value.filter((c) => c.status === "error").length);

const sortedUsers = computed(() => [...byUser.value].sort((a, b) => (b.used_bytes || 0) - (a.used_bytes || 0)));
const sortedNodes = computed(() => [...byNode.value].sort((a, b) => (b.used_bytes || 0) - (a.used_bytes || 0)));
const sortedRows = computed(() =>
  [...rows.value].sort((a, b) => {
    if (a.node_id !== b.node_id) return a.node_id.localeCompare(b.node_id);
    return (b.bytes || 0) - (a.bytes || 0);
  }),
);

function quotaLabel(user: UsageByUser): string {
  if (!user.quota_bytes || user.quota_bytes <= 0) return "∞";
  return formatBytes(user.quota_bytes);
}

function statusVariant(status?: string) {
  if (status === "error" || status === "over_quota") return "destructive" as const;
  if (status === "ok" || status === "active") return "success" as const;
  return "secondary" as const;
}

const { t } = useI18n();

const userColumns = computed<DataTableColumn<UsageByUser>[]>(() => [
  { key: "user", label: t("proxy.usage.colUser"), sortable: true, searchable: true, value: (u) => u.email || u.user_id },
  { key: "status", label: t("proxy.usage.colStatus"), sortable: true, value: (u) => u.status || "" },
  { key: "used", label: t("proxy.usage.colUsed"), align: "right", sortable: true, value: (u) => u.used_bytes || 0 },
  { key: "quota", label: t("proxy.usage.colQuota"), align: "right", sortable: true, value: (u) => u.quota_bytes || 0 },
  { key: "lastSeen", label: t("proxy.usage.colLastSeen"), sortable: true, value: (u) => u.last_seen || "" },
]);

const nodeColumns = computed<DataTableColumn<UsageByNode>[]>(() => [
  { key: "node", label: t("proxy.usage.colNode"), sortable: true, searchable: true, value: (n) => n.node_name || n.node_id },
  { key: "users", label: t("proxy.usage.colUsers"), align: "right", sortable: true, value: (n) => n.user_count || 0 },
  { key: "used", label: t("proxy.usage.colUsed"), align: "right", sortable: true, value: (n) => n.used_bytes || 0 },
  { key: "reported", label: t("proxy.usage.colReported"), sortable: true, value: (n) => n.at || "" },
]);

const rowColumns = computed<DataTableColumn<UsageRow>[]>(() => [
  { key: "node", label: t("proxy.usage.colNode"), sortable: true, searchable: true, value: (r) => r.node_name || r.node_id },
  { key: "user", label: t("proxy.usage.colUser"), sortable: true, searchable: true, value: (r) => r.email || r.user_id },
  { key: "line", label: t("proxy.usage.colLine"), sortable: true, value: (r) => r.line_hash_id || "" },
  { key: "bytes", label: t("proxy.usage.colBytes"), align: "right", sortable: true, value: (r) => r.bytes || 0 },
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
      <StatCard :label="$t('proxy.usage.kpiUsers')" :value="totalUsers" :icon="Users" />
      <StatCard :label="$t('proxy.usage.kpiTraffic')" :value="formatBytes(totalUsedBytes)" :icon="Database" />
      <StatCard :label="$t('proxy.usage.kpiNodes')" :value="reportingNodes" :icon="Server" tone="success" />
      <StatCard :label="$t('proxy.usage.kpiErrors')" :value="collectorErrors" :icon="Activity" :tone="collectorErrors ? 'destructive' : 'default'" />
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
      <div class="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{{ $t('proxy.usage.byNodeTitle') }}</CardTitle>
            <CardDescription>{{ $t('proxy.usage.byNodeDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              :columns="nodeColumns"
              :rows="sortedNodes"
              :row-key="(n) => n.node_id"
              :page-size="10"
              :empty-title="$t('proxy.usage.emptyNode')"
              showing-label="Showing"
              of-label="of"
              page-of-label="of"
              prev-label="Previous"
              next-label="Next"
            >
              <template #cell-node="{ row }">
                <div class="min-w-0">
                  <p class="truncate font-medium">{{ row.node_name || row.node_id }}</p>
                  <p class="font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 16) }}</p>
                </div>
              </template>
              <template #cell-used="{ row }">
                <span class="font-mono tabular text-xs">{{ formatBytes(row.used_bytes) }}</span>
              </template>
              <template #cell-reported="{ row }">
                <span class="text-xs text-muted-foreground">{{ row.at ? formatDateTime(row.at) : "—" }}</span>
              </template>
            </DataTable>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ $t('proxy.usage.byUserTitle') }}</CardTitle>
            <CardDescription>{{ $t('proxy.usage.byUserDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              :columns="userColumns"
              :rows="sortedUsers"
              :row-key="(u) => u.user_id"
              :page-size="10"
              searchable
              :search-placeholder="$t('proxy.usage.colUser')"
              :empty-title="$t('proxy.usage.emptyUser')"
              showing-label="Showing"
              of-label="of"
              page-of-label="of"
              prev-label="Previous"
              next-label="Next"
            >
              <template #cell-user="{ row }">
                <div class="min-w-0">
                  <p class="truncate font-medium">{{ row.email || row.user_id }}</p>
                  <p class="font-mono text-xs text-muted-foreground">{{ shortId(row.user_id, 16) }}</p>
                </div>
              </template>
              <template #cell-status="{ row }">
                <Badge :variant="statusVariant(row.status)">{{ row.status || $t('proxy.usage.statusUnknown') }}</Badge>
              </template>
              <template #cell-used="{ row }">
                <span class="font-mono tabular text-xs">{{ formatBytes(row.used_bytes) }}</span>
              </template>
              <template #cell-quota="{ row }">
                <span class="font-mono tabular text-xs">{{ quotaLabel(row) }}</span>
              </template>
              <template #cell-lastSeen="{ row }">
                <span class="text-xs text-muted-foreground">
                  {{ row.last_seen ? formatRelativeTime(row.last_seen) : "—" }}
                </span>
              </template>
            </DataTable>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{{ $t('proxy.usage.rowsTitle') }}</CardTitle>
          <CardDescription>{{ $t('proxy.usage.rowsDesc') }}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            :columns="rowColumns"
            :rows="sortedRows"
            :row-key="(r) => `${r.node_id}:${r.user_id}:${r.line_hash_id || 'aggregate'}`"
            :page-size="15"
            searchable
            :search-placeholder="$t('proxy.usage.searchNodeUser')"
            :empty-title="$t('proxy.usage.emptyRows')"
            showing-label="Showing"
            of-label="of"
            page-of-label="of"
            prev-label="Previous"
            next-label="Next"
          >
            <template #cell-node="{ row }">
              <span>{{ row.node_name || shortId(row.node_id, 16) }}</span>
            </template>
            <template #cell-user="{ row }">
              <span>{{ row.email || shortId(row.user_id, 16) }}</span>
            </template>
            <template #cell-line="{ row }">
              <code class="font-mono text-xs text-muted-foreground">{{ row.line_hash_id || "aggregate" }}</code>
            </template>
            <template #cell-bytes="{ row }">
              <span class="font-mono tabular text-xs">{{ formatBytes(row.bytes) }}</span>
            </template>
          </DataTable>
        </CardContent>
      </Card>
    </DataState>
  </div>
</template>
