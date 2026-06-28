<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CircleCheck,
  CircleX,
  Cpu,
  RefreshCw,
  Server,
} from "lucide-vue-next";
import {
  api,
  type SingBoxInventory,
  type SingBoxNode,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import StatCard from "@/components/common/StatCard.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const { t } = useI18n();

// Read-only adoption bridge: on-box sing-box inventories reported by agents
// started with -singbox-discover. Poll modestly — this is observational.
const discoveredQuery = useAsyncData(() => api.proxy.discovered(), { pollInterval: 10000 });

const inventories = computed<SingBoxInventory[]>(
  () => discoveredQuery.data.value?.inventories ?? [],
);
const isEmpty = computed(() => inventories.value.length === 0);

// Stable, machine-grouped ordering so cards don't reshuffle on every poll.
const sortedInventories = computed(() =>
  [...inventories.value].sort((a, b) => a.node_id.localeCompare(b.node_id)),
);

// ── KPI strip ───────────────────────────────────────────────────────────────
const machineCount = computed(() => inventories.value.length);
const totalNodes = computed(() =>
  inventories.value.reduce((sum, inv) => sum + (inv.nodes?.length ?? 0), 0),
);
const errorCount = computed(
  () => inventories.value.filter((inv) => !invOk(inv)).length,
);

function invOk(inv: SingBoxInventory): boolean {
  return (inv.status ?? "ok") === "ok" && !inv.error;
}

// Mask the credential-bearing share link: keep only the protocol scheme so the
// operator can recognise it, but never render the secret-bearing remainder.
function maskShareUrl(url?: string): string {
  if (!url) return "";
  const idx = url.indexOf("://");
  if (idx > 0) return `${url.slice(0, idx)}://••••••`;
  return "••••••";
}

// ── Per-inventory node table ──────────────────────────────────────────────────
const nodeColumns = computed<DataTableColumn<SingBoxNode>[]>(() => [
  { key: "name", label: t("proxy.discovered.colName"), sortable: true, searchable: true, value: (n) => n.name || "" },
  { key: "protocol", label: t("proxy.discovered.colProtocol"), sortable: true, value: (n) => n.protocol || "" },
  { key: "network", label: t("proxy.discovered.colNetwork"), sortable: true, value: (n) => n.network || "" },
  { key: "port", label: t("proxy.discovered.colPort"), align: "right", sortable: true, value: (n) => n.port || "" },
  { key: "sni", label: t("proxy.discovered.colSni"), searchable: true, value: (n) => n.sni || "" },
  { key: "link", label: t("proxy.discovered.colLink"), align: "right" },
]);

function nodeKey(node: SingBoxNode): string {
  return `${node.name}|${node.address ?? ""}|${node.port ?? ""}|${node.protocol ?? ""}`;
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.discovered.title')"
      :description="$t('proxy.discovered.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="discoveredQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="discoveredQuery.refreshing.value"
          @click="discoveredQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', discoveredQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3">
      <StatCard :label="$t('proxy.discovered.kpiMachines')" :value="machineCount" :icon="Server" />
      <StatCard :label="$t('proxy.discovered.kpiNodes')" :value="totalNodes" :icon="Boxes" tone="success" />
      <StatCard
        :label="$t('proxy.discovered.kpiErrors')"
        :value="errorCount"
        :icon="AlertTriangle"
        :tone="errorCount > 0 ? 'destructive' : undefined"
      />
    </div>

    <DataState
      :loading="discoveredQuery.loading.value"
      :error="discoveredQuery.error.value"
      :has-data="discoveredQuery.data.value !== undefined"
      :is-empty="isEmpty"
      :empty-title="$t('proxy.discovered.emptyTitle')"
      :empty-description="$t('proxy.discovered.emptyDescription')"
      @retry="discoveredQuery.refresh"
    >
      <div class="space-y-6">
        <Card v-for="inv in sortedInventories" :key="inv.node_id">
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <CardTitle class="flex items-center gap-2">
                  <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <RouterLink
                    :to="{ name: 'node-detail', params: { id: inv.node_id } }"
                    class="inline-flex min-w-0 items-center gap-1 truncate font-mono text-sm hover:text-primary hover:underline"
                    :title="$t('proxy.discovered.viewNode')"
                  >
                    <span class="truncate">{{ inv.node_id }}</span>
                    <ArrowUpRight class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  </RouterLink>
                </CardTitle>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span class="inline-flex items-center gap-1">
                    <Cpu class="size-3.5" aria-hidden="true" />
                    {{ inv.core_version
                      ? $t('proxy.discovered.coreVersion', { version: inv.core_version })
                      : $t('proxy.discovered.coreUnknown') }}
                  </span>
                  <span>
                    {{ $t('proxy.discovered.reportedAt') }}:
                    <span :title="formatDateTime(inv.at)">{{ formatRelativeTime(inv.at) }}</span>
                  </span>
                  <span>{{ $t('proxy.discovered.nodeCount', { count: inv.nodes?.length ?? 0 }, inv.nodes?.length ?? 0) }}</span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Badge v-if="invOk(inv)" variant="success" class="gap-1">
                  <CircleCheck class="size-3" aria-hidden="true" />
                  {{ $t('proxy.discovered.statusOk') }}
                </Badge>
                <Badge v-else variant="destructive" class="gap-1">
                  <CircleX class="size-3" aria-hidden="true" />
                  {{ $t('proxy.discovered.statusError') }}
                </Badge>
              </div>
            </div>

            <p
              v-if="inv.error"
              class="mt-2 break-words rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
            >
              {{ inv.error }}
            </p>
          </CardHeader>

          <CardContent>
            <DataTable
              :columns="nodeColumns"
              :rows="inv.nodes ?? []"
              :row-key="nodeKey"
              :page-size="0"
              :empty-title="$t('proxy.discovered.noNodes')"
              :showing-label="$t('proxy.table.showing')"
              :of-label="$t('proxy.table.of')"
              :page-of-label="$t('proxy.table.of')"
              :prev-label="$t('proxy.table.prevPage')"
              :next-label="$t('proxy.table.nextPage')"
            >
              <template #cell-name="{ row }">
                <span class="font-medium">{{ row.name || "—" }}</span>
              </template>
              <template #cell-protocol="{ row }">
                <Badge v-if="row.protocol" variant="outline">{{ row.protocol }}</Badge>
                <span v-else class="text-muted-foreground">—</span>
              </template>
              <template #cell-network="{ row }">
                <span class="font-mono text-xs text-muted-foreground">{{ row.network || "—" }}</span>
              </template>
              <template #cell-port="{ row }">
                <span class="font-mono text-xs tabular">{{ row.port || "—" }}</span>
              </template>
              <template #cell-sni="{ row }">
                <span class="font-mono text-xs text-muted-foreground">{{ row.sni || "—" }}</span>
              </template>
              <template #cell-link="{ row }">
                <div v-if="row.share_url" class="flex items-center justify-end gap-2">
                  <code
                    class="hidden max-w-[180px] truncate font-mono text-xs text-muted-foreground sm:inline"
                    :title="$t('proxy.discovered.linkHidden')"
                  >{{ maskShareUrl(row.share_url) }}</code>
                  <CopyButton :value="row.share_url" :label="$t('proxy.discovered.copyLink')" />
                </div>
                <span v-else class="text-xs text-muted-foreground">{{ $t('proxy.discovered.noLink') }}</span>
              </template>
            </DataTable>
          </CardContent>
        </Card>
      </div>
    </DataState>
  </div>
</template>
